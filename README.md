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
4. Copy the Application ID into `CLIENT_ID` in `src/config.js`.
5. Reload the extension, open the popup, sign in.
6. Repeat steps 1-2 in Edge (`edge://extensions`). The same Application ID and redirect URI
   apply, because the `key` field pins the same ID in both browsers.

## Tests

```
npm test
```

Runs `node --test test/**/*.test.js` with no dependencies. It covers the pure modules only — PKCE, URL
building, response mapping, formatting. Everything browser-dependent is covered by the manual
checklist.

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
