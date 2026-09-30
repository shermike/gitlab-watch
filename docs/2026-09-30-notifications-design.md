# GitLab Inbox — Notifications

Date: 2026-09-30
Status: implemented; the §8 assumption is not yet verified on gitlab.com

Extends [`2026-09-09-gitlab-inbox-design.md`](2026-09-09-gitlab-inbox-design.md). Where the two
disagree, this document wins; the sections it replaces are named in §10.

## 1. Purpose

The To-dos tab becomes **Notifications**: one feed, newest first, holding the pending to-dos it
shows today plus events the extension derives itself by comparing one poll with the next.
GitLab raises a to-do only when the user is mentioned, assigned or asked for a review; the
events below are the ones it does not raise a to-do for, and that the user still wants to see.

| Kind | Raised when | Merge requests watched |
|---|---|---|
| `comment` | someone other than the user leaves a comment | mine |
| `reply` | someone other than the user replies in a thread the user has a note in | reviews |
| `commits` | someone other than the user pushes commits | reviews |
| `approved` | someone approves | mine |
| `unapproved` | someone revokes an approval | mine |
| `changes_requested` | a reviewer requests changes | mine |
| `merged` | someone other than the user merges it | mine |
| `closed` | someone other than the user closes it without merging | mine |

"Mine" and "reviews" are the two merge-request lists the snapshot already carries (design §7).

## 2. Non-goals

- OS-level desktop notifications (`chrome.notifications`) — still out of scope.
- Events on merge requests beyond the first page of either list. A merge request that is not in
  the snapshot is not watched.
- Events on issues, epics, commits or pipelines. Pipeline failures and merge conflicts already
  arrive as to-dos (`build_failed`, `unmergeable`) and need nothing here.
- Events that happened before the extension first saw a merge request (§4.2).
- Marking anything done in GitLab: the scope stays `read_api`.

## 3. Decisions

| Decision | Rationale |
|---|---|
| Events are derived from notes, including system notes | Approvals, requested changes and pushed commits each leave a system note on the merge request. One source — the notes list — covers six of the eight kinds, so there is one fetch path and one classifier to test. |
| Notes are fetched only for a merge request that changed | A fetch per watched merge request per minute would be up to 100 requests a poll. A change in `updated_at` or `user_notes_count` since the last poll is the trigger, so a quiet minute costs nothing beyond the three list requests. |
| `merged` and `closed` are detected by disappearance | A merge request that leaves the `mine` list was merged, closed, or pushed past the first page. One `GET` of that single merge request tells which, and names who did it. Nothing is spent while nothing disappears. |
| A new merge request is baselined without a fetch | The first time a merge request is seen, only its identity and its `updated_at` are stored. Notes created at or before that moment are never events, so signing in does not flood the feed with history. `updated_at` is GitLab's own clock, the same one that stamps `created_at` on notes, so a skewed local clock can neither hide a fresh note nor resurrect an old one. |
| A comment that raised a to-do is shown once | A comment that mentions the user raises a `mentioned` or `directly_addressed` to-do whose `target_url` ends in `#note_<id>`. The to-do is what the user acts on; the event for the same note is dropped. |
| Events live outside `inbox` | `inbox` is replaced wholesale on every poll (design §6); events accumulate across polls and are pruned by age and count instead. |
| Read marks are shared with to-dos | One `readIds` map, one eye button, one badge rule. Event ids are strings with a kind prefix and to-do ids are numbers, so the keys cannot collide. |

## 4. Detection

### 4.1 Watch state

`watch` records, for every merge request in `mine` or `reviews`, what the last poll knew:

```js
watch: {
  [mrId: string]: {
    projectId: number,
    iid: number,
    role: 'author' | 'reviewer',   // 'author' wins when the user is both
    updatedAt: number,             // ms since epoch, the MR's updated_at
    notesCount: number,            // the MR's user_notes_count
    since: number,                 // ms since epoch, the MR's updated_at when first seen;
                                   // notes created at or before this are history
    lastNoteId: number,            // highest note id already classified; 0 before the first fetch
  }
}
```

### 4.2 Per poll

Runs after the snapshot of design §7 has been written, so the lists are never held back by
event detection.

1. **New merge requests.** Every merge request in `mine` or `reviews` without a `watch` entry
   gets one with `since` set to its `updated_at`, `lastNoteId = 0` and no request.
2. **Changed merge requests.** Every entry whose `updatedAt` or `notesCount` differs from the
   snapshot is fetched:
   `GET /projects/:projectId/merge_requests/:iid/notes?sort=desc&order_by=created_at&per_page=100`.
   Notes are read newest first and reading stops at the first note whose id is at or below
   `lastNoteId`, or whose `created_at` is at or before `since`. Each remaining note goes through
   the classifier (§4.3).
3. **Replies.** For a `reviewer` entry with at least one remaining non-system note by someone
   else, `GET /projects/:projectId/merge_requests/:iid/discussions?per_page=100` is walked, page
   by page, to find which of those notes sit in a discussion that also holds a note by the user.
   Only those become `reply` events. The walk stops after 5 pages; notes it did not reach are
   dropped rather than guessed at.
4. **Disappeared merge requests.** An `author` entry that is in neither list is fetched with
   `GET /projects/:projectId/merge_requests/:iid`. `state: merged` with a `merge_user` other than
   the user is a `merged` event; `state: closed` with a `closed_by` other than the user is a
   `closed` event. Its entry is then removed. A `reviewer` entry that disappears is removed
   without a request.
5. **Advance.** An entry's `updatedAt`, `notesCount` and `lastNoteId` move forward only once its
   fetches have all succeeded. A failed fetch leaves the entry as it was, so the next poll
   retries it and no event is lost or duplicated.

### 4.3 Classifier

A pure function, `classifyNote(note, entry, me)`, in a new module `src/events.js`:

| Note | Role | Kind |
|---|---|---|
| author is the user | any | none |
| `system: false` | author | `comment` |
| `system: false` | reviewer | reply candidate (§4.2 step 3) |
| `system: true`, body starts `approved this merge request` | author | `approved` |
| `system: true`, body starts `unapproved this merge request` | author | `unapproved` |
| `system: true`, body starts `requested changes` | author | `changes_requested` |
| `system: true`, body matches `^added \d+ commits?\b` | reviewer | `commits` |
| anything else | any | none |

The system-note bodies above are GitLab's current English wording. The test fixtures are written
by hand, and their wording is confirmed against a live merge request on gitlab.com before any
code depends on it (§8). Raw responses are not committed: they carry other people's names and
avatars.

### 4.4 Errors

Event detection never takes the lists down with it: the snapshot is already written when it
starts. A failed fetch leaves its entry unadvanced (§4.2 step 5), and then:

| Failure | Response |
|---|---|
| `auth` or `ratelimit` kind (design §10) | Handled exactly as a failed poll: the session ends, or polling backs off. |
| HTTP 404 on a disappeared merge request | The merge request or its project is gone. The entry is removed and no event is raised. |
| Anything else | Logged to the worker console. No warning strip: the lists are current, and the next poll retries the entry. |

Signing out while a poll is in flight must not resurrect `watch` or `events`: detection writes
nothing once `auth` is gone.

### 4.5 Request budget

A quiet poll adds nothing to the three requests of design §7. Each changed merge request adds one
request, plus up to five for replies; each disappeared one adds one. The limit of 2000
authenticated requests per minute stays irrelevant.

## 5. Storage schema changes

Two keys are added to `chrome.storage.local`:

```js
{
  watch: { ... },        // §4.1

  events: Event[],       // newest first
}
```

```js
Event = {
  id: string,            // 'note:<noteId>' or 'merged:<mrId>' / 'closed:<mrId>'
  kind: 'comment' | 'reply' | 'commits' | 'approved' | 'unapproved'
      | 'changes_requested' | 'merged' | 'closed',
  mrTitle: string,
  mrReference: string,   // 'group/project!123'
  url: string,           // the note's anchor for note events, the MR's web_url otherwise
  actorName: string,
  actorAvatar: string,
  excerpt: string,       // the first 200 characters of a comment or reply; '' otherwise
  createdAt: number,     // ms since epoch
}
```

`events` keeps at most 100 entries and none older than 14 days; both limits are applied on every
write. An event whose id is already present is not added again.

`Mr` (design §6) gains `projectId`, `iid` and `notesCount`, taken from the list response, so the
watch step needs no extra request to address a merge request.

`readIds` now also holds event ids. The prune on every poll (design §6) keeps a mark while its
to-do is in the snapshot or its event is in `events`.

`ui.activeTab` takes `'notifications'` in place of `'todos'`. A stored `'todos'` is read as
`'notifications'`.

`watch` and `events` are cleared on sign-in and sign-out, with the rest of the session.

## 6. Popup

The first tab is labelled **Notifications**. Its rows are the unread to-dos and the unread
events, merged and sorted by `createdAt`, newest first. Its count is the number of those rows.

An event row follows the to-do row layout (design §9):

- lead line: the kind, humanised — "New comment", "Reply in your thread", "New commits",
  "Approved", "Approval revoked", "Changes requested", "Merged", "Closed";
- muted line: `mrReference · actorName · relative time`;
- tooltip: the merge request title, followed by the excerpt when there is one;
- the actor's avatar;
- click opens `url`, marks the event read and closes the popup; the eye button marks it read
  without opening it.

The empty message becomes "No notifications."

## 7. Badge

Unread events are counted alongside unread to-dos. The review-list dedup of design §8 applies to
events too: an event on a merge request that is in `reviews` is not counted a second time,
because the review request already is.

## 8. Testing

New pure-module tests under `node --test`, no dependencies:

1. `classifyNote` over the fixtures of §4.3: a user comment, an own comment, and each system
   note of §4.3.
2. The watch diff: new, changed, unchanged and disappeared merge requests produce the right set
   of fetches.
3. The note walk stops at `lastNoteId` and at `since`.
4. Reply detection: a note in a discussion the user has a note in is a reply; a note in any other
   discussion is not.
5. To-do dedup: a note whose `#note_<id>` a to-do already points at yields no event.
6. The `events` caps: count, age, and duplicate ids.
7. `badgeCount` with events, including one on a merge request in `reviews`.
8. The notifications feed order across to-dos and events.

The manual checklist in `README.md` gains one scenario per event kind, each run against a
throwaway merge request on gitlab.com.

**Assumption to verify before implementation.** Step 2 of §4.2 relies on approvals, revoked
approvals and requested changes changing a merge request's `updated_at`; none of them changes
`user_notes_count`. The GitLab API documentation does not say whether they do. The first task
of the implementation plan approves and unapproves a throwaway merge request and compares
`updated_at` before and after, and reads the system-note wording off the same merge request. If
`updated_at` does not move, every `author` entry is also fetched once every 5 minutes regardless
of change, which bounds the delay of those three kinds to 5 minutes.

## 9. File layout changes

```
src/
  events.js           new — watch diff, note walk, classifier, event caps; no chrome.*
test/
  events.test.js      new
  fixtures/notes/     new — hand-written notes, discussions and single-MR responses
scripts/
  inspect-mr.mjs      new — prints one MR's updated_at and newest notes, for §8's check
```

`gitlab.js` gains the three new URL builders and the mapping of `projectId`, `iid` and
`notesCount`. `background.js` gains the detection step. `store.js` gains the two keys, the feed
builder and the widened `badgeCount`. The popup gains the event row.

## 10. Sections of the base design this replaces

- §2 "issues, pipelines, or any list beyond the three named above" — events on merge requests
  are now in scope, within the limits of §2 here.
- §6 — the schema gains `watch` and `events`; `readIds`, `ui.activeTab` and `Mr` change as in §5.
- §8 — the badge count gains events as in §7.
- §9 — the first tab is Notifications, as in §6.
