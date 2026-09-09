# GitLab Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an unpacked Chrome/Edge extension that shows a GitLab.com to-do count on the toolbar badge and three read-only lists (to-dos, MRs awaiting my review, my open MRs) in a popup.

**Architecture:** A Manifest V3 service worker polls three GitLab REST endpoints once a minute, maps the raw JSON to flat view shapes, and writes one snapshot into `chrome.storage.local`; it also owns the OAuth2 PKCE token pair and the toolbar badge. The popup never touches the network — it renders whatever snapshot is in storage and asks the worker (by message) to sign in, sign out, or refresh. `pkce.js`, `gitlab.js` and `format.js` never reference `chrome.*`, which is what makes them runnable under `node --test`.

**Tech Stack:** Vanilla ES modules, no build step, no runtime dependencies. Web Crypto (`crypto.subtle`) for PKCE, `fetch` for the API, `chrome.identity.launchWebAuthFlow` for OAuth, `chrome.alarms` for the poll, `node --test` for the unit tests, headless Chrome for the icon PNGs.

**Spec:** `docs/2026-09-09-gitlab-inbox-design.md`

## Corrections after execution

Execution is finished and this plan is otherwise left as-run, but three of its instructions
were overridden during implementation and are recorded here so the plan stops contradicting
the repository:

1. **The `base64UrlEncode` test vector below (Task 2, Step 2) is wrong.** The plan asserts
   `base64UrlEncode(new Uint8Array([0xff, 0xfe, 0xfd]))` equals `'_-79'`; the true value is
   `'__79'` (`0xff 0xfe 0xfd` is `//79` in plain base64, and base64url substitutes *both*
   slashes). The shipped `test/pkce.test.js` asserts `base64UrlEncode(new Uint8Array([0xfb,
   0xff]))` equals `'-_8'` instead, because those two bytes exercise both substitutions
   (`+` → `-` and `/` → `_`) in a single assertion without the arithmetic error.
2. **The test command below (Task 1, both `package.json`'s test script and the README text it
   also writes) is wrong.** The plan specifies `node --test test/`; on Node 24 this fails with
   `MODULE_NOT_FOUND`, because it resolves `test/` as a module entry point rather than a test
   directory. The shipped `package.json` and `README.md` use the glob form,
   `node --test test/**/*.test.js`.
3. **The `src/gitlab.js` doc comment specified below (Task 4) fails the plan's own gate.**
   The plan's text for that comment ends "free of storage and `chrome.*`", whose `chrome.`
   substring trips the plan's own `grep -n "chrome\." src/gitlab.js` verification step. The
   shipped comment says "free of storage and any `chrome` extension API" instead.

## Global Constraints

- **The repository root is the extension root.** The spec's §13 shows a `gitlab-inbox/` directory; that directory *is* this repository (`C:\Users\Mikhail.Sherstenniko\proj\gitlab-watch`). Do **not** create a nested `gitlab-inbox/` folder. `manifest.json`, `icons/`, `src/`, `test/`, `docs/` and `README.md` all sit at the repo root.
- **Branch:** all work happens on `feat/gitlab-inbox`, branched off `master`. Never commit to `master` directly.
- **English only** in every artefact: identifiers, comments, log and error messages, commit messages, test names, docs.
- **Comments describe the code, never the change that produced it.** No "used to", no "no longer", no before/after. Rationale for a change belongs in the commit message; invariants and non-obvious correctness belong in comments, cited to a spec section (`design §5.3`).
- **No runtime dependencies, ever.** `node_modules` must not appear. `package.json` exists only to declare `"type": "module"` and a `test` script.
- **`src/pkce.js`, `src/gitlab.js` and `src/format.js` must not reference `chrome.*`.** Grepping `chrome\.` in those three files must return nothing. This is what keeps them testable (design §4.1, §12).
- **The host is a single constant:** `https://gitlab.com`, declared only in `src/config.js`. No other `.js` file may contain that literal.
- **The scope is exactly `read_api`.** Nothing in the code may issue a non-GET request to `/api/v4`.
- **Extension version `0.1.0`, manifest version 3.**
- **Node 18+ assumed;** the development machine has Node v24.16.0.
- **Badge colours, verbatim:** `#E24329` normal, `#DB3B21` auth error.
- **Popup geometry, verbatim:** 380 px wide, content capped at 560 px tall, the list scrolls.
- **No inline scripts, no inline event handlers** (MV3 CSP). All popup behaviour lives in `popup.js` and is attached with `addEventListener`.
- **Never render API strings with `innerHTML`.** MR and to-do titles are attacker-influenced; use `textContent` and cloned `<template>` nodes.

## Deviations from the spec

Each is small and deliberate. A reviewer may veto any of them; nothing else depends on them.

1. **`src/format.js` is added** (not in §13's file list). §12 requires `test/format.test.js` to cover badge text and relative-time formatting, and §4.1 bans `chrome.*` in tested modules — so those functions cannot live in `background.js`/`popup.js`. `format.js` is their home.
2. **`package.json` is added.** `node --test` needs `"type": "module"` to load `src/*.js` as ES modules. It declares no dependencies, so the "no toolchain" decision stands.
3. **Timestamps are stored as epoch milliseconds** (`createdAt`, `updatedAt`), not ISO strings. §6 does not specify; `relativeTime` needs numbers and `fetchedAt` is already specified as one.
4. **A leading `Draft:` / `WIP:` is stripped from MR titles** in `mapMr`. §9 gives draft MRs a Draft chip; keeping the prefix as well would say the same thing twice.
5. **To-do rows show a humanised `action_name`** ("review requested"). §6 stores `actionName` but §9's row description does not place it; the to-do meta line is the only place it fits.
6. **A popup-initiated refresh ignores `backoffUntil`.** §7 pauses "*alarms* that fire before that time"; a button press is not an alarm, and the 30-second throttle already caps it at two polls a minute.
7. **The popup honours `prefers-color-scheme`.** Not mentioned in §9; a white-only popup glares in a dark browser.
8. **Sign-out does not call `/oauth/revoke`.** It clears local state only. Revocation is a nice-to-have §5 does not ask for.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | `"type": "module"` plus a `test` script. No dependencies. |
| `.gitignore` | Keeps the RSA private key and OS junk out of the repo. |
| `manifest.json` | MV3 declaration. Grows across Tasks 1, 5, 6. |
| `icons/icon.svg` | The one source drawing. |
| `icons/{16,32,48,128}.png` | Exported from `icon.svg`. |
| `src/config.js` | Constants only: host, client id, scope, alarm period, page sizes, timing thresholds. |
| `src/pkce.js` | base64url, random verifier and state, S256 challenge. Pure, Web Crypto only. |
| `src/format.js` | `badgeText`, `relativeTime`, `humaniseAction`. Pure. |
| `src/gitlab.js` | URL builders, `apiGet`, status→error-kind mapping, raw JSON → view shapes. No storage, no `chrome.*`. |
| `src/store.js` | Read/write/onChanged helpers over `chrome.storage.local`, with the schema defaults in one place. |
| `src/auth.js` | PKCE dance, token exchange, single-flight refresh, sign-out. Owns the `auth` key. |
| `src/background.js` | Lifecycle and alarm wiring, poll orchestration, 401 retry, badge, message handling. |
| `src/popup/popup.html` | Static structure: sign-in section, header, tabs, list, footer, row `<template>`. |
| `src/popup/popup.css` | Geometry and theme. |
| `src/popup/popup.js` | Renders the five states from storage, sends messages, opens rows. |
| `test/pkce.test.js` | RFC 7636 vector, verifier and state shape. |
| `test/format.test.js` | Badge text, relative-time boundaries, action humanising. |
| `test/gitlab.test.js` | Exact query strings, error-kind mapping, fixture → view shape. |
| `test/fixtures/todos.json` | Two to-dos, one with `target: null`. |
| `test/fixtures/merge_requests.json` | Two MRs, one draft. |
| `test/fixtures/user.json` | One account. |
| `README.md` | What it is, one-time setup, test command, manual browser checklist. |

---

### Task 1: Extension shell — manifest, pinned ID, icons

Delivers an extension that loads unpacked in both browsers with the *same* extension ID, which is the prerequisite for a single OAuth redirect URI (design §5.1). No behaviour yet: the manifest declares no service worker and no popup, so there is nothing to run.

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `manifest.json`
- Create: `icons/icon.svg`
- Create: `icons/16.png`, `icons/32.png`, `icons/48.png`, `icons/128.png`
- Create: `src/config.js`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `src/config.js` exports the constants `GITLAB_HOST`, `CLIENT_ID`, `SCOPE`, `ALARM_NAME`, `ALARM_PERIOD_MINUTES`, `TODOS_PER_PAGE`, `MRS_PER_PAGE`, `TOKEN_STALE_MARGIN_MS`, `MANUAL_REFRESH_MIN_AGE_MS`, `RATELIMIT_BACKOFF_MS`. `npm test` runs `node --test test/`.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/gitlab-inbox
```

- [ ] **Step 2: Write `package.json`**

No dependencies. `"private": true` so it can never reach npm by accident.

```json
{
  "name": "gitlab-inbox",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Pending GitLab to-dos and merge requests on your toolbar.",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

The RSA private key generated in Step 4 is never needed again for an unpacked extension — only its public half goes into the manifest. Keep it out of git regardless.

```gitignore
*.pem
node_modules/
Thumbs.db
.DS_Store
```

- [ ] **Step 4: Generate the RSA keypair and derive the extension ID**

Chrome and Edge both derive the extension ID from the manifest `key` field: the first 128 bits of `SHA-256(DER public key)`, each hex digit mapped `0..f` → `a..p`. Pinning `key` is what makes the ID identical in both browsers (design §5.1).

Run from the repo root in Git Bash:

```bash
openssl genrsa -out key.pem 2048
openssl rsa -in key.pem -pubout -outform DER -out pub.der
node -e "
const fs = require('fs'), crypto = require('crypto');
const der = fs.readFileSync('pub.der');
const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
console.log('key      :', der.toString('base64'));
console.log('id       :', id);
console.log('redirect : https://' + id + '.chromiumapp.org/');
"
rm pub.der
```

Expected: a 392-character base64 `key`, a 32-character `id` made only of the letters `a`-`p`, and the redirect URI built from it. Record all three — Step 8, Step 10, Task 5 Step 5 and Task 7 Step 1 all need them.

- [ ] **Step 5: Draw `icons/icon.svg`**

A neutral inbox tray in GitLab's orange. `width` and `height` are `100%` over a fixed `viewBox`, so the same file exports cleanly at every size in Step 6. GitLab's own logo is deliberately not used, to avoid shipping a trademark in a personal tool (design §11).

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%"
     preserveAspectRatio="xMidYMid meet" style="display:block">
  <rect width="128" height="128" rx="26" fill="#E24329"/>
  <path d="M30 44h20l9 17h10l9-17h20v42a9 9 0 0 1-9 9H39a9 9 0 0 1-9-9z" fill="#fff"/>
  <path d="M44 30h40" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 6: Export the four PNG sizes**

There is no ImageMagick on this machine; headless Chrome renders the SVG and screenshots it. `--default-background-color=00000000` is what keeps the rounded corners transparent, and the screenshot path must be absolute or Chrome refuses to write it.

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
ROOT="$(pwd -W 2>/dev/null || pwd)"
for size in 16 32 48 128; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 \
    --window-size=$size,$size \
    --screenshot="$ROOT/icons/$size.png" \
    "file:///$ROOT/icons/icon.svg" >/dev/null 2>&1
done
```

- [ ] **Step 7: Verify the PNGs are the right size and carry an alpha channel**

Reads the PNG IHDR directly: bytes 16-19 are the width, 20-23 the height, byte 25 the colour type (6 = RGBA).

```bash
node -e "
const fs = require('fs');
for (const size of [16, 32, 48, 128]) {
  const b = fs.readFileSync('icons/' + size + '.png');
  console.log(size, b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), 'colorType', b[25]);
}
"
```

Expected exactly:

```
16 16x16 colorType 6
32 32x32 colorType 6
48 48x48 colorType 6
128 128x128 colorType 6
```

A wrong size or colour type 2 (no alpha) means the export failed. Do not proceed.

- [ ] **Step 8: Write `manifest.json`**

Paste the `key` from Step 4. `tabs` is not requested: `chrome.tabs.create` with a URL works without it. `identity` is required for `launchWebAuthFlow` and is supported in Edge. There is no `background` key yet (Task 5 adds it) and no `default_popup` yet (Task 6 adds it).

```json
{
  "manifest_version": 3,
  "name": "GitLab Inbox",
  "version": "0.1.0",
  "description": "Pending GitLab to-dos and merge requests on your toolbar.",
  "key": "PASTE_THE_BASE64_KEY_FROM_STEP_4",
  "permissions": ["storage", "alarms", "identity"],
  "host_permissions": ["https://gitlab.com/*"],
  "action": {
    "default_icon": { "16": "icons/16.png", "32": "icons/32.png" }
  },
  "icons": {
    "16": "icons/16.png",
    "32": "icons/32.png",
    "48": "icons/48.png",
    "128": "icons/128.png"
  }
}
```

- [ ] **Step 9: Write `src/config.js`**

```js
// Only `https://gitlab.com` is targeted and tested; self-hosted instances are out of scope
// for v1 (design §2), and this constant is the single place a future port would change.
export const GITLAB_HOST = 'https://gitlab.com';

// The Application ID of a user-owned OAuth application. Public by design: the application is
// non-confidential, so there is no client secret and this value is not a credential
// (design §5.1).
export const CLIENT_ID = 'PASTE_YOUR_APPLICATION_ID_HERE';

// The extension only reads; a stolen token cannot modify anything (design §3).
export const SCOPE = 'read_api';

export const ALARM_NAME = 'poll';

// One minute is the shortest period Manifest V3 permits (design §7).
export const ALARM_PERIOD_MINUTES = 1;

export const TODOS_PER_PAGE = 100;
export const MRS_PER_PAGE = 50;

// A token counts as stale five minutes before it expires, so a request never starts with a
// token that could expire mid-flight (design §5.3).
export const TOKEN_STALE_MARGIN_MS = 300_000;

// A popup-initiated refresh is a no-op while the snapshot is younger than this (design §7).
export const MANUAL_REFRESH_MIN_AGE_MS = 30_000;

// How long polling pauses after HTTP 429 (design §10).
export const RATELIMIT_BACKOFF_MS = 300_000;
```

- [ ] **Step 10: Write the initial `README.md`**

Only the parts that are true after this task. The manual browser checklist arrives in Task 7. Substitute the real ID from Step 4 wherever `PASTE_THE_ID` appears if it is already known; Task 7 Step 1 fails the build if any survive.

````markdown
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

   `PASTE_THE_ID`

3. Create a user-owned OAuth application at
   <https://gitlab.com/-/user_settings/applications>:
   - **Name:** GitLab Inbox
   - **Redirect URI:** `https://PASTE_THE_ID.chromiumapp.org/`
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

Runs `node --test test/` with no dependencies. It covers the pure modules only — PKCE, URL
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
````

- [ ] **Step 11: Load the extension in Chrome and verify the ID**

Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select the repo root.

Expected: "GitLab Inbox 0.1.0" loads with no errors, the orange inbox icon appears in the toolbar, and the ID shown equals the `id` printed in Step 4. Clicking the icon does nothing — there is no popup yet.

- [ ] **Step 12: Load the extension in Edge and verify the ID matches**

Open `edge://extensions`, enable Developer mode, **Load unpacked**, select the repo root.

Expected: the ID is byte-identical to Chrome's. If it differs, the `key` field is wrong — recheck Steps 4 and 8 before continuing, and register both redirect URIs on GitLab (newline-separated), which is the fallback design §5.1 allows.

- [ ] **Step 13: Commit**

```bash
git add package.json .gitignore manifest.json icons src/config.js README.md
git commit -m "feat: extension shell with a pinned extension ID

The manifest key field fixes the extension ID, so Chrome and Edge derive the
same ID and a single OAuth redirect URI covers both (design 5.1)."
```

---

### Task 2: `pkce.js` — verifier, challenge, state

A pure module, Web Crypto only, no `chrome.*`. Verified against the RFC 7636 Appendix B vector, which is the whole point of testing it: a wrong base64url alphabet or a stray padding character produces a challenge GitLab rejects only at token exchange, where the failure is far harder to read.

**Files:**
- Create: `src/pkce.js`
- Test: `test/pkce.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `base64UrlEncode(bytes: Uint8Array): string` — unpadded base64url.
  - `randomVerifier(): string` — 86 characters.
  - `randomState(): string` — 43 characters.
  - `challengeFromVerifier(verifier: string): Promise<string>` — base64url of `SHA-256(ascii(verifier))`.

- [ ] **Step 1: Write the failing test**

Create `test/pkce.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base64UrlEncode,
  challengeFromVerifier,
  randomState,
  randomVerifier,
} from '../src/pkce.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

test('base64UrlEncode uses the URL alphabet and drops padding', () => {
  // "hi" is two bytes, so plain base64 would pad it to "aGk=".
  assert.equal(base64UrlEncode(new TextEncoder().encode('hi')), 'aGk');
  // 0xff 0xfe 0xfd is "//79" in plain base64, exercising both substitutions.
  assert.equal(base64UrlEncode(new Uint8Array([0xff, 0xfe, 0xfd])), '_-79');
});

test('challengeFromVerifier matches the RFC 7636 Appendix B vector', async () => {
  const challenge = await challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomVerifier is 86 base64url characters, inside the RFC 7636 43..128 range', () => {
  const verifier = randomVerifier();
  assert.equal(verifier.length, 86);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, BASE64URL);
});

test('randomVerifier does not repeat', () => {
  assert.notEqual(randomVerifier(), randomVerifier());
});

test('randomState is 43 base64url characters', () => {
  const state = randomState();
  assert.equal(state.length, 43);
  assert.match(state, BASE64URL);
});

test('randomState does not repeat', () => {
  assert.notEqual(randomState(), randomState());
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pkce.test.js`

Expected: FAIL — `ERR_MODULE_NOT_FOUND`, `Cannot find module .../src/pkce.js`.

- [ ] **Step 3: Write the implementation**

Create `src/pkce.js`:

```js
// 64 random bytes encode to 86 base64url characters, comfortably inside the 43..128 that
// RFC 7636 section 4.1 requires of a code verifier.
const VERIFIER_BYTES = 64;
const STATE_BYTES = 32;

/** Unpadded base64url, the only encoding RFC 7636 accepts for the verifier and challenge. */
export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomVerifier() {
  return randomBase64Url(VERIFIER_BYTES);
}

export function randomState() {
  return randomBase64Url(STATE_BYTES);
}

/** `code_challenge` for method S256: base64url(SHA-256(ascii(verifier))). */
export async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pkce.test.js`

Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 5: Verify the `chrome.*` ban holds**

Run: `grep -n "chrome\." src/pkce.js`

Expected: no output, exit code 1.

- [ ] **Step 6: Commit**

```bash
git add src/pkce.js test/pkce.test.js
git commit -m "feat: add PKCE verifier, state and S256 challenge generation

Verified against the RFC 7636 Appendix B vector: a wrong base64url alphabet or
leftover padding yields a challenge GitLab rejects only at token exchange,
where the failure is much harder to read."
```

---

### Task 3: `format.js` — badge text and relative time

Two pure display functions plus one string tidier. They get their own module because both `background.js` and `popup.js` need them and neither of those is importable under `node --test` (design §4.1, §12).

**Files:**
- Create: `src/format.js`
- Test: `test/format.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `badgeText(count: number): string` — `''` for 0, the number for 1-99, `'99+'` above.
  - `relativeTime(timestamp: number, now?: number): string` — `'just now'`, `'N min ago'`, `'N h ago'`, `'N d ago'`.
  - `humaniseAction(actionName: string): string` — `'review_requested'` → `'review requested'`.

- [ ] **Step 1: Write the failing test**

Create `test/format.test.js`. The relative-time cases sit exactly on the boundaries, because an off-by-one between `<` and `<=` is the only bug this function can realistically have.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { badgeText, humaniseAction, relativeTime } from '../src/format.js';

test('badgeText hides a zero count and caps at 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(150), '99+');
});

test('badgeText treats a missing count as zero', () => {
  assert.equal(badgeText(undefined), '');
  assert.equal(badgeText(null), '');
});

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const ago = (ms) => relativeTime(NOW - ms, NOW);

test('relativeTime rounds down at every unit boundary', () => {
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59_999), 'just now');
  assert.equal(ago(60_000), '1 min ago');
  assert.equal(ago(20 * 60_000), '20 min ago');
  assert.equal(ago(3_599_999), '59 min ago');
  assert.equal(ago(3_600_000), '1 h ago');
  assert.equal(ago(86_399_999), '23 h ago');
  assert.equal(ago(86_400_000), '1 d ago');
  assert.equal(ago(9 * 86_400_000), '9 d ago');
});

test('relativeTime does not produce a negative age on a skewed clock', () => {
  assert.equal(relativeTime(NOW + 60_000, NOW), 'just now');
});

// `fetchedAt` is 0 until a poll first succeeds, and "just now" is the least misleading thing
// to print for a value that means "never".
test('relativeTime survives a missing timestamp', () => {
  assert.equal(relativeTime(undefined, NOW), 'just now');
  assert.equal(relativeTime(0, NOW), 'just now');
});

test('humaniseAction replaces underscores', () => {
  assert.equal(humaniseAction('review_requested'), 'review requested');
  assert.equal(humaniseAction('mentioned'), 'mentioned');
  assert.equal(humaniseAction(''), '');
  assert.equal(humaniseAction(undefined), '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/format.test.js`

Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/format.js`.

- [ ] **Step 3: Write the implementation**

Create `src/format.js`:

```js
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Two characters is all the badge renders legibly.
const BADGE_MAX = 99;

/** Toolbar badge text for a pending to-do count. Empty means "draw no badge". */
export function badgeText(count) {
  if (!count) return '';
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/**
 * A coarse age, rounded down: "20 min ago". A `timestamp` of 0 or undefined means "never",
 * and so does a future timestamp on a skewed clock; both render as "just now" rather than as
 * a nonsense age.
 */
export function relativeTime(timestamp, now = Date.now()) {
  const elapsed = now - timestamp;
  if (!Number.isFinite(elapsed) || !timestamp || elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

/** A to-do's `action_name` as prose: "review_requested" reads as "review requested". */
export function humaniseAction(actionName) {
  return (actionName ?? '').replace(/_/g, ' ');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/format.test.js`

Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 5: Verify the `chrome.*` ban holds**

Run: `grep -n "chrome\." src/format.js`

Expected: no output, exit code 1.

- [ ] **Step 6: Commit**

```bash
git add src/format.js test/format.test.js
git commit -m "feat: add badge text and relative time formatting

Both background.js and popup/popup.js need these, and neither is importable
under node --test, so the two pure functions get their own module (design 4.1)."
```

---

### Task 4: `gitlab.js` — URLs, requests, response mapping

The API surface. Everything here is either a pure function or a thin `fetch` wrapper; no storage, no `chrome.*`, no token handling — the caller supplies the token. That is what lets the query strings and the mapping be asserted exactly.

**Files:**
- Create: `src/gitlab.js`
- Test: `test/gitlab.test.js`
- Create: `test/fixtures/todos.json`
- Create: `test/fixtures/merge_requests.json`
- Create: `test/fixtures/user.json`

**Interfaces:**
- Consumes: `src/config.js` (`GITLAB_HOST`, `TODOS_PER_PAGE`, `MRS_PER_PAGE`).
- Produces:
  - `userUrl(): string`, `todosUrl(): string`, `reviewsUrl(userId: number): string`, `mineUrl(userId: number): string`
  - `errorKindForStatus(status: number): 'auth' | 'ratelimit' | 'network' | 'unknown'`
  - `class ApiError extends Error` with `status: number` and `kind` as above
  - `apiGet(url: string, token: string): Promise<{ body: unknown, nextPage: string }>` — throws `ApiError` on a non-2xx response, and whatever `fetch` rejects with when the network is down
  - `mapUser(raw): { id, username, name, avatarUrl, webUrl }`
  - `mapTodo(raw): { id, title, url, project, actionName, authorName, authorAvatar, createdAt }`
  - `mapMr(raw): { id, title, url, reference, authorName, authorAvatar, updatedAt, draft }`
  - `createdAt` and `updatedAt` are epoch milliseconds.

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/todos.json`, trimmed to the fields the mapper reads. The second entry has `target: null`, which is what a `mentioned`-on-a-commit to-do actually looks like and the case design §12.4 calls out.

```json
[
  {
    "id": 130,
    "action_name": "review_requested",
    "target_url": "https://gitlab.com/group/project/-/merge_requests/7",
    "body": "Add rate limiting to the poller",
    "created_at": "2026-09-09T09:00:00.000Z",
    "project": { "path_with_namespace": "group/project" },
    "author": { "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" },
    "target": { "title": "Add rate limiting to the poller" }
  },
  {
    "id": 131,
    "action_name": "mentioned",
    "target_url": "https://gitlab.com/group/other/-/commit/deadbeef#note_9",
    "body": "mentioned you in a commit comment",
    "created_at": "2026-09-09T08:30:00.000Z",
    "project": { "path_with_namespace": "group/other" },
    "author": { "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" },
    "target": null
  }
]
```

Create `test/fixtures/merge_requests.json`. The second entry is a draft, carrying the `Draft: ` prefix GitLab puts in the title itself.

```json
[
  {
    "id": 900,
    "iid": 7,
    "title": "Add rate limiting to the poller",
    "web_url": "https://gitlab.com/group/project/-/merge_requests/7",
    "references": { "short": "!7", "relative": "!7", "full": "group/project!7" },
    "author": { "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" },
    "updated_at": "2026-09-09T09:20:00.000Z",
    "draft": false
  },
  {
    "id": 901,
    "iid": 8,
    "title": "Draft: Split the poller in two",
    "web_url": "https://gitlab.com/group/project/-/merge_requests/8",
    "references": { "short": "!8", "relative": "!8", "full": "group/project!8" },
    "author": { "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" },
    "updated_at": "2026-09-09T07:00:00.000Z",
    "draft": true
  }
]
```

Create `test/fixtures/user.json`:

```json
{
  "id": 42,
  "username": "ada",
  "name": "Ada Lovelace",
  "avatar_url": "https://gitlab.com/uploads/ada.png",
  "web_url": "https://gitlab.com/ada"
}
```

- [ ] **Step 2: Write the failing test**

Create `test/gitlab.test.js`. The URL assertions are full literal strings, not rebuilt from the helpers under test — a query string is exactly the kind of thing that looks obviously right and is wrong, and `scope=all` is load-bearing: without it `/merge_requests` silently returns only MRs the user authored (design §7).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ApiError,
  errorKindForStatus,
  mapMr,
  mapTodo,
  mapUser,
  mineUrl,
  reviewsUrl,
  todosUrl,
  userUrl,
} from '../src/gitlab.js';

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);

test('userUrl', () => {
  assert.equal(userUrl(), 'https://gitlab.com/api/v4/user');
});

test('todosUrl asks for pending to-dos only', () => {
  assert.equal(todosUrl(), 'https://gitlab.com/api/v4/todos?state=pending&per_page=100');
});

test('reviewsUrl asks for open MRs across all projects where I am a reviewer', () => {
  assert.equal(
    reviewsUrl(42),
    'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened&reviewer_id=42' +
      '&order_by=updated_at&sort=desc&per_page=50',
  );
});

test('mineUrl asks for open MRs across all projects that I authored', () => {
  assert.equal(
    mineUrl(42),
    'https://gitlab.com/api/v4/merge_requests?scope=all&state=opened&author_id=42' +
      '&order_by=updated_at&sort=desc&per_page=50',
  );
});

test('errorKindForStatus classifies the statuses the poller acts on', () => {
  assert.equal(errorKindForStatus(401), 'auth');
  assert.equal(errorKindForStatus(429), 'ratelimit');
  assert.equal(errorKindForStatus(500), 'network');
  assert.equal(errorKindForStatus(503), 'network');
  // A 403 is a resource problem, not a dead session: it must not sign the user out.
  assert.equal(errorKindForStatus(403), 'unknown');
  assert.equal(errorKindForStatus(404), 'unknown');
});

test('ApiError carries the status and its kind', () => {
  const error = new ApiError(429, 'too many');
  assert.ok(error instanceof Error);
  assert.equal(error.status, 429);
  assert.equal(error.kind, 'ratelimit');
});

test('mapUser flattens the account fields the extension needs', async () => {
  assert.deepEqual(mapUser(await fixture('user')), {
    id: 42,
    username: 'ada',
    name: 'Ada Lovelace',
    avatarUrl: 'https://gitlab.com/uploads/ada.png',
    webUrl: 'https://gitlab.com/ada',
  });
});

test('mapTodo prefers the target title and keeps the target_url', async () => {
  const [todo] = await fixture('todos');
  assert.deepEqual(mapTodo(todo), {
    id: 130,
    title: 'Add rate limiting to the poller',
    url: 'https://gitlab.com/group/project/-/merge_requests/7',
    project: 'group/project',
    actionName: 'review_requested',
    authorName: 'Ada Lovelace',
    authorAvatar: 'https://gitlab.com/uploads/ada.png',
    createdAt: Date.UTC(2026, 8, 9, 9, 0, 0),
  });
});

test('mapTodo falls back to the body when target is null', async () => {
  const [, todo] = await fixture('todos');
  assert.deepEqual(mapTodo(todo), {
    id: 131,
    title: 'mentioned you in a commit comment',
    url: 'https://gitlab.com/group/other/-/commit/deadbeef#note_9',
    project: 'group/other',
    actionName: 'mentioned',
    authorName: 'Grace Hopper',
    authorAvatar: 'https://gitlab.com/uploads/grace.png',
    createdAt: Date.UTC(2026, 8, 9, 8, 30, 0),
  });
});

test('mapTodo tolerates a to-do stripped of every optional field', () => {
  assert.deepEqual(mapTodo({ id: 1 }), {
    id: 1,
    title: '',
    url: '',
    project: '',
    actionName: '',
    authorName: '',
    authorAvatar: '',
    createdAt: 0,
  });
});

test('mapMr takes the project and number from references.full', async () => {
  const [mr] = await fixture('merge_requests');
  assert.deepEqual(mapMr(mr), {
    id: 900,
    title: 'Add rate limiting to the poller',
    url: 'https://gitlab.com/group/project/-/merge_requests/7',
    reference: 'group/project!7',
    authorName: 'Ada Lovelace',
    authorAvatar: 'https://gitlab.com/uploads/ada.png',
    updatedAt: Date.UTC(2026, 8, 9, 9, 20, 0),
    draft: false,
  });
});

test('mapMr flags a draft and strips the prefix the chip already says', async () => {
  const [, mr] = await fixture('merge_requests');
  assert.deepEqual(mapMr(mr), {
    id: 901,
    title: 'Split the poller in two',
    url: 'https://gitlab.com/group/project/-/merge_requests/8',
    reference: 'group/project!8',
    authorName: 'Grace Hopper',
    authorAvatar: 'https://gitlab.com/uploads/grace.png',
    updatedAt: Date.UTC(2026, 8, 9, 7, 0, 0),
    draft: true,
  });
});

test('mapMr recognises the legacy work_in_progress flag and the WIP prefix', () => {
  const mapped = mapMr({ id: 2, title: 'WIP: old style', work_in_progress: true });
  assert.equal(mapped.draft, true);
  assert.equal(mapped.title, 'old style');
});

test('mapMr tolerates an MR stripped of every optional field', () => {
  assert.deepEqual(mapMr({ id: 3 }), {
    id: 3,
    title: '',
    url: '',
    reference: '',
    authorName: '',
    authorAvatar: '',
    updatedAt: 0,
    draft: false,
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/gitlab.test.js`

Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `../src/gitlab.js`.

- [ ] **Step 4: Write the implementation**

Create `src/gitlab.js`:

```js
import { GITLAB_HOST, MRS_PER_PAGE, TODOS_PER_PAGE } from './config.js';

const API = `${GITLAB_HOST}/api/v4`;

// GitLab puts "Draft: " (and historically "WIP: ") in the title itself; the popup shows a
// Draft chip instead, so the prefix would say the same thing twice.
const DRAFT_PREFIX = /^\s*(draft|wip)\s*:\s*/i;

export function userUrl() {
  return `${API}/user`;
}

export function todosUrl() {
  return `${API}/todos?state=pending&per_page=${TODOS_PER_PAGE}`;
}

// `scope=all` is required: without it /merge_requests returns only MRs the user created,
// which would empty the review list with no error to notice (design §7).
function mergeRequestsUrl(filter) {
  return (
    `${API}/merge_requests?scope=all&state=opened&${filter}` +
    `&order_by=updated_at&sort=desc&per_page=${MRS_PER_PAGE}`
  );
}

export function reviewsUrl(userId) {
  return mergeRequestsUrl(`reviewer_id=${userId}`);
}

export function mineUrl(userId) {
  return mergeRequestsUrl(`author_id=${userId}`);
}

/**
 * Maps an HTTP status to the `inbox.error.kind` the badge and popup branch on (design §10).
 * A 403 stays `unknown` on purpose: it means one resource is forbidden, not that the session
 * is dead, and treating it as `auth` would sign the user out over a single bad project.
 */
export function errorKindForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status >= 500) return 'network';
  return 'unknown';
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = errorKindForStatus(status);
  }
}

/**
 * One authenticated GET. No retry and no token handling — the caller owns both, which is what
 * keeps this module free of storage and `chrome.*`.
 *
 * `nextPage` is GitLab's `x-next-page` header: non-empty exactly when further pages exist,
 * which is how truncation is detected without requesting a second page (design §7).
 */
export async function apiGet(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiError(response.status, `GET ${url} responded ${response.status}`);
  }
  return {
    body: await response.json(),
    nextPage: response.headers.get('x-next-page') ?? '',
  };
}

/** ISO 8601 to epoch milliseconds; 0 stands for "no timestamp". */
function epochMs(iso) {
  const parsed = Date.parse(iso ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function mapUser(raw) {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    avatarUrl: raw.avatar_url ?? '',
    webUrl: raw.web_url ?? '',
  };
}

export function mapTodo(raw) {
  return {
    id: raw.id,
    // A to-do on a commit or a deleted object has no target; `body` is then the only text.
    title: raw.target?.title ?? raw.body ?? '',
    url: raw.target_url ?? '',
    project: raw.project?.path_with_namespace ?? '',
    actionName: raw.action_name ?? '',
    authorName: raw.author?.name ?? '',
    authorAvatar: raw.author?.avatar_url ?? '',
    createdAt: epochMs(raw.created_at),
  };
}

export function mapMr(raw) {
  return {
    id: raw.id,
    title: (raw.title ?? '').replace(DRAFT_PREFIX, ''),
    url: raw.web_url ?? '',
    // `references.full` is "group/project!123": the project path and the MR number in one
    // field, with no extra request (design §6).
    reference: raw.references?.full ?? '',
    authorName: raw.author?.name ?? '',
    authorAvatar: raw.author?.avatar_url ?? '',
    updatedAt: epochMs(raw.updated_at),
    draft: raw.draft === true || raw.work_in_progress === true,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/gitlab.test.js`

Expected: PASS — `# pass 14`, `# fail 0`.

- [ ] **Step 6: Run the whole suite and the `chrome.*` check**

Run: `npm test && grep -n "chrome\." src/gitlab.js`

Expected: all three test files pass with `# fail 0`, then `grep` prints nothing and exits 1.

- [ ] **Step 7: Commit**

```bash
git add src/gitlab.js test/gitlab.test.js test/fixtures
git commit -m "feat: add GitLab request builders and response mapping

The query strings are asserted as literals because scope=all is load-bearing:
without it /merge_requests returns only MRs the user authored, emptying the
review list with no error to notice (design 7)."
```

---

### Task 5: `store.js`, `auth.js`, and the polling service worker

The first task with behaviour. After it the extension signs in, keeps a fresh snapshot in `chrome.storage.local`, and shows the badge — all without a popup, because the popup is not the worker's only trigger and the worker has to stand up on its own. Verification drives the worker from its own DevTools console.

**Files:**
- Create: `src/store.js`
- Create: `src/auth.js`
- Create: `src/background.js`
- Modify: `manifest.json` (add the `background` key)
- Modify: `src/config.js` (fill in the real `CLIENT_ID`)

**Interfaces:**
- Consumes: `src/config.js`, `src/pkce.js`, `src/gitlab.js`, `src/format.js`.
- Produces:
  - `store.js`: `SCHEMA_DEFAULTS`, `read(...keys): Promise<object>` (defaults applied), `write(patch): Promise<void>`, `onChanged(listener): void`.
  - `auth.js`: `class AuthError extends Error` with `terminal: boolean`; `signIn(): Promise<Auth>`; `refresh(): Promise<Auth>`; `getAccessToken(): Promise<string>`; `signOut(): Promise<void>`. `Auth` is `{ accessToken, refreshToken, expiresAt, scope }`.
  - `background.js` exports nothing. It registers `chrome.runtime.onInstalled`, `chrome.runtime.onStartup` and `chrome.alarms.onAlarm` at module scope, and internally owns `poll({ respectBackoff })`, `applyBadge()`, `setError(kind, message)` and `ensureAlarm()` — all four are called by the message handler Task 6 appends to this same file.

- [ ] **Step 1: Write `src/store.js`**

```js
/**
 * The `chrome.storage.local` schema (design §6). Every read goes through these defaults, so
 * no caller has to distinguish "unset" from "set to the default".
 *
 * `inbox: null` means "no poll has ever succeeded", and is what makes the popup show its
 * skeleton rather than three empty lists.
 */
export const SCHEMA_DEFAULTS = {
  auth: null,
  me: null,
  inbox: null,
  ui: { activeTab: 'todos' },
  backoffUntil: 0,
};

/** Reads the named keys, or the whole schema when called with no arguments. */
export function read(...keys) {
  const wanted = keys.length > 0 ? keys : Object.keys(SCHEMA_DEFAULTS);
  const defaults = {};
  for (const key of wanted) defaults[key] = SCHEMA_DEFAULTS[key];
  return chrome.storage.local.get(defaults);
}

export function write(patch) {
  return chrome.storage.local.set(patch);
}

/** Calls back with the changed keys of the local area, ignoring every other area. */
export function onChanged(listener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') listener(changes);
  });
}
```

- [ ] **Step 2: Write `src/auth.js`**

```js
import { CLIENT_ID, GITLAB_HOST, SCOPE, TOKEN_STALE_MARGIN_MS } from './config.js';
import { challengeFromVerifier, randomState, randomVerifier } from './pkce.js';
import { read, write } from './store.js';

const AUTHORIZE_URL = `${GITLAB_HOST}/oauth/authorize`;
const TOKEN_URL = `${GITLAB_HOST}/oauth/token`;

/**
 * `terminal` means the session cannot be recovered by retrying and the user must sign in
 * again. Anything else — a timeout, a 5xx from the token endpoint — is transient, and the
 * next alarm retries it.
 */
export class AuthError extends Error {
  constructor(message, { terminal = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.terminal = terminal;
  }
}

// At most one refresh request is outstanding per worker lifetime. The worker can be
// terminated between calls, so this is an optimisation, not a correctness guarantee: a
// duplicated refresh after a restart invalidates the older token and the next call refreshes
// again (design §5.3).
let refreshInFlight = null;

// Taken from the API rather than hard-coded, so the registered redirect URI and the used one
// cannot drift (design §5.1).
function redirectUri() {
  return chrome.identity.getRedirectURL();
}

/**
 * Exchanges a grant for a token pair. No client secret: the OAuth application is
 * non-confidential, because a browser extension cannot keep one (design §5.1).
 */
async function exchange(grant) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri(),
        ...grant,
      }),
    });
  } catch (cause) {
    throw new AuthError(`Token endpoint unreachable: ${cause.message}`);
  }

  if (!response.ok) {
    // 400 invalid_grant on a refresh, or a rejected authorization code: unrecoverable.
    throw new AuthError(`Token endpoint responded ${response.status}`, {
      terminal: response.status === 400 || response.status === 401,
    });
  }

  const json = await response.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope ?? SCOPE,
  };
}

/** The full PKCE authorization-code flow. Stores the token pair on success (design §5.2). */
export async function signIn() {
  const verifier = randomVerifier();
  const state = randomState();
  const challenge = await challengeFromVerifier(verifier);

  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    state,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  let callbackUrl;
  try {
    callbackUrl = await chrome.identity.launchWebAuthFlow({
      interactive: true,
      url: authorize.toString(),
    });
  } catch (cause) {
    // The user closed the window, or the redirect never arrived.
    throw new AuthError(cause.message || 'Sign-in was cancelled.', { terminal: true });
  }

  const params = new URL(callbackUrl).searchParams;
  // A state mismatch means the response is not ours: abort and store nothing (design §5.2).
  if (params.get('state') !== state) {
    throw new AuthError('Sign-in failed, please try again.', { terminal: true });
  }
  const code = params.get('code');
  if (!code) {
    throw new AuthError(params.get('error_description') || 'Sign-in failed, please try again.', {
      terminal: true,
    });
  }

  const auth = await exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
  });
  await write({ auth });
  return auth;
}

async function performRefresh() {
  const { auth } = await read('auth');
  if (!auth?.refreshToken) {
    throw new AuthError('Not signed in.', { terminal: true });
  }
  const next = await exchange({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
  });
  // GitLab rotates refresh tokens: the old one is invalid the moment this response arrives,
  // so the new pair must be persisted before anything else runs. Losing this write loses the
  // session (design §5.3).
  await write({ auth: next });
  return next;
}

/** Refreshes the token pair, collapsing concurrent callers onto one request. */
export function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * A usable access token, refreshing first when the stored one is within
 * `TOKEN_STALE_MARGIN_MS` of expiry. Checked lazily before every call, never on a timer
 * (design §5.3).
 */
export async function getAccessToken() {
  const { auth } = await read('auth');
  if (!auth) throw new AuthError('Not signed in.', { terminal: true });
  if (Date.now() >= auth.expiresAt - TOKEN_STALE_MARGIN_MS) {
    return (await refresh()).accessToken;
  }
  return auth.accessToken;
}

/** Drops the local session. The authorization on GitLab's side is left alone (design §2). */
export async function signOut() {
  refreshInFlight = null;
  await write({ auth: null, me: null });
}
```

- [ ] **Step 3: Write `src/background.js`**

Message handling is deliberately absent; Task 6 adds it together with its only sender.

```js
import { ALARM_NAME, ALARM_PERIOD_MINUTES, RATELIMIT_BACKOFF_MS } from './config.js';
import { AuthError, getAccessToken, refresh, signOut } from './auth.js';
import {
  ApiError,
  apiGet,
  mapMr,
  mapTodo,
  mapUser,
  mineUrl,
  reviewsUrl,
  todosUrl,
  userUrl,
} from './gitlab.js';
import { badgeText } from './format.js';
import { read, write } from './store.js';

const BADGE_COLOR = '#E24329';
const BADGE_ERROR_COLOR = '#DB3B21';

const ERROR_MESSAGES = {
  auth: 'Session expired — sign in again.',
  network: 'GitLab is unreachable. Showing the last known state.',
  ratelimit: 'Rate limited by GitLab. Retrying in a few minutes.',
  unknown: 'Unexpected error talking to GitLab.',
};

/**
 * One authenticated GET with the single retry design §10 allows: on 401, refresh once and
 * retry once. A second 401 propagates, and the caller ends the session.
 */
async function authorizedGet(url) {
  const token = await getAccessToken();
  try {
    return await apiGet(url, token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    const refreshed = await refresh();
    return apiGet(url, refreshed.accessToken);
  }
}

/** The numeric user id, required by both merge-request queries. Fetched once and cached. */
async function ensureMe() {
  const { me } = await read('me');
  if (me) return me;
  const fresh = mapUser((await authorizedGet(userUrl())).body);
  await write({ me: fresh });
  return fresh;
}

function errorKind(error) {
  if (error instanceof AuthError) return error.terminal ? 'auth' : 'network';
  if (error instanceof ApiError) return error.kind;
  // `fetch` rejects with a TypeError when the machine is offline.
  return 'network';
}

/**
 * Records a failed poll without destroying the snapshot: the previous lists and `fetchedAt`
 * survive, so the popup keeps showing the last good state with a staleness notice
 * (design §6).
 */
async function setError(kind, message) {
  const { inbox } = await read('inbox');
  await write({
    inbox: {
      todos: inbox?.todos ?? [],
      reviews: inbox?.reviews ?? [],
      mine: inbox?.mine ?? [],
      truncated: inbox?.truncated ?? { todos: false, reviews: false, mine: false },
      fetchedAt: inbox?.fetchedAt ?? 0,
      error: { kind, message },
    },
  });
}

async function recordFailure(error) {
  const kind = errorKind(error);
  if (kind === 'auth') await signOut();
  if (kind === 'ratelimit') await write({ backoffUntil: Date.now() + RATELIMIT_BACKOFF_MS });
  await setError(kind, ERROR_MESSAGES[kind]);
}

/**
 * The badge is driven by the pending to-do count alone, so it matches the number GitLab shows
 * in its own header (design §3, §8). A network or rate-limit error leaves the last count
 * standing: it is still the best information available.
 */
async function applyBadge() {
  const { auth, inbox } = await read('auth', 'inbox');
  if (inbox?.error?.kind === 'auth') {
    await setBadge('!', BADGE_ERROR_COLOR);
    return;
  }
  if (!auth) {
    await setBadge('', BADGE_COLOR);
    return;
  }
  await setBadge(badgeText(inbox?.todos?.length ?? 0), BADGE_COLOR);
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setBadgeText({ text });
}

/**
 * Fetches all three lists and writes one snapshot. The three run concurrently and the
 * snapshot is written only if all three succeed, so the popup never sees a half-updated
 * state (design §7).
 *
 * `respectBackoff` is false only for a user-initiated refresh: design §7 pauses *alarms*
 * after a 429, and a button press is throttled separately.
 */
async function poll({ respectBackoff = true } = {}) {
  const { auth, backoffUntil } = await read('auth', 'backoffUntil');
  if (!auth) {
    await applyBadge();
    return;
  }
  if (respectBackoff && Date.now() < backoffUntil) return;

  try {
    const me = await ensureMe();
    const results = await Promise.allSettled([
      authorizedGet(todosUrl()),
      authorizedGet(reviewsUrl(me.id)),
      authorizedGet(mineUrl(me.id)),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;

    const [todos, reviews, mine] = results.map((result) => result.value);
    await write({
      inbox: {
        todos: todos.body.map(mapTodo),
        reviews: reviews.body.map(mapMr),
        mine: mine.body.map(mapMr),
        // A non-empty x-next-page means further pages exist; the popup says so rather than
        // silently showing a partial list (design §7).
        truncated: {
          todos: todos.nextPage !== '',
          reviews: reviews.nextPage !== '',
          mine: mine.nextPage !== '',
        },
        fetchedAt: Date.now(),
        error: null,
      },
      backoffUntil: 0,
    });
  } catch (error) {
    await recordFailure(error);
  }
  await applyBadge();
}

function ensureAlarm() {
  return chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
}

// Listeners are registered at module scope: the worker is ephemeral and this file re-runs
// every time the browser revives it, so registration must not sit behind any await
// (design §4).
chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await poll();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await poll();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) await poll();
});
```

- [ ] **Step 4: Add the `background` key to `manifest.json`**

Insert this line directly after the `"host_permissions"` entry:

```json
  "background": { "service_worker": "src/background.js", "type": "module" },
```

- [ ] **Step 5: Register the OAuth application and set `CLIENT_ID`**

At <https://gitlab.com/-/user_settings/applications> create the application with exactly these values:

- **Name:** `GitLab Inbox`
- **Redirect URI:** the `redirect` line printed in Task 1 Step 4 — `https://<extension-id>.chromiumapp.org/`, trailing slash included
- **Confidential:** unchecked
- **Scopes:** `read_api`, nothing else

Copy the resulting Application ID into `CLIENT_ID` in `src/config.js`.

- [ ] **Step 6: Reload the extension and confirm the worker starts clean**

In `chrome://extensions`, press Reload on GitLab Inbox, then click **service worker** to open its DevTools.

Expected: the console shows no errors. A red "Errors" button on the extension card means an import path is wrong — fix it before continuing.

- [ ] **Step 7: Confirm the redirect URI the extension will actually use**

In the service worker console:

```js
chrome.identity.getRedirectURL()
```

Expected: `https://<extension-id>.chromiumapp.org/`, byte-identical to what was registered in Step 5. A mismatch here is the single most common cause of `invalid_redirect_uri`.

- [ ] **Step 8: Sign in from the service worker console**

`auth.js` is already in the worker's module graph, so it can be imported by URL with no throwaway code:

```js
const auth = await import(chrome.runtime.getURL('src/auth.js'));
await auth.signIn();
```

Expected: a GitLab authorization window opens and asks to authorize GitLab Inbox for `read_api` and nothing more. After **Authorize**, the promise resolves to an object with `accessToken`, `refreshToken`, a future `expiresAt`, and `scope: 'read_api'`.

- [ ] **Step 9: Wait for a poll and inspect the snapshot**

The alarm was created at install, so a poll runs within a minute of signing in. (Chrome clamps an alarm's first fire to 30 seconds for an unpacked extension, so there is no way to make it fire instantly; the popup's refresh button, added in Task 6, becomes the fast path.) Then, in the service worker console:

```js
await chrome.storage.local.get(['me', 'inbox', 'backoffUntil'])
```

Expected: `me` holds a numeric `id` and your `username`; `inbox.error` is `null`; `inbox.fetchedAt` is a recent epoch; `inbox.todos`, `inbox.reviews` and `inbox.mine` are arrays whose contents match <https://gitlab.com/dashboard/todos> and <https://gitlab.com/dashboard/merge_requests> for the same account. Compare the to-do count exactly.

- [ ] **Step 10: Verify the badge**

Expected: the toolbar icon carries an orange `#E24329` badge showing the same number as `inbox.todos.length`, and no badge at all when that number is 0. Cross-check against the to-do count in GitLab's own header.

- [ ] **Step 11: Verify the token refresh path**

Make the stored token look stale, then ask for a token:

```js
const { auth } = await chrome.storage.local.get('auth');
await chrome.storage.local.set({ auth: { ...auth, expiresAt: Date.now() } });
const authMod = await import(chrome.runtime.getURL('src/auth.js'));
const token = await authMod.getAccessToken();
const stored = (await chrome.storage.local.get('auth')).auth;
console.log(
  'token is the stored one:', token === stored.accessToken,
  '| refresh token rotated:', stored.refreshToken !== auth.refreshToken,
);
```

Expected: `token is the stored one: true` and `refresh token rotated: true` — GitLab rotates the refresh token, and the new pair must be the one in storage. Then wait for the next alarm and confirm `inbox.error` is still `null`.

- [ ] **Step 12: Verify the terminal-auth path**

Corrupt both tokens so the next refresh gets `invalid_grant`:

```js
const { auth } = await chrome.storage.local.get('auth');
await chrome.storage.local.set({
  auth: { ...auth, accessToken: 'broken', refreshToken: 'broken', expiresAt: 0 },
});
```

Wait for the next alarm (up to a minute), then:

```js
await chrome.storage.local.get(['auth', 'inbox'])
```

Expected: `auth` is `null`; `inbox.error.kind` is `'auth'`; the earlier `todos`, `reviews`, `mine` arrays and `fetchedAt` are still present; the badge reads `!` on `#DB3B21`. Then repeat Step 8 and confirm the badge returns to the count.

- [ ] **Step 13: Run the full test suite**

Run: `npm test`

Expected: `# fail 0`. Nothing in this task is unit-tested, so this only proves nothing earlier was broken.

- [ ] **Step 14: Commit**

```bash
git add src/store.js src/auth.js src/background.js manifest.json src/config.js
git commit -m "feat: add the OAuth session and the polling service worker

The refreshed token pair is persisted before the pending call proceeds: GitLab
rotates refresh tokens, so losing that write loses the session (design 5.3).
A snapshot is written only when all three requests succeed, so the popup never
renders a half-updated inbox (design 7)."
```

---

### Task 6: The popup and the message protocol

The popup and `background.js`'s message handler are two halves of one protocol and land together. The popup never calls the GitLab API: it renders the snapshot already in storage, which is why it opens instantly and still works offline against the last good state (design §3).

**Files:**
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.css`
- Create: `src/popup/popup.js`
- Modify: `src/background.js` (add the `chrome.runtime.onMessage` handler and extend two imports)
- Modify: `manifest.json` (add `action.default_popup`)

**Interfaces:**
- Consumes: `src/store.js` (`read`, `write`, `onChanged`), `src/format.js` (`relativeTime`, `humaniseAction`), and `background.js`'s internal `poll`, `applyBadge`, `setError`, `ensureAlarm` from Task 5.
- Produces the message protocol — `chrome.runtime.sendMessage(message)` → response:
  - `{ type: 'signIn' }` → `{ ok: true }`, or a rejection carrying `{ ok: false, message }`
  - `{ type: 'signOut' }` → `{ ok: true }`
  - `{ type: 'refresh' }` → `{ ok: true }` or `{ ok: true, skipped: true }`
  - anything else → `{ ok: false, message: string }`

- [ ] **Step 1: Extend the two imports at the top of `src/background.js`**

`signIn` and `MANUAL_REFRESH_MIN_AGE_MS` are needed by the handler. Replace the first two import statements with:

```js
import {
  ALARM_NAME,
  ALARM_PERIOD_MINUTES,
  MANUAL_REFRESH_MIN_AGE_MS,
  RATELIMIT_BACKOFF_MS,
} from './config.js';
import { AuthError, getAccessToken, refresh, signIn, signOut } from './auth.js';
```

- [ ] **Step 2: Append the message handler to `src/background.js`**

Goes after the alarm listener, at the end of the file.

```js
/**
 * A user-initiated refresh. Doing nothing while the snapshot is fresh stops a repeatedly
 * clicked refresh button from becoming a request per click (design §7).
 */
async function refreshOnRequest() {
  const { inbox } = await read('inbox');
  if (inbox?.fetchedAt && Date.now() - inbox.fetchedAt < MANUAL_REFRESH_MIN_AGE_MS) {
    return { ok: true, skipped: true };
  }
  await poll({ respectBackoff: false });
  return { ok: true };
}

async function handleSignIn() {
  try {
    await signIn();
  } catch (error) {
    // The popup is gone by the time the authorization window takes focus, so the reason has
    // to survive in storage for the next time it opens (design §10).
    await setError(
      'auth',
      error instanceof AuthError ? error.message : 'Sign-in failed, please try again.',
    );
    await applyBadge();
    throw error;
  }
  // A previous session's snapshot and its error must not leak into the new one.
  await write({ inbox: null, backoffUntil: 0 });
  await ensureAlarm();
  await poll({ respectBackoff: false });
  return { ok: true };
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'signIn':
      return handleSignIn();
    case 'signOut':
      await signOut();
      await write({ inbox: null, backoffUntil: 0 });
      await applyBadge();
      return { ok: true };
    case 'refresh':
      return refreshOnRequest();
    default:
      return { ok: false, message: `Unknown message: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse, (error) =>
    sendResponse({ ok: false, message: error.message ?? String(error) }),
  );
  // Keeps the message channel open for the asynchronous sendResponse above.
  return true;
});
```

- [ ] **Step 3: Write `src/popup/popup.html`**

Everything static lives here and is toggled with the `hidden` attribute; only rows are built at runtime, from the `<template>`. No inline script and no inline handler — MV3's CSP forbids both (design §9).

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
    <title>GitLab Inbox</title>
  </head>
  <body>
    <section id="signin" class="signin" hidden>
      <p id="signin-error" class="strip strip-error" hidden></p>
      <p class="signin-lead">Sign in to see your GitLab to-dos and merge requests.</p>
      <button id="signin-button" type="button" class="primary">Sign in with GitLab</button>
    </section>

    <section id="main" hidden>
      <header class="header">
        <img id="avatar" class="avatar" alt="" width="24" height="24" />
        <span id="username" class="username"></span>
        <button id="refresh" type="button" class="icon-button" title="Refresh" aria-label="Refresh">
          &#x21bb;
        </button>
      </header>

      <nav id="tabs" class="tabs" role="tablist">
        <button type="button" class="tab" data-tab="todos" role="tab">
          To-dos <span class="count" data-count="todos"></span>
        </button>
        <button type="button" class="tab" data-tab="reviews" role="tab">
          Review <span class="count" data-count="reviews"></span>
        </button>
        <button type="button" class="tab" data-tab="mine" role="tab">
          Mine <span class="count" data-count="mine"></span>
        </button>
      </nav>

      <p id="warning" class="strip strip-warning" hidden></p>

      <div class="scroll">
        <div id="skeleton" class="skeleton" hidden>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
          <div class="skeleton-row"></div>
        </div>
        <ul id="list" class="list"></ul>
        <p id="empty" class="empty" hidden></p>
        <p id="truncated" class="truncated" hidden></p>
      </div>

      <footer class="footer">
        <span id="updated" class="updated"></span>
        <button id="signout" type="button" class="link">Sign out</button>
      </footer>
    </section>

    <template id="row-template">
      <li>
        <button type="button" class="row">
          <img class="row-avatar" alt="" width="20" height="20" />
          <span class="row-body">
            <span class="row-title">
              <span class="chip" hidden>Draft</span>
              <span class="row-title-text"></span>
            </span>
            <span class="row-meta"></span>
          </span>
        </button>
      </li>
    </template>

    <script type="module" src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Write `src/popup/popup.css`**

```css
:root {
  --bg: #ffffff;
  --fg: #1f1f1f;
  --muted: #6b6b6b;
  --border: #e3e3e3;
  --hover: #f5f5f5;
  --accent: #e24329;
  --warning-bg: #fdf3e7;
  --warning-fg: #8a5300;
  --error-bg: #fdecea;
  --error-fg: #b02a1a;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1f1f22;
    --fg: #ececef;
    --muted: #9a9aa2;
    --border: #34343a;
    --hover: #2a2a2f;
    --warning-bg: #3a2e19;
    --warning-fg: #f0c479;
    --error-bg: #3a201c;
    --error-fg: #f2a99c;
  }
}

* {
  box-sizing: border-box;
}

body {
  /* Fixed 380 px wide, content capped at 560 px tall with the list scrolling (design §9). */
  width: 380px;
  max-height: 560px;
  margin: 0;
  display: flex;
  flex-direction: column;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg);
  background: var(--bg);
}

/* Sign-in */

.signin {
  padding: 24px 20px;
  text-align: center;
}

.signin-lead {
  margin: 0 0 16px;
  color: var(--muted);
}

.primary {
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.primary:hover {
  filter: brightness(1.08);
}

/* Header */

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.avatar {
  border-radius: 50%;
  background: var(--hover);
}

.username {
  flex: 1;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-button {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}

.icon-button:hover {
  background: var(--hover);
  color: var(--fg);
}

/* Tabs */

.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}

.tab {
  flex: 1;
  padding: 8px 4px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.tab:hover {
  background: var(--hover);
}

.tab[aria-selected="true"] {
  color: var(--fg);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

.count {
  color: var(--muted);
  font-weight: 400;
}

/* Strips */

.strip {
  margin: 0;
  padding: 7px 12px;
  font-size: 12px;
}

.strip-warning {
  background: var(--warning-bg);
  color: var(--warning-fg);
}

.strip-error {
  background: var(--error-bg);
  color: var(--error-fg);
  border-radius: 6px;
  margin-bottom: 12px;
  text-align: left;
}

/* List */

.scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 120px;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.row:hover {
  background: var(--hover);
}

.row-avatar {
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--hover);
}

.row-body {
  min-width: 0;
  flex: 1;
}

.row-title {
  display: flex;
  align-items: center;
  gap: 5px;
}

.row-title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--hover);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.row-meta {
  display: block;
  color: var(--muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty,
.truncated {
  margin: 0;
  padding: 20px 12px;
  color: var(--muted);
  text-align: center;
}

.truncated {
  padding: 8px 12px;
  font-size: 11px;
}

/* Skeleton */

.skeleton {
  padding: 9px 12px;
}

.skeleton-row {
  height: 34px;
  margin-bottom: 8px;
  border-radius: 4px;
  background: var(--hover);
}

/* Footer */

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
}

.link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--muted);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.link:hover {
  color: var(--fg);
}
```

- [ ] **Step 5: Write `src/popup/popup.js`**

```js
import { humaniseAction, relativeTime } from '../format.js';
import { onChanged, read, write } from '../store.js';

const TABS = ['todos', 'reviews', 'mine'];

const EMPTY_MESSAGES = {
  todos: 'No pending to-dos.',
  reviews: 'Nothing is waiting on your review.',
  mine: 'You have no open merge requests.',
};

const byId = (id) => document.getElementById(id);
const rowTemplate = byId('row-template');

let state = null;

/**
 * Fire-and-forget: the popup is destroyed the moment the browser opens the authorization
 * window or a new tab, so the reply frequently never arrives. Every outcome the user needs to
 * see is written to storage by the worker instead (design §10).
 */
function send(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function renderSignIn(inbox) {
  const message = inbox?.error?.kind === 'auth' ? inbox.error.message : '';
  const strip = byId('signin-error');
  strip.textContent = message;
  strip.hidden = message === '';
}

function renderHeader(me) {
  byId('avatar').src = me?.avatarUrl ?? '';
  byId('username').textContent = me?.username ? `@${me.username}` : '';
}

function renderTabs(inbox, activeTab) {
  for (const tab of TABS) {
    document
      .querySelector(`.tab[data-tab="${tab}"]`)
      .setAttribute('aria-selected', String(tab === activeTab));
    document.querySelector(`.count[data-count="${tab}"]`).textContent = inbox
      ? String(inbox[tab]?.length ?? 0)
      : '';
  }
}

function metaFor(item, tab) {
  const parts =
    tab === 'todos'
      ? [
          humaniseAction(item.actionName),
          item.project,
          item.authorName,
          relativeTime(item.createdAt),
        ]
      : [item.reference, item.authorName, relativeTime(item.updatedAt)];
  return parts.filter(Boolean).join(' · ');
}

/**
 * Builds one row from the template. Titles come from the API, so every insertion goes through
 * textContent — never innerHTML.
 */
function buildRow(item, tab) {
  const node = rowTemplate.content.firstElementChild.cloneNode(true);
  const button = node.querySelector('.row');

  const avatar = button.querySelector('.row-avatar');
  avatar.src = item.authorAvatar ?? '';
  avatar.alt = item.authorName ?? '';

  button.querySelector('.chip').hidden = item.draft !== true;
  button.querySelector('.row-title-text').textContent = item.title;
  button.querySelector('.row-meta').textContent = metaFor(item, tab);
  button.title = item.title;

  button.addEventListener('click', () => {
    if (item.url) chrome.tabs.create({ url: item.url });
    window.close();
  });

  return node;
}

function renderList(inbox, activeTab) {
  const warning = byId('warning');
  const empty = byId('empty');
  const truncated = byId('truncated');

  // No poll has ever succeeded: show the skeleton rather than three empty lists (design §9).
  const noSnapshot = inbox === null;
  byId('skeleton').hidden = !noSnapshot;
  byId('list').hidden = noSnapshot;
  warning.hidden = true;
  empty.hidden = true;
  truncated.hidden = true;

  if (noSnapshot) {
    byId('list').replaceChildren();
    return;
  }

  if (inbox.error) {
    warning.textContent = inbox.error.message;
    warning.hidden = false;
  }

  const items = inbox[activeTab] ?? [];
  byId('list').replaceChildren(...items.map((item) => buildRow(item, activeTab)));

  if (items.length === 0) {
    empty.textContent = EMPTY_MESSAGES[activeTab];
    empty.hidden = false;
  } else if (inbox.truncated?.[activeTab]) {
    truncated.textContent = `Showing the first ${items.length}. Open GitLab for the rest.`;
    truncated.hidden = false;
  }
}

function renderFooter(inbox) {
  byId('updated').textContent = inbox?.fetchedAt ? `updated ${relativeTime(inbox.fetchedAt)}` : '';
}

function render() {
  const { auth, me, inbox, ui } = state;
  // A dead session renders as the sign-in screen even though `auth` was already cleared
  // (design §9, state 5).
  const signedIn = auth !== null && inbox?.error?.kind !== 'auth';

  byId('signin').hidden = signedIn;
  byId('main').hidden = !signedIn;

  if (!signedIn) {
    renderSignIn(inbox);
    return;
  }

  const activeTab = TABS.includes(ui?.activeTab) ? ui.activeTab : 'todos';
  renderHeader(me);
  renderTabs(inbox, activeTab);
  renderList(inbox, activeTab);
  renderFooter(inbox);
}

async function load() {
  state = await read();
  render();
}

byId('signin-button').addEventListener('click', () => send({ type: 'signIn' }));
byId('refresh').addEventListener('click', () => send({ type: 'refresh' }));
byId('signout').addEventListener('click', () => send({ type: 'signOut' }));

byId('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab')?.dataset.tab;
  if (!tab) return;
  state.ui = { activeTab: tab };
  render();
  // Persisted so reopening the popup lands where the user left it (design §9).
  write({ ui: state.ui });
});

// The worker writes the snapshot from an alarm that can fire while the popup is open, so
// rendering follows storage rather than the message replies.
onChanged(() => load());

load();
```

- [ ] **Step 6: Add `default_popup` to `manifest.json`**

Replace the `action` block with:

```json
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": { "16": "icons/16.png", "32": "icons/32.png" }
  },
```

- [ ] **Step 7: Verify the signed-out state**

In the service worker console, clear the session, then reload the extension and open the popup:

```js
await chrome.storage.local.set({ auth: null, me: null, inbox: null, backoffUntil: 0 });
```

Expected: state 1 — the lead sentence and a single "Sign in with GitLab" button, 380 px wide, no error strip, and no badge on the icon.

- [ ] **Step 8: Verify sign-in through the popup**

Click "Sign in with GitLab".

Expected: the popup closes, the GitLab authorization window opens, and after **Authorize** the badge appears within a second or two. Reopen the popup: the header shows your avatar and `@username`, the To-dos tab is active with a count, and the footer reads "updated just now".

- [ ] **Step 9: Verify all three lists against GitLab**

Compare each tab against the equivalent GitLab page:

- To-dos ↔ <https://gitlab.com/dashboard/todos>
- Review ↔ GitLab's **Merge requests ▸ Review requests**
- Mine ↔ GitLab's **Merge requests ▸ Assigned to you**, filtered to ones you authored

Expected: the same items, in the same order (most recently updated first on the two MR tabs). Each MR row shows `group/project!123`, an author and a relative time; each to-do row shows the humanised action, the project path, an author and a relative time. Draft MRs carry a Draft chip and their title does **not** begin with "Draft:".

- [ ] **Step 10: Verify tab persistence, row clicks and the empty state**

Switch to the Mine tab, close the popup, reopen it. Expected: it opens on Mine.

Click any row. Expected: the target opens in a new tab and the popup closes.

Expected for whichever of the three lists is genuinely empty: the matching message from `EMPTY_MESSAGES`, not a blank panel.

- [ ] **Step 11: Verify the skeleton and the stale-snapshot warning**

Skeleton (state 2), from the service worker console:

```js
await chrome.storage.local.set({ inbox: null });
```

Open the popup. Expected: three grey placeholder rows, empty tab counts, no error strip.

Stale snapshot (state 4): let a poll succeed, then go offline (service worker DevTools ▸ Network ▸ Offline, or disable the network adapter) and wait for the next alarm.

Expected: the popup still lists the last known items, an amber strip reads "GitLab is unreachable. Showing the last known state.", the footer age keeps growing, and the badge keeps the previous count. Coming back online clears the strip on the next alarm.

- [ ] **Step 12: Verify sign-out**

Click "Sign out".

Expected: the popup closes, the badge disappears, reopening the popup shows the sign-in button, and `chrome.storage.local.get(['auth', 'me', 'inbox'])` reports `auth: null`, `me: null`, `inbox: null`.

- [ ] **Step 13: Verify the manual-refresh throttle**

Sign in, then press the refresh button twice within a few seconds while watching the service worker's Network tab.

Expected: the first press issues three API requests; the second issues none, because the snapshot is younger than 30 seconds. After 30 seconds a press issues three again.

- [ ] **Step 14: Confirm the popup has no inline script or handler**

```bash
grep -nE 'on[a-z]+="|javascript:' src/popup/popup.html
grep -n '<script' src/popup/popup.html
```

Expected: the first grep prints nothing; the second prints exactly one line, the `<script type="module" src="popup.js">` tag.

- [ ] **Step 15: Run the full test suite**

Run: `npm test`

Expected: `# fail 0`.

- [ ] **Step 16: Commit**

```bash
git add src/popup manifest.json src/background.js
git commit -m "feat: add the popup and the popup-to-worker message protocol

The popup renders from chrome.storage.local and never calls the API, so it
paints instantly and still shows the last good snapshot offline (design 3).
Rows are cloned from a template and filled with textContent: merge request
titles are attacker-influenced text."
```

---

### Task 7: Manual browser checklist and the finished README

The last gate. Everything browser-dependent — the OAuth redirect, alarms, badge rendering, popup layout — is covered by a written checklist run in both Chrome and Edge, because none of it is reachable from `node --test` (design §12).

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing further depends on this task.

- [ ] **Step 1: Fill in the real extension ID throughout `README.md`**

Replace every `PASTE_THE_ID` placeholder with the actual ID from Task 1 Step 4, in both the plain form and inside the redirect URI.

```bash
grep -n "PASTE_" README.md manifest.json src/config.js
```

Expected: no output. A hit in `manifest.json` means the `key` was never pasted; a hit in `src/config.js` means the Application ID was never pasted — either one is a bug, not a to-do.

- [ ] **Step 2: Append the architecture and checklist sections to `README.md`**

````markdown
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
````

- [ ] **Step 3: Walk the checklist in Chrome**

Work through every box in Chrome. Fix what fails, re-run `npm test` after any code change, and commit each fix separately with its own message.

- [ ] **Step 4: Walk the checklist in Edge**

Repeat in Edge (`edge://extensions`). The ID and redirect URI must be identical to Chrome's, and the same Application ID applies. Pay particular attention to `chrome.identity.launchWebAuthFlow` and `chrome.action.setBadgeTextColor`, the two APIs most likely to differ.

- [ ] **Step 5: Final verification sweep**

```bash
npm test
grep -n "chrome\." src/pkce.js src/gitlab.js src/format.js
grep -rn "gitlab\.com" src --include=*.js | grep -v "^src/config.js"
grep -rn "PASTE_" src manifest.json README.md
git status --short
```

Expected: `# fail 0`; all three greps print nothing; `git status` shows nothing unintended. A hit in the second grep means the host leaked out of `config.js`; a hit in the third means a placeholder was committed.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document the architecture and the manual browser checklist

node --test covers the pure modules only; the OAuth redirect, alarms, badge and
popup layout are reachable only from a real browser, so they get a written
checklist run in both Chrome and Edge (design 12)."
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task:

| Spec section | Task |
|---|---|
| §1 purpose, §2 non-goals | Task 1 and Task 7 README |
| §3 decisions | Encoded throughout; each is cited in the comment that depends on it |
| §4 architecture, §4.1 module boundaries | File Structure table; the `chrome.*` grep gates in Tasks 2, 3, 4, 7 |
| §5.1 registration, pinned ID | Task 1 Steps 4, 8, 11, 12; Task 5 Steps 5, 7; Task 7 Step 1 |
| §5.2 sign-in flow | Task 5 Step 2 (`signIn`), verified Task 5 Step 8, Task 6 Step 8 |
| §5.3 refresh, single-flight, rotation | Task 5 Step 2 (`refresh`, `performRefresh`), verified Steps 11, 12 |
| §6 storage schema | Task 5 Step 1 (`SCHEMA_DEFAULTS`), Step 3 (`setError` preserves the lists) |
| §6 view shapes | Task 4 Step 4 (`mapTodo`, `mapMr`), asserted in Step 2 |
| §7 three requests, `scope=all`, truncation | Task 4 (URLs, `nextPage`), Task 5 Step 3 (`poll`) |
| §7 extra poll triggers | Task 5 Step 3 (`onInstalled`, `onStartup`, `onAlarm`), Task 6 Step 2 (sign-in, refresh) |
| §8 badge | Task 3 (`badgeText`), Task 5 Step 3 (`applyBadge`), verified Steps 10, 12 |
| §9 popup, five states | Task 6 Steps 3-5; the states verified in Steps 7, 8, 10, 11 |
| §10 error handling | Task 4 (`errorKindForStatus`), Task 5 Step 3 (`authorizedGet` retry, `recordFailure`), Task 6 Step 2 (sign-in failure) |
| §11 manifest | Task 1 Step 8, Task 5 Step 4, Task 6 Step 6 |
| §11 icons | Task 1 Steps 5-7 |
| §12 testing | Tasks 2, 3, 4 for the units; Task 7 for the checklist |
| §13 file layout | File Structure table, with the root mapping and `format.js` recorded under Deviations |
| §14 one-time user setup | Task 1 Step 10 README, completed in Task 7 Step 1 |

No gaps found.

**Placeholder scan.** Two intentional placeholders exist, and both are gated:
`PASTE_THE_BASE64_KEY_FROM_STEP_4` and `PASTE_YOUR_APPLICATION_ID_HERE` are values only the
operator can supply; they are filled in Task 1 Step 8 and Task 5 Step 5, and Task 7 Steps 1
and 5 fail the build if either survives. Every code step carries the actual code. No step says
"add error handling", "handle edge cases", or "similar to Task N".

**Type consistency.** Checked across tasks. `badgeText`, `relativeTime` and `humaniseAction`
(Task 3) are imported under exactly those names by Tasks 5 and 6. `apiGet` returns
`{ body, nextPage }` in Task 4 and is destructured that way in Task 5's `poll`. `ApiError`
exposes `status` and `kind` in Task 4, and both are read by Task 5's `authorizedGet` and
`errorKind`. `AuthError.terminal` is set in Task 5 Step 2 and read in Step 3 and Task 6
Step 2. `read`/`write`/`onChanged`/`SCHEMA_DEFAULTS` (Task 5 Step 1) are the only storage
entry points used anywhere. The message types `signIn`/`signOut`/`refresh` match between Task
6 Step 2's `handleMessage` and Step 5's `send` calls. `setError`, `applyBadge`, `ensureAlarm`
and `poll` are defined in Task 5 Step 3 and called from the code Task 6 Step 2 appends to the
same file. The tab keys `todos`/`reviews`/`mine` are identical in the storage schema, the poll
writer, the popup's `TABS` and `EMPTY_MESSAGES`, and the `data-tab`/`data-count` attributes.
