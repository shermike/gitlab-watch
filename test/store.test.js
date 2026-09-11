import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LISTS, badgeCount, unread } from '../src/store.js';

// `store.js` touches `chrome.*` only inside its storage functions, so the read-state helpers
// it also exports load and run under `node --test` unchanged.

const todos = [{ id: 1 }, { id: 2 }, { id: 3 }];

test('LISTS names the three snapshot lists', () => {
  assert.deepEqual(LISTS, ['todos', 'reviews', 'mine']);
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
