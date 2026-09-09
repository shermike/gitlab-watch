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

`icons/icon.svg` is the source. Its root `width="100%" height="100%"` keeps it scalable and
must not change — but headless Chrome screenshots a standalone SVG with percentage dimensions
as empty, so the export writes a per-size temporary copy with concrete pixel dimensions instead
of screenshotting the source directly:

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
ROOT="$(pwd -W 2>/dev/null || pwd)"
for size in 16 32 48 128; do
  sed "s/width=\"100%\" height=\"100%\"/width=\"$size\" height=\"$size\"/" icons/icon.svg > icons/.export.svg
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --window-size=$size,$size \
    --screenshot="$ROOT/icons/$size.png" "file:///$ROOT/icons/.export.svg" >/dev/null 2>&1
done
rm -f icons/.export.svg
```

Then verify every export by its actual pixel content, not by its header: a fully transparent
PNG has the right width, height and colour type and would pass a header-only check perfectly.

```bash
node scripts/check-icons.mjs icons/16.png icons/32.png icons/48.png icons/128.png
```

Each line reports how many pixels are opaque and how many of those are the brand orange
`#E24329`. The 128 px icon should show roughly 15000-16000 opaque pixels out of 16384 and a
clear majority orange; transparent corners from the rounded rectangle are expected at every
size. If any size reports zero opaque pixels, the export is empty — stop and fix it before
using the PNGs.

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
through in both Chrome and Edge before a version is done. Each item carries two boxes; tick
`Chrome` once verified there and `Edge` once verified there too, so a completed run shows at a
glance whether a box was actually checked in both browsers or only one. Record the date and the
browser versions alongside the result.

Setup

- [ ] Chrome  [ ] Edge — The extension loads unpacked with no errors on the extension card.
- [ ] Chrome  [ ] Edge — The extension ID equals the one pinned by `manifest.json`'s `key`, and
      it is the same ID in both browsers.
- [ ] Chrome  [ ] Edge — `chrome.identity.getRedirectURL()` in the service worker console
      equals the redirect URI registered on GitLab.
- [ ] Chrome  [ ] Edge — The toolbar shows the orange inbox glyph, not empty space or a
      puzzle-piece placeholder, at both 100% and 200% display scaling.

Sign-in

- [ ] Chrome  [ ] Edge — The popup on a fresh profile shows only the "Sign in with GitLab"
      button.
- [ ] Chrome  [ ] Edge — Signing in opens GitLab's authorization page, and it asks for
      `read_api` — nothing more.
- [ ] Chrome  [ ] Edge — Authorizing closes the window and the badge appears within a couple of
      seconds.
- [ ] Chrome  [ ] Edge — Cancelling the authorization window instead leaves the popup on the
      sign-in screen with an explanatory strip, and stores no token.
- [ ] Chrome  [ ] Edge — Leaving the GitLab authorization page open for a minute or two before
      pressing Authorize still stores the token and shows the badge: the service worker can be
      terminated and revived while `chrome.identity.launchWebAuthFlow` is waiting on the user.

Lists

- [ ] Chrome  [ ] Edge — The to-do count on the badge equals the number in GitLab's own header.
- [ ] Chrome  [ ] Edge — Badge colours: white text on `#E24329` for a normal count, and `!` on
      `#DB3B21` for the auth-error state.
- [ ] Chrome  [ ] Edge — The To-dos tab matches <https://gitlab.com/dashboard/todos>, item for
      item.
- [ ] Chrome  [ ] Edge — The Review tab matches GitLab's "Merge requests ▸ Review requests",
      newest update first.
- [ ] Chrome  [ ] Edge — The Mine tab matches the open merge requests you authored, newest
      update first.
- [ ] Chrome  [ ] Edge — A to-do whose target is a commit comment (no MR, no issue) still
      renders readable text and opens the right page.
- [ ] Chrome  [ ] Edge — A draft MR carries a Draft chip and its title has no "Draft:" prefix.
- [ ] Chrome  [ ] Edge — Clicking a row opens the target in a new tab and closes the popup.
- [ ] Chrome  [ ] Edge — Truncation: set `TODOS_PER_PAGE` to `1` in `src/config.js`, reload the
      extension, confirm the "Showing the first N" line appears on the To-dos tab, then restore
      the original value.

State and persistence

- [ ] Chrome  [ ] Edge — Switching tab, closing and reopening the popup lands on the same tab.
- [ ] Chrome  [ ] Edge — An empty list shows its per-tab message, not a blank panel.
- [ ] Chrome  [ ] Edge — Clearing `inbox` in storage makes the popup show the skeleton.
- [ ] Chrome  [ ] Edge — Going offline keeps the last snapshot visible with the "GitLab is
      unreachable" strip, and the badge keeps its count.
- [ ] Chrome  [ ] Edge — Coming back online clears the strip on the next alarm, within about a
      minute.

Session

Run these in the service worker's own DevTools console (`chrome://extensions` → the extension
card → "service worker").

- [ ] Chrome  [ ] Edge — Forcing `expiresAt` to now makes the next call refresh, and the stored
      `refreshToken` changes — GitLab rotates it:

  ```js
  const { auth } = await chrome.storage.local.get('auth');
  await chrome.storage.local.set({ auth: { ...auth, expiresAt: Date.now() } });
  ```

- [ ] Chrome  [ ] Edge — Corrupting `refreshToken` makes the next poll clear `auth`, set
      `inbox.error.kind` to `auth`, show `!` on the badge, and send the popup back to the
      sign-in screen — while the previously fetched lists stay in storage:

  ```js
  const { auth } = await chrome.storage.local.get('auth');
  await chrome.storage.local.set({
    auth: { ...auth, accessToken: 'broken', refreshToken: 'broken', expiresAt: 0 },
  });
  ```

- [ ] Chrome  [ ] Edge — Signing in again from that state restores the count.
- [ ] Chrome  [ ] Edge — Sign-out clears `auth`, `me` and `inbox`, and removes the badge.
- [ ] Chrome  [ ] Edge — Rate-limit backoff: setting a future `backoffUntil` makes the next
      alarm skip its poll (no request fires until that time passes):

  ```js
  await chrome.storage.local.set({ backoffUntil: Date.now() + 300000 });
  ```

Polling

- [ ] Chrome  [ ] Edge — With the popup shut, the badge tracks a to-do marked done in GitLab
      within about a minute.
- [ ] Chrome  [ ] Edge — Pressing refresh twice inside 30 seconds issues API requests only once.
- [ ] Chrome  [ ] Edge — Restarting the browser repopulates the snapshot without a manual
      refresh.

Layout

- [ ] Chrome  [ ] Edge — The popup is 380 px wide and never taller than 560 px; a long list
      scrolls inside it.
- [ ] Chrome  [ ] Edge — A very long MR title ellipsises on one line instead of wrapping or
      widening the popup.
- [ ] Chrome  [ ] Edge — The popup is legible in both the light and the dark browser theme.

## Not in this version

Marking a to-do done from the popup (it needs the full `api` scope), desktop notifications,
self-hosted instances, more than one account, and any list beyond the three. See §2 of the
design document.
