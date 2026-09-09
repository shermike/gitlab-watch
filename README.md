# GitLab Inbox

A Chrome/Edge extension that keeps one GitLab.com account's review workload on the toolbar:
a badge with the number of pending to-dos, and a popup with three read-only lists — pending
to-dos, merge requests awaiting your review, and your own open merge requests.

Design: [`docs/2026-09-09-gitlab-inbox-design.md`](docs/2026-09-09-gitlab-inbox-design.md).

Loaded unpacked; not published to any store.

## One-time setup

1. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select
   this directory.
2. Confirm the extension ID Chrome shows matches the one pinned by the `key` field in
   `manifest.json`:

   `bffggehapkcgnaflmebplikopjpocjop`

3. Create a user-owned OAuth application at
   <https://gitlab.com/-/user_settings/applications>:
   - **Name:** GitLab Inbox
   - **Redirect URI:** `https://bffggehapkcgnaflmebplikopjpocjop.chromiumapp.org/`
   - **Confidential:** unchecked — a browser extension cannot keep a secret
   - **Scopes:** `read_api` only
4. Copy the Application ID into `CLIENT_ID` in `src/config.js`. The placeholder value committed
   there is deliberate, not an oversight — it is the one value in this repository only the
   operator can supply, and this step is where it gets filled in.
5. Reload the extension, open the popup, sign in.
6. Repeat steps 1-2 in Edge (`edge://extensions`). The same Application ID and redirect URI
   apply, because the `key` field pins the same ID in both browsers.

## Tests

```
npm test
```

Runs `node --test test/**/*.test.js` with no dependencies. The glob is spelled out because the
bare directory form, `node --test test/`, fails on Node 24 with `MODULE_NOT_FOUND` — it resolves
`test/` as a module entry point rather than a test path. It covers the pure modules only — PKCE,
URL building, response mapping, formatting. Everything browser-dependent is covered by the
manual checklist.

## Regenerating the icons

`icons/icon.svg` is the source. To re-export the PNGs with headless Chrome:

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
ROOT="$(pwd -W 2>/dev/null || pwd)"
for size in 16 32 48 128; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --window-size=$size,$size \
    --screenshot="$ROOT/icons/$size.png" "file:///$ROOT/icons/icon.svg"
done
```

## How it works

```
              chrome.alarms (60 s)
                      |
                      v
   +--------------------------------------+
   |  service worker  (src/background.js) |
   |  - refreshes the token when stale    |
   |  - issues 3 GitLab API requests      |
   |  - writes a snapshot to storage      |
   |  - sets the toolbar badge            |
   +--------------------------------------+
                      |
             chrome.storage.local
                      |
                      v
   +--------------------------------------+
   |  popup  (src/popup/popup.js)         |
   |  - reads the snapshot, renders tabs  |
   |  - asks the worker to refresh        |
   |  - opens web_url in a new tab        |
   +--------------------------------------+
```

The service worker is ephemeral: the browser terminates it after roughly 30 seconds of
inactivity and revives it when an alarm fires or the popup sends a message. No state lives in
worker module scope except the in-flight refresh promise.

`src/pkce.js`, `src/gitlab.js` and `src/format.js` never reference `chrome.*`. That is what
lets `node --test` load them unmodified, and it is worth preserving.

## Manual checklist

`npm test` covers the pure modules. Everything below is browser-dependent and has to be walked
through **in both Chrome and Edge** before a version is done. Record the date and the browser
versions alongside the result.

Setup

- [ ] The extension loads unpacked with no errors on the extension card.
- [ ] The extension ID equals the one pinned by `manifest.json`'s `key`, and it is the same ID
      in both browsers.
- [ ] `chrome.identity.getRedirectURL()` in the service worker console equals the redirect URI
      registered on GitLab.

Sign-in

- [ ] The popup on a fresh profile shows only the "Sign in with GitLab" button.
- [ ] Signing in opens GitLab's authorization page, and it asks for `read_api` — nothing more.
- [ ] Authorizing closes the window and the badge appears within a couple of seconds.
- [ ] Cancelling the authorization window instead leaves the popup on the sign-in screen with
      an explanatory strip, and stores no token.

Lists

- [ ] The to-do count on the badge equals the number in GitLab's own header.
- [ ] The To-dos tab matches <https://gitlab.com/dashboard/todos>, item for item.
- [ ] The Review tab matches GitLab's "Merge requests ▸ Review requests", newest update first.
- [ ] The Mine tab matches the open merge requests you authored, newest update first.
- [ ] A to-do whose target is a commit comment (no MR, no issue) still renders readable text
      and opens the right page.
- [ ] A draft MR carries a Draft chip and its title has no "Draft:" prefix.
- [ ] Clicking a row opens the target in a new tab and closes the popup.

State and persistence

- [ ] Switching tab, closing and reopening the popup lands on the same tab.
- [ ] An empty list shows its per-tab message, not a blank panel.
- [ ] Clearing `inbox` in storage makes the popup show the skeleton.
- [ ] Going offline keeps the last snapshot visible with the "GitLab is unreachable" strip, and
      the badge keeps its count.
- [ ] Coming back online clears the strip on the next alarm, within about a minute.

Session

- [ ] Forcing `expiresAt` to now makes the next call refresh, and the stored `refreshToken`
      changes — GitLab rotates it.
- [ ] Corrupting `refreshToken` makes the next poll clear `auth`, set `inbox.error.kind` to
      `auth`, show `!` on the badge, and send the popup back to the sign-in screen — while the
      previously fetched lists stay in storage.
- [ ] Signing in again from that state restores the count.
- [ ] Sign-out clears `auth`, `me` and `inbox`, and removes the badge.

Polling

- [ ] With the popup shut, the badge tracks a to-do marked done in GitLab within about a minute.
- [ ] Pressing refresh twice inside 30 seconds issues API requests only once.
- [ ] Restarting the browser repopulates the snapshot without a manual refresh.

Layout

- [ ] The popup is 380 px wide and never taller than 560 px; a long list scrolls inside it.
- [ ] A very long MR title ellipsises on one line instead of wrapping or widening the popup.
- [ ] The popup is legible in both the light and the dark browser theme.

## Not in this version

Marking a to-do done from the popup (it needs the full `api` scope), desktop notifications,
self-hosted instances, more than one account, and any list beyond the three. See §2 of the
design document.
