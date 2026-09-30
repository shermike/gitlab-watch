import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TABS,
  badgeCount,
  coveredByTodo,
  notificationFeed,
  pruneReadIds,
  resolveTab,
  unread,
} from '../src/store.js';

// `store.js` touches `chrome.*` only inside its storage functions, so the read-state helpers
// it also exports load and run under `node --test` unchanged.

const todos = [{ id: 1 }, { id: 2 }, { id: 3 }];

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

test('unread drops exactly the marked to-dos and keeps the order', () => {
  assert.deepEqual(unread(todos, { 2: true }), [{ id: 1 }, { id: 3 }]);
});

// The ids arrive from the API as numbers but reach storage as object keys, which JSON and
// `chrome.storage` both hand back as strings.
test('unread matches a numeric id against its string key', () => {
  assert.deepEqual(unread(todos, JSON.parse('{"2": true}')), [{ id: 1 }, { id: 3 }]);
});

test('unread tolerates a missing list and a missing map', () => {
  assert.deepEqual(unread(undefined, {}), []);
  assert.deepEqual(unread(todos, undefined), todos);
});

const MR_URL = 'https://gitlab.com/group/backend/-/merge_requests/5';

const snapshot = (overrides) => ({ todos: [], reviews: [], mine: [], ...overrides });

test('badgeCount adds the reviews to the unread to-dos', () => {
  const inbox = snapshot({
    todos: [
      { id: 1, url: 'https://gitlab.com/group/backend/-/issues/1' },
      { id: 2, url: 'https://gitlab.com/group/backend/-/issues/2' },
    ],
    reviews: [{ id: 11, url: MR_URL }],
    // `mine` is never counted: an MR of one's own is not work waiting on the user.
    mine: [{ id: 21, url: 'https://gitlab.com/group/backend/-/merge_requests/9' }],
  });
  assert.equal(badgeCount(inbox, {}), 3);
});

// The usual case: GitLab raises a `review_requested` to-do for the very MR that is already in
// the review list. One piece of work must show as one.
test('badgeCount does not count an MR twice through its own to-do', () => {
  const inbox = snapshot({
    todos: [{ id: 1, url: MR_URL }],
    reviews: [{ id: 11, url: MR_URL }],
  });
  assert.equal(badgeCount(inbox, {}), 1);
});

test('badgeCount matches a to-do raised by a comment on a reviewed MR', () => {
  const inbox = snapshot({
    todos: [{ id: 1, url: `${MR_URL}#note_17` }],
    reviews: [{ id: 11, url: MR_URL }],
  });
  assert.equal(badgeCount(inbox, {}), 1);
});

// Marking the to-do read says the user has seen it, not that the review is done — which is
// exactly why the review keeps the badge lit.
test('badgeCount keeps a review after its to-do is marked read', () => {
  const inbox = snapshot({ todos: [{ id: 1, url: MR_URL }], reviews: [{ id: 11, url: MR_URL }] });
  assert.equal(badgeCount(inbox, { 1: true }), 1);
});

test('badgeCount drops a to-do marked read that no review covers', () => {
  const inbox = snapshot({ todos: [{ id: 1, url: 'https://gitlab.com/group/backend/-/issues/1' }] });
  assert.equal(badgeCount(inbox, { 1: true }), 0);
});

// A to-do on a deleted target has no URL, and neither has an MR the API returned without one;
// neither may be treated as a match for the other.
test('badgeCount counts a to-do with no URL', () => {
  const inbox = snapshot({ todos: [{ id: 1, url: '' }], reviews: [{ id: 11, url: '' }] });
  assert.equal(badgeCount(inbox, {}), 2);
});

test('badgeCount is zero before the first snapshot', () => {
  assert.equal(badgeCount(null, {}), 0);
  assert.equal(badgeCount(undefined, undefined), 0);
});

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
