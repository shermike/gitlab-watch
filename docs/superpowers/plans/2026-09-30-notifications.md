# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the To-dos tab into a Notifications feed that holds the pending to-dos plus eight kinds of merge-request events the extension derives by comparing one poll with the next.

**Architecture:** After the existing snapshot is written, the service worker hands the snapshot, the stored `watch` map and an authenticated `get` function to a new pure module, `src/events.js`. It decides which merge requests changed, fetches their notes (and, for replies, their discussions), classifies each new note, looks up merge requests that left the `mine` list, and returns the next `watch` plus the new events. The worker stores both; the popup merges unread to-dos and unread events into one feed; the badge counts both.

**Tech Stack:** Vanilla ES modules, no build step, no dependencies. `node --test` for unit tests. Manifest V3 service worker, `chrome.storage.local`.

**Spec:** `docs/2026-09-30-notifications-design.md` (extends `docs/2026-09-09-gitlab-inbox-design.md`). Read both before starting.

## Global Constraints

- **Branch:** all work happens on `feat/notifications`, branched off `main`. Never commit to `main`.
- **English only** in every artefact: identifiers, comments, log and error messages, commit messages, test names, docs.
- **Comments.** Data declarations (constants, schema fields) get a comment stating what the datum means. Exported functions keep a doc comment stating their contract. **No comments inside function bodies.** A comment never narrates the change ("now", "no longer", "used to"); it cites the spec section instead, as `notifications design §4.2` or `design §7`.
- **`src/events.js`, `src/gitlab.js`, `src/format.js` must not reference `chrome.`** — they run under `node --test`. `src/store.js` touches `chrome.*` only inside its storage functions.
- **Tests:** `npm test` (runs `node --test test/**/*.test.js`). Every task ends with the full suite green.
- **Constants, verbatim from the spec:** notes page `per_page=100`; discussions `per_page=100`, at most 5 pages; `events` at most 100 entries and none older than 14 days; excerpt 200 characters.
- **Scope stays `read_api`.** No new manifest permissions.
- **Commit style:** Conventional Commits, as in `git log` (`feat:`, `test:`, `docs:`, `fix:`).

## Review Focus

1. **Upgrading from the shipped version.** Storage holds `ui.activeTab: 'todos'` and no `watch` / `events` keys. The popup must open on Notifications and the first poll must baseline, not flood. Pinned by `resolveTab` tests in Task 3 and the baseline test in Task 4.
2. **A to-do that arrives one poll after the event for the same note.** The event must not show twice. Pinned by the `notificationFeed` and `badgeCount` coverage tests in Task 3.
3. **The user merges or closes their own MR, or GitLab omits who did it.** Own action: no event. Unknown actor: an event with an empty actor name, not a dropped event. Pinned in Task 5.
4. **A merge request that is both authored by and assigned for review to the user.** Author role wins and it is watched once. Pinned in Task 4.
5. **Signing out while a poll is in flight.** `watch` and `events` must not reappear after the reset. Guarded in Task 8 and pinned by a manual checklist item in Task 10.

---

### Task 1: Verify the spec's assumption against gitlab.com

**Why first:** spec §8 relies on approvals, revoked approvals and requested changes moving a merge request's `updated_at`, and §4.3 relies on GitLab's system-note wording. Both are checked here before any code depends on them. **This task needs the user**: only they can act on a merge request.

**Files:**
- Create: `scripts/inspect-mr.mjs`
- Modify: `docs/2026-09-30-notifications-design.md` (§8, the "Assumption to verify" paragraph)

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/notifications main
git add docs/2026-09-30-notifications-design.md docs/superpowers/plans/2026-09-30-notifications.md
git commit -m "docs: add the notifications design and implementation plan"
```

- [ ] **Step 2: Write the inspection script**

`scripts/inspect-mr.mjs`:

```js
// Prints one merge request's updated_at, user_notes_count and its ten newest notes, so the
// notifications design's §8 assumption and §4.3 wording can be checked against gitlab.com.
// Author names are not printed: the output is meant to be pasted into a conversation.
//
// Usage: node scripts/inspect-mr.mjs <group/project> <iid>
// Token: GITLAB_TOKEN, or the first line of ~/.gitlab-token. A read_api token is enough.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [project, iid] = process.argv.slice(2);
if (!project || !iid) {
  console.error('usage: node scripts/inspect-mr.mjs <group/project> <iid>');
  process.exit(2);
}

const token =
  process.env.GITLAB_TOKEN ??
  (await readFile(join(homedir(), '.gitlab-token'), 'utf8')).split('\n')[0].trim();
const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`;

async function get(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`GET ${url} responded ${response.status}`);
  return response.json();
}

const mr = await get(base);
const notes = await get(`${base}/notes?sort=desc&order_by=created_at&per_page=10`);
console.log(`updated_at        ${mr.updated_at}`);
console.log(`user_notes_count  ${mr.user_notes_count}`);
for (const note of notes) {
  const kind = note.system ? 'system' : 'user  ';
  console.log(`${note.id}  ${kind}  ${note.created_at}  ${JSON.stringify(note.body.split('\n')[0])}`);
}
```

- [ ] **Step 3: Ask the user to prepare a throwaway merge request**

Tell the user, in the session language:

1. Create a Personal Access Token with `read_api` at <https://gitlab.com/-/user_settings/personal_access_tokens> and put it on the first line of `~/.gitlab-token` (`%USERPROFILE%\.gitlab-token` on Windows).
2. In a personal project on gitlab.com, open a throwaway merge request and add themselves as reviewer. If the project prevents author approval, untick **Settings → Merge requests → Prevent approval by merge request creator** for the duration, or ask a colleague to do the approve steps.
3. Report the project path and the MR iid.

Wait for the answer.

- [ ] **Step 4: Record the baseline**

Run: `node scripts/inspect-mr.mjs <project> <iid>`
Save the `updated_at` and `user_notes_count` lines.

- [ ] **Step 5: Walk the three actions, one at a time**

For each action below: ask the user to perform it in the GitLab UI, wait for confirmation, wait 5 seconds, run the script again, and record `updated_at`, `user_notes_count` and the newest note's body.

1. **Approve** the merge request.
2. **Revoke approval.**
3. As reviewer, **Submit review → Request changes**.

Then two controls, same procedure:

4. Push one commit to the source branch.
5. Leave one ordinary comment.

- [ ] **Step 6: Compare against the spec**

Expected newest-note bodies (spec §4.3):

| Action | Expected body |
|---|---|
| Approve | starts `approved this merge request` |
| Revoke | starts `unapproved this merge request` |
| Request changes | starts `requested changes` |
| Push | matches `^added \d+ commits?\b` |
| Comment | the comment text, `user` note |

If any body differs, the classifier prefixes in Task 4 and the fixture bodies in Task 4 Step 1 must use the observed wording. Edit this plan in place (both places) before starting Task 2, and record the difference in spec §4.3.

- [ ] **Step 7: Record the outcome in the spec**

Replace the paragraph that starts `**Assumption to verify before implementation.**` in spec §8 with one of the following, filled in with the recorded values:

If `updated_at` moved for all three actions:

```markdown
**Verified on gitlab.com, 2026-09-30.** Approving, revoking an approval and requesting changes
each moved the merge request's `updated_at` and left `user_notes_count` unchanged, so §4.2
step 2 detects them without a periodic sweep.
```

If it did not move for at least one of them:

```markdown
**Verified on gitlab.com, 2026-09-30.** <Action(s)> left the merge request's `updated_at`
unchanged. Every `author` entry is therefore also fetched once every 5 minutes regardless of
change (`AUTHOR_SWEEP_MS`, §4.1 `checkedAt`), which bounds the delay of those kinds to 5 minutes.
```

- [ ] **Step 8: Commit**

```bash
git add scripts/inspect-mr.mjs docs/2026-09-30-notifications-design.md
git commit -m "docs: verify MR activity signals against gitlab.com"
```

**Decision carried forward:** if `updated_at` did not move, Task 7 is required. Otherwise skip Task 7.

---

### Task 2: GitLab client — MR addressing, notes, discussions, outcome

**Files:**
- Modify: `src/config.js`
- Modify: `src/gitlab.js`
- Modify: `test/fixtures/merge_requests.json`
- Create: `test/fixtures/notes/merge_request_merged.json`
- Create: `test/fixtures/notes/merge_request_closed.json`
- Test: `test/gitlab.test.js`

**Interfaces:**
- Produces:
  - `Mr` gains `projectId: number`, `iid: number`, `notesCount: number` (0 when absent).
  - `notesUrl(projectId, iid) -> string`
  - `discussionsUrl(projectId, iid, page) -> string`
  - `mergeRequestUrl(projectId, iid) -> string`
  - `mapNote(raw) -> Note` where `Note = { id, body, system, authorId, authorName, authorAvatar, createdAt }`
  - `mapDiscussion(raw) -> { individual: boolean, notes: Note[] }`
  - `mapOutcome(raw) -> { id, state, title, url, reference, actor: { id, name, avatar } | null, at }`

- [ ] **Step 1: Add the constants**

Append to `src/config.js`:

```js
// The newest page of a changed merge request's notes is all that is read; more than a hundred
// notes inside one poll interval is not a realistic personal workload (notifications design §4.2).
export const NOTES_PER_PAGE = 100;

export const DISCUSSIONS_PER_PAGE = 100;

// The discussion walk that finds replies stops after this many pages; notes it did not reach are
// dropped rather than guessed at (notifications design §4.2 step 3).
export const DISCUSSION_PAGES_MAX = 5;

// `events` holds at most this many entries, and none older than the age below
// (notifications design §5).
export const EVENTS_MAX = 100;
export const EVENTS_MAX_AGE_MS = 14 * 86_400_000;

// Characters of a comment kept for the row tooltip (notifications design §5).
export const EXCERPT_MAX = 200;
```

- [ ] **Step 2: Extend the MR fixture**

In `test/fixtures/merge_requests.json`, add `"project_id": 55` and `"user_notes_count": 3` to the first object, and `"project_id": 55` and `"user_notes_count": 0` to the second. The full file:

```json
[
  {
    "id": 900,
    "iid": 7,
    "project_id": 55,
    "title": "Add rate limiting to the poller",
    "web_url": "https://gitlab.com/group/project/-/merge_requests/7",
    "references": { "short": "!7", "relative": "!7", "full": "group/project!7" },
    "author": { "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" },
    "updated_at": "2026-09-09T09:20:00.000Z",
    "user_notes_count": 3,
    "draft": false
  },
  {
    "id": 901,
    "iid": 8,
    "project_id": 55,
    "title": "Draft: Split the poller in two",
    "web_url": "https://gitlab.com/group/project/-/merge_requests/8",
    "references": { "short": "!8", "relative": "!8", "full": "group/project!8" },
    "author": { "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" },
    "updated_at": "2026-09-09T07:00:00.000Z",
    "user_notes_count": 0,
    "draft": true
  }
]
```

- [ ] **Step 3: Create the outcome fixtures**

`test/fixtures/notes/merge_request_merged.json`:

```json
{
  "id": 900,
  "iid": 7,
  "project_id": 55,
  "state": "merged",
  "title": "Add rate limiting to the poller",
  "web_url": "https://gitlab.com/group/project/-/merge_requests/7",
  "references": { "full": "group/project!7" },
  "merge_user": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" },
  "merged_by": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" },
  "merged_at": "2026-09-30T12:00:00.000Z",
  "closed_by": null,
  "closed_at": null
}
```

`test/fixtures/notes/merge_request_closed.json`:

```json
{
  "id": 902,
  "iid": 9,
  "project_id": 55,
  "state": "closed",
  "title": "Draft: Try a websocket instead",
  "web_url": "https://gitlab.com/group/project/-/merge_requests/9",
  "references": { "full": "group/project!9" },
  "merge_user": null,
  "merged_by": null,
  "merged_at": null,
  "closed_by": { "id": 1, "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" },
  "closed_at": "2026-09-30T12:30:00.000Z"
}
```

- [ ] **Step 4: Write the failing tests**

In `test/gitlab.test.js`, extend the import list:

```js
import {
  ApiError,
  apiGet,
  discussionsUrl,
  errorKindForStatus,
  mapDiscussion,
  mapMr,
  mapNote,
  mapOutcome,
  mapTodo,
  mapUser,
  mergeRequestUrl,
  mineUrl,
  notesUrl,
  reviewsUrl,
  todosUrl,
  userUrl,
} from '../src/gitlab.js';
```

Update the three existing `mapMr` expectations. The first gains `projectId: 55, iid: 7, notesCount: 3`; the second `projectId: 55, iid: 8, notesCount: 0`; the "stripped of every optional field" case `projectId: 0, iid: 0, notesCount: 0`:

```js
test('mapMr takes the project and number from references.full', async () => {
  const [mr] = await fixture('merge_requests');
  assert.deepEqual(mapMr(mr), {
    id: 900,
    projectId: 55,
    iid: 7,
    title: 'Add rate limiting to the poller',
    url: 'https://gitlab.com/group/project/-/merge_requests/7',
    reference: 'group/project!7',
    authorName: 'Ada Lovelace',
    authorAvatar: 'https://gitlab.com/uploads/ada.png',
    updatedAt: Date.UTC(2026, 8, 9, 9, 20, 0),
    notesCount: 3,
    draft: false,
  });
});

test('mapMr flags a draft and strips the prefix the chip already says', async () => {
  const [, mr] = await fixture('merge_requests');
  assert.deepEqual(mapMr(mr), {
    id: 901,
    projectId: 55,
    iid: 8,
    title: 'Split the poller in two',
    url: 'https://gitlab.com/group/project/-/merge_requests/8',
    reference: 'group/project!8',
    authorName: 'Grace Hopper',
    authorAvatar: 'https://gitlab.com/uploads/grace.png',
    updatedAt: Date.UTC(2026, 8, 9, 7, 0, 0),
    notesCount: 0,
    draft: true,
  });
});
```

```js
test('mapMr tolerates an MR stripped of every optional field', () => {
  assert.deepEqual(mapMr({ id: 3 }), {
    id: 3,
    projectId: 0,
    iid: 0,
    title: '',
    url: '',
    reference: '',
    authorName: '',
    authorAvatar: '',
    updatedAt: 0,
    notesCount: 0,
    draft: false,
  });
});
```

Add, after the `mineUrl` test:

```js
test('notesUrl asks for the newest page of notes first', () => {
  assert.equal(
    notesUrl(55, 7),
    'https://gitlab.com/api/v4/projects/55/merge_requests/7/notes' +
      '?sort=desc&order_by=created_at&per_page=100',
  );
});

test('discussionsUrl pages through a merge request’s discussions', () => {
  assert.equal(
    discussionsUrl(55, 8, 3),
    'https://gitlab.com/api/v4/projects/55/merge_requests/8/discussions?per_page=100&page=3',
  );
});

test('mergeRequestUrl addresses one merge request', () => {
  assert.equal(mergeRequestUrl(55, 9), 'https://gitlab.com/api/v4/projects/55/merge_requests/9');
});
```

Add, after the `mapMr` tests:

```js
test('mapNote keeps the author id the classifier compares against', () => {
  const raw = {
    id: 1010,
    body: 'Could this retry forever?',
    system: false,
    author: { id: 1, name: 'Ada Lovelace', avatar_url: 'https://gitlab.com/uploads/ada.png' },
    created_at: '2026-09-30T10:10:00.000Z',
  };
  assert.deepEqual(mapNote(raw), {
    id: 1010,
    body: 'Could this retry forever?',
    system: false,
    authorId: 1,
    authorName: 'Ada Lovelace',
    authorAvatar: 'https://gitlab.com/uploads/ada.png',
    createdAt: Date.UTC(2026, 8, 30, 10, 10, 0),
  });
});

test('mapNote tolerates a note stripped of every optional field', () => {
  assert.deepEqual(mapNote({ id: 5 }), {
    id: 5,
    body: '',
    system: false,
    authorId: 0,
    authorName: '',
    authorAvatar: '',
    createdAt: 0,
  });
});

test('mapDiscussion flags an individual note and maps its notes', () => {
  const mapped = mapDiscussion({
    id: 'd3',
    individual_note: true,
    notes: [{ id: 7, body: 'x', system: false, author: { id: 1 } }],
  });
  assert.equal(mapped.individual, true);
  assert.deepEqual(
    mapped.notes.map((note) => [note.id, note.authorId]),
    [[7, 1]],
  );
  assert.deepEqual(mapDiscussion({}), { individual: false, notes: [] });
});

test('mapOutcome names who merged, from merge_user', async () => {
  assert.deepEqual(mapOutcome(await fixture('notes/merge_request_merged')), {
    id: 900,
    state: 'merged',
    title: 'Add rate limiting to the poller',
    url: 'https://gitlab.com/group/project/-/merge_requests/7',
    reference: 'group/project!7',
    actor: { id: 2, name: 'Grace Hopper', avatar: 'https://gitlab.com/uploads/grace.png' },
    at: Date.UTC(2026, 8, 30, 12, 0, 0),
  });
});

test('mapOutcome falls back to merged_by when merge_user is absent', () => {
  const outcome = mapOutcome({ id: 1, state: 'merged', merged_by: { id: 3, name: 'Linus' } });
  assert.deepEqual(outcome.actor, { id: 3, name: 'Linus', avatar: '' });
});

test('mapOutcome names who closed, and strips the draft prefix', async () => {
  const outcome = mapOutcome(await fixture('notes/merge_request_closed'));
  assert.equal(outcome.state, 'closed');
  assert.equal(outcome.title, 'Try a websocket instead');
  assert.deepEqual(outcome.actor, {
    id: 1,
    name: 'Ada Lovelace',
    avatar: 'https://gitlab.com/uploads/ada.png',
  });
  assert.equal(outcome.at, Date.UTC(2026, 8, 30, 12, 30, 0));
});

test('mapOutcome has no actor for a merge request that is still open', () => {
  const outcome = mapOutcome({ id: 1, state: 'opened', merge_user: { id: 2 } });
  assert.equal(outcome.actor, null);
  assert.equal(outcome.at, 0);
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `notesUrl` (and the other new names) is not exported; the `mapMr` expectations miss `projectId`.

- [ ] **Step 6: Implement**

In `src/gitlab.js`, change the config import:

```js
import {
  DISCUSSIONS_PER_PAGE,
  GITLAB_HOST,
  MRS_PER_PAGE,
  NOTES_PER_PAGE,
  TODOS_PER_PAGE,
} from './config.js';
```

Add after `mineUrl`:

```js
/** The newest page of one merge request's notes, newest first (notifications design §4.2). */
export function notesUrl(projectId, iid) {
  return (
    `${API}/projects/${projectId}/merge_requests/${iid}/notes` +
    `?sort=desc&order_by=created_at&per_page=${NOTES_PER_PAGE}`
  );
}

/** One page of a merge request's discussions, oldest first as GitLab returns them. */
export function discussionsUrl(projectId, iid, page) {
  return (
    `${API}/projects/${projectId}/merge_requests/${iid}/discussions` +
    `?per_page=${DISCUSSIONS_PER_PAGE}&page=${page}`
  );
}

/** One merge request, whatever its state (notifications design §4.2 step 4). */
export function mergeRequestUrl(projectId, iid) {
  return `${API}/projects/${projectId}/merge_requests/${iid}`;
}
```

Replace `mapMr` with:

```js
export function mapMr(raw) {
  return {
    id: raw.id,
    projectId: raw.project_id ?? 0,
    iid: raw.iid ?? 0,
    title: (raw.title ?? '').replace(DRAFT_PREFIX, ''),
    url: raw.web_url ?? '',
    // `references.full` is "group/project!123": the project path and the MR number in one
    // field, with no extra request (design §6).
    reference: raw.references?.full ?? '',
    authorName: raw.author?.name ?? '',
    authorAvatar: raw.author?.avatar_url ?? '',
    updatedAt: epochMs(raw.updated_at),
    notesCount: raw.user_notes_count ?? 0,
    draft: raw.draft === true || raw.work_in_progress === true,
  };
}
```

Append:

```js
/** A note as the event classifier reads it (notifications design §4.3). */
export function mapNote(raw) {
  return {
    id: raw.id,
    body: raw.body ?? '',
    system: raw.system === true,
    authorId: raw.author?.id ?? 0,
    authorName: raw.author?.name ?? '',
    authorAvatar: raw.author?.avatar_url ?? '',
    createdAt: epochMs(raw.created_at),
  };
}

/**
 * A discussion reduced to what reply detection needs. `individual` marks a stand-alone note,
 * which is never a thread anyone replied in (notifications design §4.2 step 3).
 */
export function mapDiscussion(raw) {
  return {
    individual: raw.individual_note === true,
    notes: (raw.notes ?? []).map(mapNote),
  };
}

function mapActor(raw) {
  return raw ? { id: raw.id, name: raw.name ?? '', avatar: raw.avatar_url ?? '' } : null;
}

/**
 * What became of a merge request that left the open list, and who did it
 * (notifications design §4.2 step 4). `merge_user` also names whoever set auto-merge;
 * `merged_by` is its deprecated predecessor, read only when `merge_user` is absent.
 * `actor` is null and `at` is 0 for any state other than merged or closed.
 */
export function mapOutcome(raw) {
  const state = raw.state ?? '';
  const actor =
    state === 'merged' ? (raw.merge_user ?? raw.merged_by) : state === 'closed' ? raw.closed_by : null;
  const at = state === 'merged' ? raw.merged_at : state === 'closed' ? raw.closed_at : null;
  return {
    id: raw.id,
    state,
    title: (raw.title ?? '').replace(DRAFT_PREFIX, ''),
    url: raw.web_url ?? '',
    reference: raw.references?.full ?? '',
    actor: mapActor(actor),
    at: epochMs(at),
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/gitlab.js test/gitlab.test.js test/fixtures/merge_requests.json test/fixtures/notes/
git commit -m "feat: address merge requests and map notes, discussions and outcomes"
```

---

### Task 3: Store — tabs, the notifications feed, badge and read-mark pruning

**Files:**
- Modify: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `Event` shape from spec §5 (`id`, `kind`, `url`, `createdAt`, …); `Todo` from design §6.
- Produces:
  - `TABS = ['notifications', 'reviews', 'mine']` (replaces `LISTS`)
  - `resolveTab(tab) -> 'notifications' | 'reviews' | 'mine'`
  - `coveredByTodo(event, todos) -> boolean`
  - `notificationFeed(inbox, events, readIds) -> Array<{ source: 'todo' | 'event', ...fields }>`, newest first
  - `badgeCount(inbox, readIds, events) -> number` (third argument new, optional)
  - `pruneReadIds(readIds, todos, events) -> { [id]: true }`
  - schema defaults gain `watch: {}`, `events: []`; `ui.activeTab` default `'notifications'`

- [ ] **Step 1: Write the failing tests**

In `test/store.test.js`, change the import:

```js
import {
  TABS,
  badgeCount,
  coveredByTodo,
  notificationFeed,
  pruneReadIds,
  resolveTab,
  unread,
} from '../src/store.js';
```

Replace the `LISTS` test with:

```js
test('TABS names the three popup tabs', () => {
  assert.deepEqual(TABS, ['notifications', 'reviews', 'mine']);
});

test('resolveTab reads a stored "todos" as notifications', () => {
  assert.equal(resolveTab('todos'), 'notifications');
});

test('resolveTab keeps a known tab and falls back on anything else', () => {
  assert.equal(resolveTab('reviews'), 'reviews');
  assert.equal(resolveTab('mine'), 'mine');
  assert.equal(resolveTab(undefined), 'notifications');
  assert.equal(resolveTab('bogus'), 'notifications');
});
```

Append:

```js
const event = (overrides) => ({
  id: 'note:17',
  kind: 'comment',
  url: `${MR_URL}#note_17`,
  createdAt: 0,
  ...overrides,
});

test('coveredByTodo matches a note event to the to-do that points at the same note', () => {
  assert.equal(coveredByTodo(event(), [{ id: 1, url: `${MR_URL}#note_17` }]), true);
});

test('coveredByTodo does not match a different note or a non-note event', () => {
  assert.equal(coveredByTodo(event(), [{ id: 1, url: `${MR_URL}#note_170` }]), false);
  assert.equal(coveredByTodo(event({ id: 'merged:5', url: MR_URL }), [{ id: 1, url: MR_URL }]), false);
  assert.equal(coveredByTodo(event(), undefined), false);
});

test('notificationFeed merges unread to-dos and unread events, newest first', () => {
  const inbox = snapshot({
    todos: [
      { id: 1, url: 'https://gitlab.com/group/backend/-/issues/1', createdAt: 100 },
      { id: 2, url: 'https://gitlab.com/group/backend/-/issues/2', createdAt: 300 },
    ],
  });
  const events = [event({ id: 'note:17', createdAt: 200 }), event({ id: 'merged:5', createdAt: 400 })];
  const feed = notificationFeed(inbox, events, { 2: true, 'merged:5': true });
  assert.deepEqual(
    feed.map((item) => [item.source, item.id]),
    [
      ['event', 'note:17'],
      ['todo', 1],
    ],
  );
});

// The to-do list and the notes are fetched in different steps of one poll, so a to-do can land a
// poll after the event for the same comment; the comment must still show once.
test('notificationFeed hides an event whose note a to-do already covers', () => {
  const inbox = snapshot({ todos: [{ id: 1, url: `${MR_URL}#note_17`, createdAt: 100 }] });
  const feed = notificationFeed(inbox, [event()], {});
  assert.deepEqual(
    feed.map((item) => item.id),
    [1],
  );
});

test('notificationFeed is empty before the first snapshot', () => {
  assert.deepEqual(notificationFeed(null, undefined, undefined), []);
});

test('badgeCount adds unread events to the count', () => {
  const inbox = snapshot({ todos: [{ id: 1, url: 'https://gitlab.com/group/backend/-/issues/1' }] });
  const events = [event({ id: 'merged:9', url: 'https://gitlab.com/group/backend/-/merge_requests/9' })];
  assert.equal(badgeCount(inbox, {}, events), 2);
  assert.equal(badgeCount(inbox, { 'merged:9': true }, events), 1);
});

test('badgeCount does not count an event on an MR already in the review list', () => {
  const inbox = snapshot({ reviews: [{ id: 11, url: MR_URL }] });
  assert.equal(badgeCount(inbox, {}, [event({ id: 'note:30', kind: 'reply', url: `${MR_URL}#note_30` })]), 1);
});

test('badgeCount counts an event and its covering to-do once', () => {
  const inbox = snapshot({ todos: [{ id: 1, url: `${MR_URL}#note_17` }] });
  assert.equal(badgeCount(inbox, {}, [event()]), 1);
});

test('pruneReadIds keeps marks whose to-do or event is still held', () => {
  const kept = pruneReadIds(
    { 1: true, 2: true, 'note:17': true, 'note:99': true },
    [{ id: 1 }],
    [event()],
  );
  assert.deepEqual(kept, { 1: true, 'note:17': true });
});

test('pruneReadIds tolerates missing lists and a missing map', () => {
  assert.deepEqual(pruneReadIds(undefined, undefined, undefined), {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `TABS`, `resolveTab`, `coveredByTodo`, `notificationFeed`, `pruneReadIds` are not exported.

- [ ] **Step 3: Implement**

In `src/store.js`, replace the header comment, `SCHEMA_DEFAULTS` and `LISTS` with:

```js
/**
 * The `chrome.storage.local` schema (design §6, notifications design §5). Every read goes
 * through these defaults, so no caller has to distinguish "unset" from "set to the default".
 *
 * `inbox: null` means "no poll has ever succeeded", and is what makes the popup show its
 * skeleton rather than three empty lists.
 *
 * `readIds` holds the to-dos and events the user has dismissed: `{ "42": true,
 * "note:17": true }`. To-do ids are numbers and event ids carry a kind prefix, so the two cannot
 * collide. It is pruned on every successful poll to what `inbox.todos` and `events` still hold.
 *
 * `watch` is the per-merge-request state event detection compares against
 * (notifications design §4.1); `events` the derived events, newest first (§5).
 */
const SCHEMA_DEFAULTS = {
  auth: null,
  me: null,
  inbox: null,
  ui: { activeTab: 'notifications' },
  readIds: {},
  backoffUntil: 0,
  watch: {},
  events: [],
};

/** The popup's tabs, in the order it presents them (notifications design §6). */
export const TABS = ['notifications', 'reviews', 'mine'];

/**
 * The tab to show for a stored `ui.activeTab`. `'todos'` is the first tab's name before
 * notifications design §6 and is read as `'notifications'`; anything unknown falls back to it.
 */
export function resolveTab(tab) {
  return TABS.includes(tab) ? tab : 'notifications';
}
```

Replace `badgeCount` and its doc comment with:

```js
/**
 * Whether a note event's comment is already in the to-do list: a comment that mentions the user
 * raises a to-do whose URL ends in the same `#note_<id>` (notifications design §3). The to-do is
 * what the user acts on, so the event gives way to it.
 */
export function coveredByTodo(event, todos) {
  if (!event.id.startsWith('note:')) return false;
  const anchor = `#note_${event.id.slice('note:'.length)}`;
  return (todos ?? []).some((todo) => (todo.url ?? '').endsWith(anchor));
}

/**
 * The Notifications tab: unread to-dos and unread events, newest first by `createdAt`. Each
 * item carries `source` so the popup can tell the two apart (notifications design §6).
 */
export function notificationFeed(inbox, events, readIds) {
  const todos = unread(inbox?.todos, readIds).map((todo) => ({ source: 'todo', ...todo }));
  const derived = unread(events, readIds)
    .filter((event) => !coveredByTodo(event, inbox?.todos))
    .map((event) => ({ source: 'event', ...event }));
  return [...todos, ...derived].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The number on the toolbar badge: the Notifications feed plus every merge request awaiting the
 * user's review (design §8, notifications design §7). A review stays counted until it is no
 * longer requested of the user — that is the point of putting it on the badge, and unlike
 * `mine` it is a set that does reach zero.
 *
 * A feed item pointing at an MR already in the review list is not counted a second time. Its
 * fragment goes first, because a to-do or event raised by a comment points into the same MR
 * with a `#note_17` on the end.
 */
export function badgeCount(inbox, readIds, events) {
  const reviews = inbox?.reviews ?? [];
  const reviewUrls = new Set(reviews.map((mr) => mr.url).filter(Boolean));
  const counted = notificationFeed(inbox, events, readIds).filter(
    (item) => !reviewUrls.has((item.url ?? '').split('#')[0]),
  );
  return reviews.length + counted.length;
}

/**
 * Drops every read mark whose to-do or event is no longer held. Without it the map would grow for
 * the life of the profile, and GitLab reusing an id would hide a fresh to-do the user has never
 * seen (design §6).
 */
export function pruneReadIds(readIds, todos, events) {
  const kept = {};
  for (const item of [...(todos ?? []), ...(events ?? [])]) {
    if (readIds?.[item.id]) kept[item.id] = true;
  }
  return kept;
}
```

- [ ] **Step 4: Keep the popup working until Task 9**

`src/popup/popup.js` imports `LISTS`, which no longer exists, and its markup still has a `todos` tab. Until Task 9 renames the tab, the popup keeps its own list of the three tab ids. Replace its `store.js` import line with:

```js
import { onChanged, read, unread, write } from '../store.js';

// The tab ids the markup carries until the Notifications tab lands (plan Task 9).
const TABS = ['todos', 'reviews', 'mine'];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites — including the existing `badgeCount` tests, which pass two arguments.

- [ ] **Step 6: Commit**

```bash
git add src/store.js src/popup/popup.js test/store.test.js
git commit -m "feat: add the notifications feed and count events on the badge"
```

---

### Task 4: Event detection — watch diff, note walk, classifier, replies

**Files:**
- Create: `src/events.js`
- Create: `test/fixtures/notes/author_notes.json`
- Create: `test/fixtures/notes/reviewer_notes.json`
- Create: `test/fixtures/notes/discussions.json`
- Test: `test/events.test.js`

**Interfaces:**
- Consumes: `Mr` from Task 2 (`id`, `projectId`, `iid`, `updatedAt`, `notesCount`); `Note` from Task 2 (`mapNote`).
- Produces:
  - `WatchEntry = { projectId, iid, role: 'author' | 'reviewer', updatedAt, notesCount, since, lastNoteId }`
  - `planWatch(watch, snapshot) -> { watch: { [id]: WatchEntry }, changed: string[], disappeared: string[] }`
  - `newNotes(notes: Note[], entry) -> Note[]`
  - `REPLY_CANDIDATE = 'reply_candidate'`
  - `classifyNote(note, entry, me) -> EventKind | REPLY_CANDIDATE | null`
  - `replyNoteIds(discussions, candidateIds: Set<number>, me) -> Set<number>`
  - `advanceEntry(entry, mr, notes) -> WatchEntry`

- [ ] **Step 1: Create the note fixtures**

The user is `{ id: 42 }`. Ada is id 1, Grace id 2. MR !7 (id 900) is the user's; MR !8 (id 901) is Grace's, with the user as reviewer.

`test/fixtures/notes/author_notes.json` — MR !7, newest first:

```json
[
  { "id": 1010, "body": "Could this retry forever?", "system": false, "author": { "id": 1, "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" }, "created_at": "2026-09-30T10:10:00.000Z" },
  { "id": 1009, "body": "Fixed in the next push.", "system": false, "author": { "id": 42, "name": "Me", "avatar_url": "https://gitlab.com/uploads/me.png" }, "created_at": "2026-09-30T10:09:00.000Z" },
  { "id": 1008, "body": "requested changes", "system": true, "author": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" }, "created_at": "2026-09-30T10:08:00.000Z" },
  { "id": 1007, "body": "unapproved this merge request", "system": true, "author": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" }, "created_at": "2026-09-30T10:07:00.000Z" },
  { "id": 1006, "body": "approved this merge request", "system": true, "author": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" }, "created_at": "2026-09-30T10:06:00.000Z" },
  { "id": 1005, "body": "added 2 commits\n\n<ul><li>abc1234 - Retry with backoff</li><li>def5678 - Cap retries</li></ul>\n\n[Compare with previous version](https://gitlab.com/group/project/-/merge_requests/7/diffs?diff_id=1)", "system": true, "author": { "id": 42, "name": "Me", "avatar_url": "https://gitlab.com/uploads/me.png" }, "created_at": "2026-09-30T10:05:00.000Z" },
  { "id": 1004, "body": "changed the description", "system": true, "author": { "id": 1, "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" }, "created_at": "2026-09-30T10:04:00.000Z" },
  { "id": 1003, "body": "An early question.", "system": false, "author": { "id": 1, "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" }, "created_at": "2026-09-30T09:00:00.000Z" }
]
```

`test/fixtures/notes/reviewer_notes.json` — MR !8, newest first:

```json
[
  { "id": 2007, "body": "Heads-up for everyone.", "system": false, "author": { "id": 1, "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" }, "created_at": "2026-09-30T11:07:00.000Z" },
  { "id": 2006, "body": "Agreed with Grace.", "system": false, "author": { "id": 1, "name": "Ada Lovelace", "avatar_url": "https://gitlab.com/uploads/ada.png" }, "created_at": "2026-09-30T11:06:00.000Z" },
  { "id": 2005, "body": "Good point,\n  changing it.", "system": false, "author": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" }, "created_at": "2026-09-30T11:05:00.000Z" },
  { "id": 2004, "body": "added 1 commit\n\n<ul><li>aaa1111 - Rename the flag</li></ul>\n\n[Compare with previous version](https://gitlab.com/group/project/-/merge_requests/8/diffs?diff_id=2)", "system": true, "author": { "id": 2, "name": "Grace Hopper", "avatar_url": "https://gitlab.com/uploads/grace.png" }, "created_at": "2026-09-30T11:04:00.000Z" },
  { "id": 2003, "body": "Nit: rename this flag.", "system": false, "author": { "id": 42, "name": "Me", "avatar_url": "https://gitlab.com/uploads/me.png" }, "created_at": "2026-09-30T11:03:00.000Z" }
]
```

`test/fixtures/notes/discussions.json` — MR !8, oldest first:

```json
[
  {
    "id": "d1",
    "individual_note": false,
    "notes": [
      { "id": 2003, "body": "Nit: rename this flag.", "system": false, "author": { "id": 42, "name": "Me" }, "created_at": "2026-09-30T11:03:00.000Z" },
      { "id": 2005, "body": "Good point,\n  changing it.", "system": false, "author": { "id": 2, "name": "Grace Hopper" }, "created_at": "2026-09-30T11:05:00.000Z" }
    ]
  },
  {
    "id": "d2",
    "individual_note": false,
    "notes": [
      { "id": 2002, "body": "Why not a config value?", "system": false, "author": { "id": 1, "name": "Ada Lovelace" }, "created_at": "2026-09-30T10:59:00.000Z" },
      { "id": 2006, "body": "Agreed with Grace.", "system": false, "author": { "id": 1, "name": "Ada Lovelace" }, "created_at": "2026-09-30T11:06:00.000Z" }
    ]
  },
  {
    "id": "d3",
    "individual_note": true,
    "notes": [
      { "id": 2007, "body": "Heads-up for everyone.", "system": false, "author": { "id": 1, "name": "Ada Lovelace" }, "created_at": "2026-09-30T11:07:00.000Z" }
    ]
  }
]
```

If Task 1 observed different system-note wording, use the observed bodies here.

- [ ] **Step 2: Write the failing tests**

`test/events.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  REPLY_CANDIDATE,
  advanceEntry,
  classifyNote,
  newNotes,
  planWatch,
  replyNoteIds,
} from '../src/events.js';
import { mapDiscussion, mapNote } from '../src/gitlab.js';

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
const notesFixture = async (name) => (await fixture(`notes/${name}`)).map(mapNote);

const ME = { id: 42 };
const T = (hh, mm) => Date.UTC(2026, 8, 30, hh, mm, 0);

const mr = (overrides) => ({
  id: 900,
  projectId: 55,
  iid: 7,
  title: 'Add rate limiting to the poller',
  url: 'https://gitlab.com/group/project/-/merge_requests/7',
  reference: 'group/project!7',
  updatedAt: T(9, 30),
  notesCount: 1,
  ...overrides,
});

const entry = (overrides) => ({
  projectId: 55,
  iid: 7,
  role: 'author',
  updatedAt: T(9, 30),
  notesCount: 1,
  since: T(9, 30),
  lastNoteId: 0,
  ...overrides,
});

const snapshot = (overrides) => ({ todos: [], reviews: [], mine: [], ...overrides });

test('planWatch baselines a new merge request at its updated_at, with no fetch', () => {
  const plan = planWatch({}, snapshot({ mine: [mr()] }));
  assert.deepEqual(plan.watch, { 900: entry() });
  assert.deepEqual(plan.changed, []);
  assert.deepEqual(plan.disappeared, []);
});

test('planWatch marks an entry changed when updated_at or the notes count moved', () => {
  const watch = { 900: entry(), 901: entry({ iid: 8, role: 'reviewer' }), 903: entry({ iid: 10 }) };
  const plan = planWatch(
    watch,
    snapshot({
      mine: [mr(), mr({ id: 903, iid: 10, notesCount: 2 })],
      reviews: [mr({ id: 901, iid: 8, updatedAt: T(11, 0) })],
    }),
  );
  assert.deepEqual(plan.changed.sort(), ['901', '903']);
});

test('planWatch does not advance a changed entry', () => {
  const plan = planWatch({ 900: entry() }, snapshot({ mine: [mr({ updatedAt: T(11, 0) })] }));
  assert.equal(plan.watch[900].updatedAt, T(9, 30));
});

test('planWatch keeps a disappeared author entry for its outcome fetch', () => {
  const plan = planWatch({ 902: entry({ iid: 9 }) }, snapshot());
  assert.deepEqual(plan.disappeared, ['902']);
  assert.deepEqual(plan.watch, { 902: entry({ iid: 9 }) });
});

test('planWatch drops a disappeared reviewer entry without a fetch', () => {
  const plan = planWatch({ 901: entry({ iid: 8, role: 'reviewer' }) }, snapshot());
  assert.deepEqual(plan.disappeared, []);
  assert.deepEqual(plan.watch, {});
});

test('planWatch watches an MR in both lists once, as its author', () => {
  const plan = planWatch({}, snapshot({ mine: [mr()], reviews: [mr()] }));
  assert.deepEqual(Object.keys(plan.watch), ['900']);
  assert.equal(plan.watch[900].role, 'author');
});

test('planWatch skips an MR it cannot address', () => {
  const plan = planWatch({}, snapshot({ mine: [mr({ projectId: 0 }), mr({ id: 904, iid: 0 })] }));
  assert.deepEqual(plan.watch, {});
});

test('newNotes stops at the last note already classified', async () => {
  const notes = await notesFixture('author_notes');
  const fresh = newNotes(notes, entry({ lastNoteId: 1007, since: 0 }));
  assert.deepEqual(
    fresh.map((note) => note.id),
    [1010, 1009, 1008],
  );
});

test('newNotes stops at the baseline on the first fetch', async () => {
  const notes = await notesFixture('author_notes');
  const fresh = newNotes(notes, entry({ since: T(9, 30) }));
  assert.deepEqual(
    fresh.map((note) => note.id),
    [1010, 1009, 1008, 1007, 1006, 1005, 1004],
  );
});

test('classifyNote on the user’s own MR', async () => {
  const notes = await notesFixture('author_notes');
  const kinds = Object.fromEntries(notes.map((note) => [note.id, classifyNote(note, entry(), ME)]));
  assert.deepEqual(kinds, {
    1010: 'comment',
    1009: null,
    1008: 'changes_requested',
    1007: 'unapproved',
    1006: 'approved',
    1005: null,
    1004: null,
    1003: 'comment',
  });
});

test('classifyNote on an MR the user reviews', async () => {
  const notes = await notesFixture('reviewer_notes');
  const reviewer = entry({ iid: 8, role: 'reviewer' });
  const kinds = Object.fromEntries(notes.map((note) => [note.id, classifyNote(note, reviewer, ME)]));
  assert.deepEqual(kinds, {
    2007: REPLY_CANDIDATE,
    2006: REPLY_CANDIDATE,
    2005: REPLY_CANDIDATE,
    2004: 'commits',
    2003: null,
  });
});

test('classifyNote ignores approvals on an MR the user only reviews', () => {
  const note = mapNote({ id: 1, body: 'approved this merge request', system: true, author: { id: 2 } });
  assert.equal(classifyNote(note, entry({ role: 'reviewer' }), ME), null);
});

test('classifyNote does not read a label note as commits', () => {
  const note = mapNote({ id: 1, body: 'added ~"commit-msg" label', system: true, author: { id: 2 } });
  assert.equal(classifyNote(note, entry({ role: 'reviewer' }), ME), null);
});

test('replyNoteIds keeps only notes in a thread the user has a note in', async () => {
  const discussions = (await fixture('notes/discussions')).map(mapDiscussion);
  const replies = replyNoteIds(discussions, new Set([2005, 2006, 2007]), ME);
  assert.deepEqual([...replies], [2005]);
});

test('advanceEntry moves to the MR’s state and the newest note fetched', async () => {
  const notes = await notesFixture('author_notes');
  const next = advanceEntry(entry(), mr({ updatedAt: T(10, 10), notesCount: 4 }), notes);
  assert.deepEqual(next, entry({ updatedAt: T(10, 10), notesCount: 4, lastNoteId: 1010 }));
});

test('advanceEntry never moves lastNoteId backwards', () => {
  const next = advanceEntry(entry({ lastNoteId: 1010 }), mr(), []);
  assert.equal(next.lastNoteId, 1010);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '…/src/events.js'`.

- [ ] **Step 4: Implement**

`src/events.js`:

```js
/**
 * Event detection (notifications design §4). Pure: every request goes through the `get`
 * function the caller passes in, so this module runs under `node --test` unchanged.
 */

/** A note by someone else on an MR the user reviews; a reply only if its thread holds the user. */
export const REPLY_CANDIDATE = 'reply_candidate';

/**
 * GitLab's English system-note wording on the user's own merge request, matched by prefix
 * (notifications design §4.3). `unapproved` is listed on its own: it does not start with
 * `approved`, so the order does not matter.
 */
const AUTHOR_SYSTEM_NOTES = [
  ['approved this merge request', 'approved'],
  ['unapproved this merge request', 'unapproved'],
  ['requested changes', 'changes_requested'],
];

/** The system note GitLab leaves when commits are pushed to a merge request (§4.3). */
const COMMITS_NOTE = /^added \d+ commits?\b/;

/**
 * Compares the stored watch with a fresh snapshot (notifications design §4.2 steps 1, 2, 4).
 *
 * Returns the watch to carry forward, the ids whose notes must be fetched, and the ids of
 * author entries that left both lists. Nothing is advanced here: a changed entry keeps its old
 * state until its fetches succeed, and a disappeared author entry stays until its outcome is
 * known. A merge request with no project id or iid cannot be addressed and is not watched.
 */
export function planWatch(watch, snapshot) {
  const current = new Map();
  for (const mr of snapshot.reviews ?? []) current.set(String(mr.id), { mr, role: 'reviewer' });
  for (const mr of snapshot.mine ?? []) current.set(String(mr.id), { mr, role: 'author' });

  const next = {};
  const changed = [];
  const disappeared = [];
  for (const [id, { mr, role }] of current) {
    if (!mr.projectId || !mr.iid) continue;
    const known = watch?.[id];
    if (!known) {
      next[id] = {
        projectId: mr.projectId,
        iid: mr.iid,
        role,
        updatedAt: mr.updatedAt,
        notesCount: mr.notesCount,
        since: mr.updatedAt,
        lastNoteId: 0,
      };
      continue;
    }
    next[id] = { ...known, role };
    if (known.updatedAt !== mr.updatedAt || known.notesCount !== mr.notesCount) changed.push(id);
  }
  for (const [id, known] of Object.entries(watch ?? {})) {
    if (current.has(id) || known.role !== 'author') continue;
    next[id] = known;
    disappeared.push(id);
  }
  return { watch: next, changed, disappeared };
}

/**
 * The notes of a newest-first page that are not yet classified: those after `lastNoteId` and
 * created after the entry's baseline (notifications design §4.2 step 2).
 */
export function newNotes(notes, entry) {
  const fresh = [];
  for (const note of notes) {
    if (note.id <= entry.lastNoteId || note.createdAt <= entry.since) break;
    fresh.push(note);
  }
  return fresh;
}

/**
 * The event kind a note raises for the user, `REPLY_CANDIDATE` when that depends on its thread,
 * or null (notifications design §4.3).
 */
export function classifyNote(note, entry, me) {
  if (note.authorId === me.id) return null;
  if (!note.system) return entry.role === 'author' ? 'comment' : REPLY_CANDIDATE;
  if (entry.role === 'author') {
    const match = AUTHOR_SYSTEM_NOTES.find(([prefix]) => note.body.startsWith(prefix));
    return match ? match[1] : null;
  }
  return COMMITS_NOTE.test(note.body) ? 'commits' : null;
}

/**
 * The candidate note ids that sit in a thread the user has a note in (notifications design
 * §4.2 step 3). A stand-alone note is nobody's thread.
 */
export function replyNoteIds(discussions, candidateIds, me) {
  const replies = new Set();
  for (const discussion of discussions) {
    if (discussion.individual) continue;
    if (!discussion.notes.some((note) => note.authorId === me.id && !note.system)) continue;
    for (const note of discussion.notes) {
      if (candidateIds.has(note.id)) replies.add(note.id);
    }
  }
  return replies;
}

/**
 * The entry after a successful fetch: the MR's current state, and the newest note id seen
 * (notifications design §4.2 step 5).
 */
export function advanceEntry(entry, mr, notes) {
  const newest = notes.reduce((max, note) => Math.max(max, note.id), entry.lastNoteId);
  return { ...entry, updatedAt: mr.updatedAt, notesCount: mr.notesCount, lastNoteId: newest };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add src/events.js test/events.test.js test/fixtures/notes/
git commit -m "feat: classify merge request notes into notification events"
```

---

### Task 5: Event records — building and capping

**Files:**
- Modify: `src/events.js`
- Test: `test/events.test.js`

**Interfaces:**
- Consumes: `Note` and `mapOutcome`'s result from Task 2; `Mr` from Task 2; `coveredByTodo` from Task 3.
- Produces:
  - `noteEvent(kind, note, mr) -> Event`
  - `outcomeEvent(outcome, me, now) -> Event | null`
  - `mergeEvents(existing, added, todos, now) -> Event[]`

- [ ] **Step 1: Write the failing tests**

Extend the `events.js` import in `test/events.test.js` with `mergeEvents, noteEvent, outcomeEvent`, and the `gitlab.js` import with `mapOutcome`. Append:

```js
test('noteEvent anchors to the note and keeps a whitespace-collapsed excerpt', async () => {
  const [, , reply] = await notesFixture('reviewer_notes');
  const reviewed = mr({ id: 901, iid: 8, url: 'https://gitlab.com/group/project/-/merge_requests/8', reference: 'group/project!8', title: 'Split the poller in two' });
  assert.deepEqual(noteEvent('reply', reply, reviewed), {
    id: 'note:2005',
    kind: 'reply',
    mrTitle: 'Split the poller in two',
    mrReference: 'group/project!8',
    url: 'https://gitlab.com/group/project/-/merge_requests/8#note_2005',
    actorName: 'Grace Hopper',
    actorAvatar: 'https://gitlab.com/uploads/grace.png',
    excerpt: 'Good point, changing it.',
    createdAt: T(11, 5),
  });
});

test('noteEvent has no excerpt for a system note and caps a long comment', () => {
  const system = mapNote({ id: 1, body: 'approved this merge request', system: true, author: { id: 2 } });
  assert.equal(noteEvent('approved', system, mr()).excerpt, '');
  const long = mapNote({ id: 2, body: 'x'.repeat(500), author: { id: 1 } });
  assert.equal(noteEvent('comment', long, mr()).excerpt.length, 200);
});

test('noteEvent leaves the url empty when the MR has none', () => {
  const note = mapNote({ id: 3, body: 'hi', author: { id: 1 } });
  assert.equal(noteEvent('comment', note, mr({ url: '' })).url, '');
});

test('outcomeEvent reports a merge by someone else', async () => {
  const outcome = mapOutcome(await fixture('notes/merge_request_merged'));
  assert.deepEqual(outcomeEvent(outcome, ME, T(13, 0)), {
    id: 'merged:900',
    kind: 'merged',
    mrTitle: 'Add rate limiting to the poller',
    mrReference: 'group/project!7',
    url: 'https://gitlab.com/group/project/-/merge_requests/7',
    actorName: 'Grace Hopper',
    actorAvatar: 'https://gitlab.com/uploads/grace.png',
    excerpt: '',
    createdAt: T(12, 0),
  });
});

test('outcomeEvent reports a close by someone else', async () => {
  const outcome = mapOutcome(await fixture('notes/merge_request_closed'));
  const event = outcomeEvent(outcome, ME, T(13, 0));
  assert.equal(event.id, 'closed:902');
  assert.equal(event.kind, 'closed');
  assert.equal(event.actorName, 'Ada Lovelace');
});

test('outcomeEvent is silent for the user’s own merge or close', () => {
  const merged = mapOutcome({ id: 5, state: 'merged', merge_user: { id: 42 } });
  const closed = mapOutcome({ id: 6, state: 'closed', closed_by: { id: 42 } });
  assert.equal(outcomeEvent(merged, ME, T(13, 0)), null);
  assert.equal(outcomeEvent(closed, ME, T(13, 0)), null);
});

test('outcomeEvent is silent for an MR that is still open', () => {
  assert.equal(outcomeEvent(mapOutcome({ id: 5, state: 'opened' }), ME, T(13, 0)), null);
});

test('outcomeEvent still reports a merge when GitLab omits who did it', () => {
  const event = outcomeEvent(mapOutcome({ id: 5, state: 'merged' }), ME, T(13, 0));
  assert.equal(event.kind, 'merged');
  assert.equal(event.actorName, '');
  assert.equal(event.actorAvatar, '');
  assert.equal(event.createdAt, T(13, 0));
});

const stored = (id, createdAt) => ({ id, kind: 'comment', url: '', createdAt });

test('mergeEvents sorts newest first and drops a duplicate id', () => {
  const merged = mergeEvents([stored('note:1', T(9, 0))], [stored('note:2', T(10, 0)), stored('note:1', T(9, 0))], [], T(12, 0));
  assert.deepEqual(
    merged.map((event) => event.id),
    ['note:2', 'note:1'],
  );
});

test('mergeEvents keeps at most 100 events', () => {
  const many = Array.from({ length: 120 }, (_, i) => stored(`note:${i}`, T(10, 0) + i));
  const merged = mergeEvents([], many, [], T(12, 0));
  assert.equal(merged.length, 100);
  assert.equal(merged[0].id, 'note:119');
});

test('mergeEvents drops events older than 14 days', () => {
  const now = T(12, 0);
  const merged = mergeEvents(
    [stored('note:old', now - 14 * 86_400_000), stored('note:fresh', now - 13 * 86_400_000)],
    [],
    [],
    now,
  );
  assert.deepEqual(
    merged.map((event) => event.id),
    ['note:fresh'],
  );
});

test('mergeEvents drops an event a to-do already covers', () => {
  const todos = [{ id: 1, url: 'https://gitlab.com/group/project/-/merge_requests/7#note_1010' }];
  const merged = mergeEvents([], [stored('note:1010', T(10, 0))], todos, T(12, 0));
  assert.deepEqual(merged, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `noteEvent`, `outcomeEvent`, `mergeEvents` are not exported.

- [ ] **Step 3: Implement**

At the top of `src/events.js`, after the module doc comment:

```js
import { EVENTS_MAX, EVENTS_MAX_AGE_MS, EXCERPT_MAX } from './config.js';
import { coveredByTodo } from './store.js';
```

Append:

```js
/** The stored event for a classified note (notifications design §5). */
export function noteEvent(kind, note, mr) {
  return {
    id: `note:${note.id}`,
    kind,
    mrTitle: mr.title,
    mrReference: mr.reference,
    url: mr.url ? `${mr.url}#note_${note.id}` : '',
    actorName: note.authorName,
    actorAvatar: note.authorAvatar,
    excerpt: note.system ? '' : note.body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX),
    createdAt: note.createdAt,
  };
}

/**
 * The stored event for a merge request that left the open list, or null when it is still open
 * or the user did it themselves (notifications design §4.2 step 4). An outcome GitLab reports
 * without an actor or a timestamp is still an event: an empty name and the detection time are
 * better than a lost merge.
 */
export function outcomeEvent(outcome, me, now) {
  if (outcome.state !== 'merged' && outcome.state !== 'closed') return null;
  if (outcome.actor?.id === me.id) return null;
  return {
    id: `${outcome.state}:${outcome.id}`,
    kind: outcome.state,
    mrTitle: outcome.title,
    mrReference: outcome.reference,
    url: outcome.url,
    actorName: outcome.actor?.name ?? '',
    actorAvatar: outcome.actor?.avatar ?? '',
    excerpt: '',
    createdAt: outcome.at || now,
  };
}

/**
 * The events to store: stored and new merged, one per id, newest first, none a to-do covers,
 * none older than `EVENTS_MAX_AGE_MS`, at most `EVENTS_MAX` (notifications design §5).
 */
export function mergeEvents(existing, added, todos, now) {
  const cutoff = now - EVENTS_MAX_AGE_MS;
  const seen = new Set();
  return [...added, ...(existing ?? [])]
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return event.createdAt > cutoff && !coveredByTodo(event, todos);
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, EVENTS_MAX);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "feat: build, deduplicate and cap notification events"
```

---

### Task 6: Event detection — one pass over a snapshot

**Files:**
- Modify: `src/events.js`
- Test: `test/events.test.js`

**Interfaces:**
- Consumes: everything in Tasks 2, 4 and 5; `ApiError` from `gitlab.js`.
- Produces:
  - `collectEvents({ watch, snapshot, me, get, now }) -> Promise<{ watch, added: Event[], failures: Error[] }>`
    - `get(url) -> Promise<{ body, nextPage }>` — the worker passes its `authorizedGet`.
    - Never rejects on a fetch failure: each failure lands in `failures`, and its entry is left as `planWatch` returned it.

- [ ] **Step 1: Write the failing tests**

Extend the `events.js` import with `collectEvents`, the `gitlab.js` import with `ApiError, discussionsUrl, mergeRequestUrl, notesUrl`. Append:

```js
/** A fake `get` over a URL → response map; any other URL rejects like a 404 would. */
function fakeGet(routes) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (!route) throw new ApiError(404, `GET ${url} responded 404`);
    return { body: route.body, nextPage: route.nextPage ?? '' };
  };
  return { get, calls };
}

const REVIEWED = mr({
  id: 901,
  iid: 8,
  title: 'Split the poller in two',
  url: 'https://gitlab.com/group/project/-/merge_requests/8',
  reference: 'group/project!8',
  updatedAt: T(11, 10),
  notesCount: 5,
});

async function scenario() {
  return {
    watch: {
      900: entry({ since: T(9, 30) }),
      901: entry({ iid: 8, role: 'reviewer', updatedAt: T(10, 30), since: T(10, 30), notesCount: 0 }),
      902: entry({ iid: 9 }),
    },
    snapshot: snapshot({ mine: [mr({ updatedAt: T(10, 10), notesCount: 3 })], reviews: [REVIEWED] }),
    routes: {
      [notesUrl(55, 7)]: { body: await fixture('notes/author_notes') },
      [notesUrl(55, 8)]: { body: await fixture('notes/reviewer_notes') },
      [discussionsUrl(55, 8, 1)]: { body: await fixture('notes/discussions') },
      [mergeRequestUrl(55, 9)]: { body: await fixture('notes/merge_request_closed') },
    },
  };
}

test('collectEvents raises every kind the fixtures hold, and nothing else', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  const { get } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.added.map((event) => `${event.id} ${event.kind}`).sort(), [
    'closed:902 closed',
    'note:1006 approved',
    'note:1007 unapproved',
    'note:1008 changes_requested',
    'note:1010 comment',
    'note:2004 commits',
    'note:2005 reply',
  ]);
});

test('collectEvents advances fetched entries and removes a resolved disappearance', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  const { get } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.deepEqual(result.watch, {
    900: entry({ since: T(9, 30), updatedAt: T(10, 10), notesCount: 3, lastNoteId: 1010 }),
    901: entry({
      iid: 8,
      role: 'reviewer',
      since: T(10, 30),
      updatedAt: T(11, 10),
      notesCount: 5,
      lastNoteId: 2007,
    }),
  });
});

test('collectEvents leaves a failed entry unadvanced and reports the failure', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  const outage = new ApiError(503, 'unavailable');
  routes[notesUrl(55, 7)] = outage;
  const { get } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.deepEqual(result.failures, [outage]);
  assert.deepEqual(result.watch[900], watch[900]);
  assert.ok(result.added.every((event) => !event.id.startsWith('note:10')));
});

test('collectEvents fails a reviewer entry whose discussion walk fails', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  routes[discussionsUrl(55, 8, 1)] = new ApiError(500, 'boom');
  const { get } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.watch[901], watch[901]);
  assert.ok(result.added.every((event) => !event.id.startsWith('note:20')));
});

test('collectEvents removes a disappeared MR that is gone, without a failure', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  delete routes[mergeRequestUrl(55, 9)];
  const { get } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.deepEqual(result.failures, []);
  assert.equal(result.watch[902], undefined);
  assert.ok(result.added.every((event) => event.id !== 'closed:902'));
});

test('collectEvents keeps a disappeared entry whose lookup fails for another reason', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  routes[mergeRequestUrl(55, 9)] = new ApiError(429, 'slow down');
  const { get } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.watch[902], watch[902]);
});

test('collectEvents walks at most five discussion pages', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  for (let page = 1; page <= 6; page += 1) {
    routes[discussionsUrl(55, 8, page)] = { body: [], nextPage: String(page + 1) };
  }
  const { get, calls } = fakeGet(routes);
  const result = await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.equal(calls.filter((url) => url.includes('/discussions')).length, 5);
  assert.ok(result.added.every((event) => event.kind !== 'reply'));
  assert.equal(result.watch[901].lastNoteId, 2007);
});

test('collectEvents skips the discussion walk when no note is a reply candidate', async () => {
  const { watch, snapshot: snap, routes } = await scenario();
  routes[notesUrl(55, 8)] = { body: (await fixture('notes/reviewer_notes')).slice(3) };
  const { get, calls } = fakeGet(routes);
  await collectEvents({ watch, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.equal(calls.filter((url) => url.includes('/discussions')).length, 0);
});

test('collectEvents on a first poll baselines everything and fetches nothing', async () => {
  const { snapshot: snap } = await scenario();
  const { get, calls } = fakeGet({});
  const result = await collectEvents({ watch: {}, snapshot: snap, me: ME, get, now: T(13, 0) });
  assert.deepEqual(calls, []);
  assert.deepEqual(result.added, []);
  assert.deepEqual(Object.keys(result.watch).sort(), ['900', '901']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `collectEvents` is not exported.

- [ ] **Step 3: Implement**

Change the imports at the top of `src/events.js` to:

```js
import { DISCUSSION_PAGES_MAX, EVENTS_MAX, EVENTS_MAX_AGE_MS, EXCERPT_MAX } from './config.js';
import {
  ApiError,
  discussionsUrl,
  mapDiscussion,
  mapNote,
  mapOutcome,
  mergeRequestUrl,
  notesUrl,
} from './gitlab.js';
import { coveredByTodo } from './store.js';
```

Append:

```js
async function walkDiscussions(get, entry) {
  const discussions = [];
  for (let page = 1; page <= DISCUSSION_PAGES_MAX; page += 1) {
    const { body, nextPage } = await get(discussionsUrl(entry.projectId, entry.iid, page));
    discussions.push(...body.map(mapDiscussion));
    if (nextPage === '') break;
  }
  return discussions;
}

async function inspectChanged(get, entry, mr, me) {
  const notes = (await get(notesUrl(entry.projectId, entry.iid))).body.map(mapNote);
  const events = [];
  const candidates = new Map();
  for (const note of newNotes(notes, entry)) {
    const kind = classifyNote(note, entry, me);
    if (kind === REPLY_CANDIDATE) candidates.set(note.id, note);
    else if (kind) events.push(noteEvent(kind, note, mr));
  }
  if (candidates.size > 0) {
    const discussions = await walkDiscussions(get, entry);
    for (const id of replyNoteIds(discussions, new Set(candidates.keys()), me)) {
      events.push(noteEvent('reply', candidates.get(id), mr));
    }
  }
  return { entry: advanceEntry(entry, mr, notes), events };
}

async function inspectDisappeared(get, entry, me, now) {
  try {
    const outcome = mapOutcome((await get(mergeRequestUrl(entry.projectId, entry.iid))).body);
    const event = outcomeEvent(outcome, me, now);
    return { entry: null, events: event ? [event] : [] };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { entry: null, events: [] };
    throw error;
  }
}

/**
 * One detection pass over a fresh snapshot (notifications design §4.2, §4.4).
 *
 * Returns the watch to store, the new events, and every fetch failure. A failure never
 * rejects the pass: its entry stays as `planWatch` returned it, so the next poll retries it and
 * nothing is lost or raised twice. A disappeared merge request that answers 404 is gone for good
 * and is removed without a failure. `now` stamps an outcome GitLab reports without a timestamp.
 */
export async function collectEvents({ watch, snapshot, me, get, now }) {
  const plan = planWatch(watch, snapshot);
  const mrs = new Map(
    [...(snapshot.reviews ?? []), ...(snapshot.mine ?? [])].map((mr) => [String(mr.id), mr]),
  );
  const jobs = [
    ...plan.changed.map((id) => [id, inspectChanged(get, plan.watch[id], mrs.get(id), me)]),
    ...plan.disappeared.map((id) => [id, inspectDisappeared(get, plan.watch[id], me, now)]),
  ];
  const settled = await Promise.allSettled(jobs.map(([, job]) => job));

  const next = { ...plan.watch };
  const added = [];
  const failures = [];
  settled.forEach((result, index) => {
    const [id] = jobs[index];
    if (result.status === 'rejected') {
      failures.push(result.reason);
      return;
    }
    if (result.value.entry) next[id] = result.value.entry;
    else delete next[id];
    added.push(...result.value.events);
  });
  return { watch: next, added, failures };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "feat: run one event detection pass over a snapshot"
```

---

### Task 7 (only if Task 1 found `updated_at` does not move): periodic sweep of own merge requests

Skip this task entirely if Task 1 recorded that all three actions moved `updated_at`.

**Files:**
- Modify: `src/config.js`
- Modify: `src/events.js`
- Modify: `docs/2026-09-30-notifications-design.md` (§4.1)
- Test: `test/events.test.js`

**Interfaces:**
- Changes: `WatchEntry` gains `checkedAt: number` (ms since epoch, local clock). `planWatch(watch, snapshot, now)` and `advanceEntry(entry, mr, notes, now)` gain a trailing `now`. `collectEvents` passes its `now` to both.

- [ ] **Step 1: Write the failing tests**

In `test/events.test.js`, add `checkedAt: T(9, 30)` to the `entry` helper's defaults, and pass `T(9, 30)` as the third argument to every `planWatch(...)` call and the fourth to every `advanceEntry(...)` call. Update the advanced expectations:

- `'advanceEntry moves to the MR’s state and the newest note fetched'`: call `advanceEntry(entry(), mr({ updatedAt: T(10, 10), notesCount: 4 }), notes, T(10, 11))` and expect `entry({ updatedAt: T(10, 10), notesCount: 4, lastNoteId: 1010, checkedAt: T(10, 11) })`.
- `'collectEvents advances fetched entries …'`: both expected entries gain `checkedAt: T(13, 0)`.

Append:

```js
test('planWatch sweeps an unchanged author entry after five minutes', () => {
  const watch = { 900: entry({ checkedAt: T(9, 30) }) };
  assert.deepEqual(planWatch(watch, snapshot({ mine: [mr()] }), T(9, 34)).changed, []);
  assert.deepEqual(planWatch(watch, snapshot({ mine: [mr()] }), T(9, 35)).changed, ['900']);
});

test('planWatch never sweeps a reviewer entry', () => {
  const watch = { 901: entry({ iid: 8, role: 'reviewer', checkedAt: T(9, 30) }) };
  const plan = planWatch(watch, snapshot({ reviews: [mr({ id: 901, iid: 8 })] }), T(11, 0));
  assert.deepEqual(plan.changed, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — entries lack `checkedAt`; the sweep tests find no change.

- [ ] **Step 3: Implement**

Append to `src/config.js`:

```js
// An own merge request is re-read at least this often, changed or not: approvals, revoked
// approvals and requested changes do not move its updated_at (notifications design §8).
export const AUTHOR_SWEEP_MS = 300_000;
```

In `src/events.js`, import `AUTHOR_SWEEP_MS` from `./config.js`. In `planWatch(watch, snapshot, now)`: add `checkedAt: now` to a new entry, and replace the change test with

```js
    const moved = known.updatedAt !== mr.updatedAt || known.notesCount !== mr.notesCount;
    const due = role === 'author' && now - (known.checkedAt ?? 0) >= AUTHOR_SWEEP_MS;
    if (moved || due) changed.push(id);
```

Replace `advanceEntry` with:

```js
export function advanceEntry(entry, mr, notes, now) {
  const newest = notes.reduce((max, note) => Math.max(max, note.id), entry.lastNoteId);
  return {
    ...entry,
    updatedAt: mr.updatedAt,
    notesCount: mr.notesCount,
    lastNoteId: newest,
    checkedAt: now,
  };
}
```

In `collectEvents`, call `planWatch(watch, snapshot, now)` and pass `now` through `inspectChanged(get, entry, mr, me, now)` to `advanceEntry(entry, mr, notes, now)`.

Update both doc comments to mention the sweep, citing `notifications design §8`. In spec §4.1, add to the `watch` entry:

```js
    checkedAt: number,             // ms since epoch, local clock; when an 'author' entry was
                                   // last fetched, for the 5-minute sweep of §8
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/events.js test/events.test.js docs/2026-09-30-notifications-design.md
git commit -m "feat: sweep own merge requests for approval changes every five minutes"
```

---

### Task 8: Service worker — run detection after each poll

**Files:**
- Modify: `src/background.js`

**Interfaces:**
- Consumes: `collectEvents`, `mergeEvents` (Tasks 5, 6); `pruneReadIds`, `badgeCount(inbox, readIds, events)` (Task 3).
- Produces: storage keys `watch` and `events` kept current by every successful poll.

No unit test: this file is the `chrome.*` boundary. Its logic lives in the modules already tested; the wiring is covered by the manual checklist in Task 10.

- [ ] **Step 1: Update the imports**

Replace the `store.js` import and add the `events.js` import:

```js
import { collectEvents, mergeEvents } from './events.js';
import { badgeCount, pruneReadIds, read, write } from './store.js';
```

- [ ] **Step 2: Add the session reset**

Below `NETWORK_ERROR_FIRST_RUN`:

```js
// Everything a session accumulates besides its tokens. Written on sign-in and sign-out, so one
// session's snapshot, read marks, error, watch state and events never leak into the next
// (design §6, notifications design §5).
const EMPTY_SESSION = { inbox: null, readIds: {}, backoffUntil: 0, watch: {}, events: [] };
```

In `handleSignIn`, replace `await write({ inbox: null, readIds: {}, backoffUntil: 0 });` (and the comment above it) with `await write(EMPTY_SESSION);`. In `handleMessage`'s `'signOut'` case, replace `await write({ inbox: null, readIds: {}, backoffUntil: 0 });` with `await write(EMPTY_SESSION);`.

- [ ] **Step 3: Count events on the badge**

In `applyBadge`, replace the read and the final line:

```js
  const { auth, inbox, readIds, events } = await read('auth', 'inbox', 'readIds', 'events');
```

```js
  await setBadge(badgeText(badgeCount(inbox, readIds, events)), BADGE_COLOR);
```

Update its doc comment's first sentence to: "The badge counts the Notifications feed plus the merge requests awaiting the user's review (design §8, notifications design §7)."

- [ ] **Step 4: Replace the local prune with the store's**

Delete the local `pruneReadIds` function and its doc comment.

- [ ] **Step 5: Add the detection step**

Above `poll`:

```js
// Failures of these kinds are the session's, not one merge request's, and are handled as a
// failed poll; any other detection failure is logged and retried by the next poll
// (notifications design §4.4).
const FATAL_DETECTION_KINDS = ['auth', 'ratelimit'];

/**
 * Derives events from a freshly written snapshot and stores them with the next watch state
 * (notifications design §4.2). Writes nothing once the session is gone, so a sign-out during the
 * requests cannot resurrect what it cleared (§4.4).
 */
async function detectEvents(me, snapshot) {
  const { watch, events } = await read('watch', 'events');
  const result = await collectEvents({ watch, snapshot, me, get: authorizedGet, now: Date.now() });
  const { auth } = await read('auth');
  if (!auth) return;
  await write({
    watch: result.watch,
    events: mergeEvents(events, result.added, snapshot.todos, Date.now()),
  });
  for (const failure of result.failures) console.error('event detection failed', failure);
  const fatal = result.failures.filter((failure) => FATAL_DETECTION_KINDS.includes(errorKind(failure)));
  if (fatal.length > 0) throw mostSevere(fatal);
}
```

- [ ] **Step 6: Wire it into the poll**

In `poll`, replace the block from the `// Read here rather than alongside` comment through the `await write({ inbox: snapshot, readIds: … })` line with:

```js
    await write({ inbox: snapshot, backoffUntil: 0 });
    await detectEvents(me, snapshot);
    // Read here rather than alongside `auth` at the top: the requests above take as long as
    // they take, and a `markRead` that lands while they are in flight must not be pruned away
    // by a snapshot that predates it.
    const { readIds, events } = await read('readIds', 'events');
    await write({ readIds: pruneReadIds(readIds, snapshot.todos, events) });
```

(The comment above the read is an existing one being moved, not a new in-body comment.)

Update `poll`'s doc comment: append "Event detection runs after the snapshot is written, so the lists are never held back by it (notifications design §4.2)."

- [ ] **Step 7: Check the module boundary and the suite**

Run: `grep -n "chrome\." src/events.js src/gitlab.js src/format.js`
Expected: no output.

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 8: Load it**

Ask the user to reload the unpacked extension in `chrome://extensions`, open the service worker console and confirm there are no errors on load and after the first alarm. Wait for the answer.

- [ ] **Step 9: Commit**

```bash
git add src/background.js
git commit -m "feat: derive notification events after every successful poll"
```

---

### Task 9: Popup — the Notifications tab and event rows

**Files:**
- Modify: `src/format.js`
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.js`
- Test: `test/format.test.js`

**Interfaces:**
- Consumes: `TABS`, `resolveTab`, `notificationFeed` (Task 3); the `Event` shape (spec §5).
- Produces: `eventLabel(kind) -> string` in `format.js`.

- [ ] **Step 1: Write the failing test**

In `test/format.test.js`, add `eventLabel` to the import and append:

```js
test('eventLabel names every event kind', () => {
  assert.equal(eventLabel('comment'), 'New comment');
  assert.equal(eventLabel('reply'), 'Reply in your thread');
  assert.equal(eventLabel('commits'), 'New commits');
  assert.equal(eventLabel('approved'), 'Approved');
  assert.equal(eventLabel('unapproved'), 'Approval revoked');
  assert.equal(eventLabel('changes_requested'), 'Changes requested');
  assert.equal(eventLabel('merged'), 'Merged');
  assert.equal(eventLabel('closed'), 'Closed');
});

test('eventLabel falls back to a sentence-case kind', () => {
  assert.equal(eventLabel('something_new'), 'Something new');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `eventLabel` is not exported.

- [ ] **Step 3: Implement `eventLabel`**

Append to `src/format.js`:

```js
// The lead line of an event row in the Notifications tab (notifications design §6).
const EVENT_LABELS = {
  comment: 'New comment',
  reply: 'Reply in your thread',
  commits: 'New commits',
  approved: 'Approved',
  unapproved: 'Approval revoked',
  changes_requested: 'Changes requested',
  merged: 'Merged',
  closed: 'Closed',
};

/** An event kind as its row's lead line; an unknown kind reads as its sentence-case name. */
export function eventLabel(kind) {
  return EVENT_LABELS[kind] ?? humaniseAction(kind);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Rename the tab in the markup**

In `src/popup/popup.html`, replace the first tab button:

```html
        <button type="button" class="tab" data-tab="notifications" role="tab">
          Notifications <span class="count" data-count="notifications"></span>
        </button>
```

and the sign-in lead:

```html
      <p class="signin-lead">Sign in to see your GitLab notifications and merge requests.</p>
```

- [ ] **Step 6: Rewrite the popup's list logic**

In `src/popup/popup.js`:

Imports:

```js
import { eventLabel, humaniseAction, relativeTime } from '../format.js';
import { TABS, notificationFeed, onChanged, read, resolveTab, write } from '../store.js';
```

Delete the local `TABS` constant and its comment that Task 3 Step 4 added.

Replace `EMPTY_MESSAGES` with:

```js
const EMPTY_MESSAGES = {
  notifications: 'No notifications.',
  reviews: 'Nothing is waiting on your review.',
  mine: 'You have no open merge requests.',
};

// The snapshot list whose truncation each tab reports. Events are held locally and never cut
// short by a page size, so the Notifications tab reports the to-do list's (design §7).
const TRUNCATION_KEYS = { notifications: 'todos', reviews: 'reviews', mine: 'mine' };
```

Replace `renderTabs`, `visibleItems`, `titleFor` and `metaFor` (with their doc comments) with:

```js
function renderTabs(inbox, events, readIds, activeTab) {
  for (const tab of TABS) {
    document
      .querySelector(`.tab[data-tab="${tab}"]`)
      .setAttribute('aria-selected', String(tab === activeTab));
    document.querySelector(`.count[data-count="${tab}"]`).textContent = inbox
      ? String(visibleItems(inbox, events, readIds, tab).length)
      : '';
  }
}

/**
 * The rows a tab shows. Only the Notifications tab can be marked read: the other two lists
 * mirror live GitLab state, where hiding a row would just lose the user a merge request that is
 * still open and still theirs.
 */
function visibleItems(inbox, events, readIds, tab) {
  return tab === 'notifications'
    ? notificationFeed(inbox, events, readIds)
    : (inbox[tab] ?? []);
}

/**
 * The row's lead line. An event leads with its kind, a to-do with what it asks of the user —
 * "Review requested" — falling back to its subject when it has no action name; a merge request
 * leads with its title.
 */
function titleFor(item) {
  if (item.source === 'event') return eventLabel(item.kind);
  if (item.source === 'todo') return humaniseAction(item.actionName) || item.title;
  return item.title;
}

function metaFor(item) {
  const parts =
    item.source === 'event'
      ? [item.mrReference, item.actorName, relativeTime(item.createdAt)]
      : item.source === 'todo'
        ? [item.project, item.authorName, relativeTime(item.createdAt)]
        : [item.reference, item.authorName, relativeTime(item.updatedAt)];
  return parts.filter(Boolean).join(' · ');
}

/** An event's tooltip carries its MR title and, for a comment, the excerpt (notifications design §6). */
function tooltipFor(item) {
  if (item.source !== 'event') return item.title;
  return item.excerpt ? `${item.mrTitle}\n\n${item.excerpt}` : item.mrTitle;
}
```

Update `markRead`'s doc comment first sentence to "Hides a to-do or an event for good." — the body is unchanged.

Replace `buildRow` with:

```js
/**
 * Builds one row from the template. Titles and comments come from the API, so every insertion
 * goes through textContent — never innerHTML.
 *
 * A row whose target was deleted has no URL; clicking it does nothing rather than closing the
 * popup with nothing to show. The read button is removed, not hidden, on the other tabs:
 * `.row-read` sets its own `display`, which would beat `[hidden] { display: none }`.
 */
function buildRow(item, tab) {
  const node = rowTemplate.content.firstElementChild.cloneNode(true);
  const open = node.querySelector('.row-open');
  const isEvent = item.source === 'event';

  const avatar = open.querySelector('.row-avatar');
  setAvatar(avatar, (isEvent ? item.actorAvatar : item.authorAvatar) ?? '');
  avatar.alt = (isEvent ? item.actorName : item.authorName) ?? '';

  open.querySelector('.chip').hidden = item.draft !== true;
  open.querySelector('.row-title-text').textContent = titleFor(item);
  open.querySelector('.row-meta').textContent = metaFor(item);
  open.title = tooltipFor(item);

  open.addEventListener('click', async () => {
    if (!item.url) return;
    if (tab === 'notifications') await markRead(item);
    chrome.tabs.create({ url: item.url });
    window.close();
  });

  const readButton = node.querySelector('.row-read');
  if (tab === 'notifications') {
    readButton.addEventListener('click', () => {
      markRead(item);
      render();
    });
  } else {
    readButton.remove();
  }

  return node;
}
```

In `renderList(inbox, events, readIds, activeTab)` — add the `events` parameter — change the three lines that use the tab:

```js
  const items = visibleItems(inbox, events, readIds, activeTab);
```

```js
  } else if (inbox.truncated?.[TRUNCATION_KEYS[activeTab]]) {
```

In `render`, destructure `events` and resolve the tab:

```js
  const { auth, me, inbox, readIds, ui, events } = state;
```

```js
  const activeTab = resolveTab(ui?.activeTab);
  renderHeader(me);
  renderTabs(inbox, events, readIds, activeTab);
  renderList(inbox, events, readIds, activeTab);
  renderFooter(inbox);
```

- [ ] **Step 7: Check nothing still names the old tab**

Run: `grep -n "'todos'" src/popup/popup.js`
Expected: exactly one line — the `TRUNCATION_KEYS` entry.

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 8: Look at it**

Ask the user to reload the extension and open the popup. Expected: the first tab reads "Notifications" with a count, existing to-dos appear in it, and there are no errors in the popup's DevTools console (right-click the popup → Inspect). Wait for the answer.

- [ ] **Step 9: Commit**

```bash
git add src/format.js src/popup/popup.html src/popup/popup.js test/format.test.js
git commit -m "feat: show to-dos and events in one Notifications tab"
```

---

### Task 10: Documentation and the manual checklist

**Files:**
- Modify: `README.md`
- Modify: `docs/2026-09-30-notifications-design.md` (status line)

- [ ] **Step 1: Update the README's opening paragraph**

Replace the first paragraph of `README.md` with:

```markdown
A Chrome/Edge extension that keeps one GitLab.com account's review workload on the toolbar:
a badge counting unread notifications and the merge requests awaiting your review, and a popup
with three read-only lists — notifications (pending to-dos plus events on your merge requests
and the ones you review), merge requests awaiting your review, and your own open merge requests.

Design: [`docs/2026-09-09-gitlab-inbox-design.md`](docs/2026-09-09-gitlab-inbox-design.md),
extended by [`docs/2026-09-30-notifications-design.md`](docs/2026-09-30-notifications-design.md).
```

- [ ] **Step 2: Rename the To-dos references in the checklist**

In the `## Manual checklist` section of `README.md`, replace every "To-dos tab" with "Notifications tab" and "To-dos row" with "Notifications row". Run `grep -n "To-dos" README.md` — expected: no output.

- [ ] **Step 3: Add the Notifications section to the checklist**

Insert after the `Lists` group, in the same two-box format:

```markdown
Notifications

Use a throwaway merge request of your own and one you are a reviewer on; a colleague or a
second account performs the actions. `node scripts/inspect-mr.mjs <project> <iid>` shows what
GitLab recorded when a row does not appear.

- [ ] Chrome  [ ] Edge — Upgrading from the previous version opens the popup on Notifications,
      and the first poll adds no events for comments that already existed.
- [ ] Chrome  [ ] Edge — A comment by someone else on your MR appears as "New comment" within
      about a minute; its tooltip shows the MR title and the comment.
- [ ] Chrome  [ ] Edge — Your own comment on your MR raises nothing.
- [ ] Chrome  [ ] Edge — A comment that `@mentions` you shows once, as the to-do, not also as
      an event.
- [ ] Chrome  [ ] Edge — Approve, revoke approval and "Request changes" on your MR each appear
      with their own label.
- [ ] Chrome  [ ] Edge — A reply in a thread you started on a reviewed MR appears as "Reply in
      your thread"; a comment in a thread you are not in does not.
- [ ] Chrome  [ ] Edge — A push to a reviewed MR appears as "New commits".
- [ ] Chrome  [ ] Edge — Your MR merged by someone else appears as "Merged"; merged by you,
      nothing appears.
- [ ] Chrome  [ ] Edge — Your MR closed by someone else appears as "Closed".
- [ ] Chrome  [ ] Edge — An event on an MR in the Review list does not raise the badge a second
      time.
- [ ] Chrome  [ ] Edge — The eye button and a click each hide an event from the tab, the count
      and the badge, and it stays hidden after the next poll and a browser restart.
- [ ] Chrome  [ ] Edge — Signing out while a poll is in flight (sign out right after pressing
      Refresh) leaves `watch` and `events` empty in storage.
```

- [ ] **Step 4: Mark the spec implemented**

In `docs/2026-09-30-notifications-design.md`, change `Status: draft, awaiting review` to `Status: implemented`.

- [ ] **Step 5: Final check**

Run: `npm test`
Expected: PASS, all suites.

Run: `grep -rnw "TODO\|TBD" src test docs/2026-09-30-notifications-design.md`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/2026-09-30-notifications-design.md
git commit -m "docs: document notifications and add them to the manual checklist"
```

- [ ] **Step 7: Walk the checklist**

Ask the user to walk the new Notifications group in both browsers. Record failures as findings; do not tick boxes on the user's behalf.
