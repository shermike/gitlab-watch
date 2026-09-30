# GitLab Inbox — Design

Date: 2026-09-09
Status: approved, ready for implementation planning

## 1. Purpose

A browser extension (Chrome and Microsoft Edge, one codebase) that keeps a single
GitLab.com account's review workload visible without opening GitLab:

- a badge on the toolbar icon showing the work waiting on the user: pending to-dos plus
  the merge requests awaiting their review;
- a popup with three read-only lists: pending to-dos, merge requests awaiting the
  user's review, and the user's own open merge requests.

## 2. Non-goals for v1

Explicitly out of scope. Each is a separate, later iteration:

- marking a to-do as done from the popup (would require the full `api` scope);
- OS-level desktop notifications;
- self-hosted GitLab instances (the host is a single constant, easy to change,
  but only `https://gitlab.com` is targeted and tested);
- more than one account at a time;
- issues, pipelines, or any list beyond the three named above;
- publishing to the Chrome Web Store or Edge Add-ons (loaded unpacked).

## 3. Decisions and their rationale

| Decision | Rationale |
|---|---|
| OAuth2 with PKCE, not a Personal Access Token | No secret to copy by hand, no expiry surprise; GitLab.com allows user-owned OAuth applications, so no instance admin is needed. |
| `read_api` scope | The extension only reads. A stolen token cannot modify anything. |
| Vanilla ES modules, no build step | Edit a file, press Reload in `chrome://extensions`, done. No `node_modules`, no toolchain to maintain for a ~700-line personal tool. |
| Badge counts pending to-dos plus requested reviews | A to-do can be dismissed while the review it announced is still undone, and an unreviewed MR blocks someone else — so the badge keeps counting it until the request is gone. `mine` stays out: one's own open MRs are never all closed, and a badge that never reaches zero stops being a signal. |
| The popup never calls the GitLab API | A popup lives for a fraction of a second. Data is already in `chrome.storage.local`, so the popup renders instantly and works offline against the last snapshot. |
| No options page | Its only contents would be sign-out and an account line. Both fit in the popup footer. Dropped as unnecessary surface. |
| Extension ID pinned via the manifest `key` field | Chrome and Edge derive the extension ID from `key`; without it the two browsers generate different IDs, and the OAuth redirect URI would differ per browser. |

## 4. Architecture

Three runtime pieces, no shared mutable state between them other than
`chrome.storage.local`:

```
              chrome.alarms (60 s)
                      |
                      v
   +--------------------------------------+
   |  service worker  (background.js)     |
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
   |  popup  (popup.js)                   |
   |  - reads the snapshot, renders tabs  |
   |  - asks the worker to refresh        |
   |  - opens web_url in a new tab        |
   +--------------------------------------+
```

The service worker is ephemeral: Chrome terminates it after roughly 30 seconds of
inactivity and revives it when an alarm fires or the popup sends a message.
Therefore no state lives in worker module scope except the in-flight refresh promise
described in section 5.3.

### 4.1 Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `config.js` | Host, client id, scope, alarm period, page sizes. Constants only. | — |
| `pkce.js` | Random verifier, S256 challenge, random `state`. Pure; Web Crypto only. | — |
| `gitlab.js` | Builds request URLs; performs authenticated `fetch`; maps raw JSON to the view shapes in section 6. Knows nothing about storage or `chrome.*`. | `config.js` |
| `auth.js` | The PKCE dance, token exchange, refresh, sign-out. Owns the `auth` storage key. | `config.js`, `pkce.js`, `store.js` |
| `store.js` | Read/write helpers over `chrome.storage.local`. | — |
| `background.js` | Alarm wiring, poll orchestration, badge, message handling. | all of the above |
| `popup/popup.js` | Rendering and tab state. Reads storage, sends messages. Never calls `gitlab.js`. | `store.js` |

`pkce.js` and `gitlab.js` must not reference `chrome.*`. That is what makes them
testable under `node --test` (section 12).

## 5. Authentication

### 5.1 Registration (one-time, manual)

The user creates a user-owned application at
`https://gitlab.com/-/user_settings/applications`:

- Name: GitLab Inbox
- Redirect URI: `https://<extension-id>.chromiumapp.org/`
- Confidential: **unchecked** (a browser extension cannot keep a secret)
- Scopes: `read_api`

The resulting Application ID is not a secret and is committed in `config.js`.
There is no client secret.

The extension ID is fixed by generating an RSA-2048 keypair once and placing the
base64 DER-encoded public key in the manifest's `key` field. The ID is derived from
that key identically by Chrome and Edge, so a single redirect URI covers both. The
implementation must verify the ID actually matches in both browsers after loading;
if they differ for any reason, GitLab accepts several newline-separated redirect
URIs and both are registered.

At runtime the redirect URI is obtained from `chrome.identity.getRedirectURL()`
rather than hard-coded, so the registered value and the used value cannot drift.

### 5.2 Sign-in flow

1. `pkce.js` generates a 64-byte random `code_verifier` (base64url, 86 characters,
   within the 43-128 required by RFC 7636) and a 32-byte random `state`.
2. `code_challenge = base64url(SHA-256(ascii(code_verifier)))`, method `S256`.
3. `chrome.identity.launchWebAuthFlow({ interactive: true, url })` where `url` is
   `https://gitlab.com/oauth/authorize` with `client_id`, `redirect_uri`,
   `response_type=code`, `state`, `scope=read_api`, `code_challenge`,
   `code_challenge_method=S256`.
4. On return, the `state` in the callback URL is compared against the generated one;
   a mismatch aborts with an error and no token is stored.
5. `POST https://gitlab.com/oauth/token`, `application/x-www-form-urlencoded`, with
   `client_id`, `code`, `grant_type=authorization_code`, `redirect_uri`,
   `code_verifier`. No client secret.
6. The response (`access_token`, `refresh_token`, `expires_in` — 7200 on GitLab.com)
   is stored, with `expiresAt` computed as `Date.now() + expires_in * 1000`.
7. `GET /api/v4/user` runs once and its `id` is cached; the numeric id is required
   for the merge-request queries in section 7.

### 5.3 Refresh

Checked lazily before every API call, never on a timer. A token is considered stale
300 seconds before `expiresAt`, so a request never starts with a token that could
expire mid-flight.

`POST /oauth/token` with `grant_type=refresh_token`, `refresh_token`, `client_id`,
`redirect_uri`. GitLab **rotates** refresh tokens: the response carries a new
`refresh_token` and the old one is immediately invalid, so the new pair must be
persisted before the pending API call proceeds. Losing this write loses the session.

The worker may have several requests in flight. `auth.js` keeps a module-level
promise for an in-progress refresh and returns it to concurrent callers, so exactly
one refresh request is ever outstanding. Because the worker can be terminated
between calls, this is an optimisation, not a correctness guarantee; a duplicated
refresh after a worker restart invalidates the older token and the next call
refreshes again.

A failed refresh (HTTP 400 `invalid_grant`) means the session is unrecoverable:
`auth` is cleared, the badge shows `!`, and the popup falls back to the sign-in
screen.

## 6. Storage schema

Single area: `chrome.storage.local`.

```js
{
  auth: {
    accessToken: string,
    refreshToken: string,
    expiresAt: number,        // ms since epoch
    scope: string
  } | null,

  me: { id, username, name, avatarUrl, webUrl } | null,

  inbox: {
    todos:   Todo[],
    reviews: Mr[],
    mine:    Mr[],
    truncated: { todos: boolean, reviews: boolean, mine: boolean },
    fetchedAt: number,        // ms since epoch, of the last fully successful poll
    error: null | { kind: 'auth' | 'network' | 'ratelimit' | 'unknown', message: string }
  },

  ui: { activeTab: 'todos' | 'reviews' | 'mine' },

  readIds: { [todoId: string]: true },  // hidden from the To-dos list and the badge

  backoffUntil: number        // ms since epoch; polls are skipped before this
}
```

View shapes, mapped in `gitlab.js` so the popup never sees raw API JSON:

```js
Todo = { id, title, url, project, actionName, authorName, authorAvatar, createdAt }
Mr   = { id, title, url, reference, authorName, authorAvatar, reviewerNames, reviewerAvatar,
         updatedAt, draft }
```

`reviewerNames` are the names of the MR's reviewers in the order GitLab lists them, and
`reviewerAvatar` is the first reviewer's avatar, `''` when there is none. Both come from the
list response's `reviewers` array, with no extra request.

`reference` comes from the API's `references.full` (`group/project!123`), which gives
the project path and the MR number in one field with no extra request.

`inbox` is replaced wholesale on a successful poll. On a failed poll the previous
`todos` / `reviews` / `mine` and `fetchedAt` are preserved and only `error` is set,
so the popup keeps showing the last good snapshot with a staleness notice.

`readIds` covers to-dos only. The other two lists mirror live GitLab state — an open
merge request is still open whether or not it has been looked at — so there is nothing
there for a read mark to mean. Every successful poll prunes the map to the to-dos the new
snapshot still holds, so it cannot grow without bound and a reused id cannot hide a to-do
the user never saw. It is cleared on sign-in and sign-out with the rest of the session.

## 7. Polling

Triggered by `chrome.alarms` with `periodInMinutes: 1` (the minimum Manifest V3
permits), and additionally on `runtime.onStartup`, `runtime.onInstalled`, on
completion of sign-in, and on an explicit refresh message from the popup when the
snapshot is older than 30 seconds.

Three requests per poll, all with `Authorization: Bearer <token>`:

| List | Request |
|---|---|
| Pending to-dos | `GET /api/v4/todos?state=pending&per_page=100` |
| Awaiting my review | `GET /api/v4/merge_requests?scope=all&state=opened&reviewer_id=<me.id>&order_by=updated_at&sort=desc&per_page=50` |
| My open MRs | `GET /api/v4/merge_requests?scope=all&state=opened&author_id=<me.id>&order_by=updated_at&sort=desc&per_page=50` |

`scope=all` is required; without it `/merge_requests` returns only MRs the user
created. The three run concurrently via `Promise.allSettled`; a snapshot is written
only if all three succeed, so the popup never shows a half-updated state.

Pagination is deliberately not implemented. The first page is the whole list for any
realistic personal workload. Truncation is detected from the `x-next-page` response
header, which GitLab leaves non-empty when further pages exist; when it is set, the
mapped list carries `truncated: true` and the popup shows "showing first N" rather
than silently lying.

GitLab.com allows 2000 authenticated API requests per minute per user. Three per
minute leaves the limit irrelevant.

## 8. Badge

Driven by the pending to-dos that are not marked read, plus `inbox.reviews`, and by
`inbox.error`. A to-do pointing at an MR that is already in the review list is not
counted a second time — GitLab raises a `review_requested` to-do for the same MR, and
one piece of work must show as one. The comparison ignores the URL fragment, so a to-do
raised by a comment collapses into the MR it was left on.

| State | Text | Background |
|---|---|---|
| Not signed in | empty | — |
| Nothing waiting | empty | — |
| 1-99 | the number | `#E24329` |
| more than 99 | `99+` | `#E24329` |
| `error.kind === 'auth'` | `!` | `#DB3B21` |

A network or rate-limit error does not change the badge: the last known count stays,
because it is still the best information available.

## 9. Popup

Fixed 608 px wide, content capped at 560 px tall with the list scrolling.

- Header: avatar, `@username`, a refresh button.
- Three tabs with per-tab counts; the To-dos count excludes the to-dos marked read. The
  active tab is persisted in `ui.activeTab`, so reopening the popup lands where the user
  left it.
- A row leads with what it asks of the user: for a to-do the action ("Review requested"),
  for a merge request its title, one line and ellipsised. Muted underneath: the project
  path or `reference`, the author, and a relative timestamp ("20 min ago"). On the Mine tab
  the author is always the user, so the reviewers take the author's place — comma-separated,
  "No reviewers" when there are none — and the avatar is the first reviewer's. A to-do's own
  subject is in the row's tooltip, since the action has the lead line. Draft MRs carry a
  Draft chip.
- Clicking a row calls `chrome.tabs.create({ url })` and closes the popup. On the To-dos
  tab it also marks the to-do read, and an eye button at the right of the row marks it read
  without opening it; the other two tabs carry no such button.
- That message is the one the popup awaits before closing itself. Every other message it
  sends is fire-and-forget, but a message still in flight when the popup's context is
  destroyed never reaches the worker, and the mark would be lost.
- Read is local and one-way: `read_api` cannot resolve a to-do in GitLab (§2), so the mark
  only hides the to-do here, for as long as it stays in the snapshot.
- Footer: "updated N s ago" and a sign-out link.

States that must be handled explicitly, each with its own rendering:

1. not signed in — a single "Sign in with GitLab" button;
2. signed in, no snapshot yet — a skeleton;
3. snapshot present, list empty — a per-tab empty message;
4. snapshot present, `error` set — the list plus a warning strip naming the failure;
5. `error.kind === 'auth'` — the sign-in button, as in state 1.

Manifest V3's content security policy forbids inline scripts and inline event
handlers; all popup behaviour lives in `popup.js` and is attached with
`addEventListener`.

## 10. Error handling

| Condition | Response |
|---|---|
| HTTP 401 on an API call | Refresh once, retry the call once. Still 401: clear `auth`, set `error.kind = 'auth'`, badge `!`. |
| HTTP 429 | Keep the previous snapshot, set `error.kind = 'ratelimit'`, set `backoffUntil = now + 5 min`. Alarms that fire before that time return immediately. |
| HTTP 5xx | Treated as `network`. Keep the snapshot; the next alarm retries. |
| `fetch` rejects (offline) | `error.kind = 'network'`. Keep the snapshot. |
| Refresh returns `invalid_grant` | Same as the terminal 401 case. |
| `state` mismatch after the auth redirect | Abort, store nothing, surface "Sign-in failed, please try again". |

No retry loops beyond the single 401 retry. The 60-second alarm is the retry
mechanism, and it costs nothing.

## 11. Manifest

```json
{
  "manifest_version": 3,
  "name": "GitLab Inbox",
  "version": "0.1.0",
  "description": "Pending GitLab to-dos and merge requests on your toolbar.",
  "key": "<base64 DER RSA public key>",
  "permissions": ["storage", "alarms", "identity"],
  "host_permissions": ["https://gitlab.com/*"],
  "background": { "service_worker": "src/background.js", "type": "module" },
  "action": { "default_popup": "src/popup/popup.html", "default_icon": { "16": "icons/16.png", "32": "icons/32.png" } },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

`tabs` is not requested: `chrome.tabs.create` with a URL works without it.
`identity` is required for `launchWebAuthFlow` and is supported in Edge.

Icons are a neutral inbox glyph in GitLab's orange, drawn as one SVG and exported to
the four PNG sizes. GitLab's own logo is deliberately not used, to avoid shipping a
trademark in a personal tool.

## 12. Testing

`node --test test/` with no dependencies, covering only the pure modules:

1. `pkce.js` against the RFC 7636 Appendix B vector — verifier
   `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` must yield challenge
   `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`;
2. `pkce.js` verifier length and alphabet;
3. `gitlab.js` URL builders — exact query strings for all three requests;
4. `gitlab.js` response mapping — raw fixture JSON to the `Todo` / `Mr` shapes,
   including a to-do whose `target` is null;
5. badge text formatting — 0 to empty, 7 to `7`, 150 to `99+`;
6. relative-time formatting boundaries;
7. the badge count over a snapshot — read marks, and an MR that a to-do also points at.

Node 18+ exposes `crypto.subtle` and `fetch` as globals, so these modules run
unmodified outside the browser. That is the reason for the `chrome.*` ban in
section 4.1.

Everything browser-dependent — the OAuth redirect, alarms, badge rendering, popup
layout — is covered by a manual checklist in `README.md`, run in both Chrome and
Edge before the version is considered done.

## 13. File layout

```
gitlab-inbox/
  manifest.json
  icons/            16.png 32.png 48.png 128.png, plus the source icon.svg
  src/
    config.js
    pkce.js
    gitlab.js
    auth.js
    store.js
    background.js
    popup/
      popup.html
      popup.css
      popup.js
  test/
    pkce.test.js
    gitlab.test.js
    format.test.js
    fixtures/
  docs/
    2026-09-09-gitlab-inbox-design.md
  README.md
```

## 14. One-time setup by the user

1. Load `gitlab-inbox/` unpacked in `chrome://extensions` (Developer mode on).
2. Confirm the extension ID matches the one the `key` field pins.
3. Create the OAuth application at `https://gitlab.com/-/user_settings/applications`
   with the values in section 5.1.
4. Paste the Application ID into `src/config.js`.
5. Reload the extension, open the popup, sign in.
6. Repeat steps 1-2 in Edge (`edge://extensions`); the same Application ID applies.
