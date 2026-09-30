import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  REPLY_CANDIDATE,
  advanceEntry,
  classifyNote,
  mergeEvents,
  newNotes,
  noteEvent,
  outcomeEvent,
  planWatch,
  replyNoteIds,
} from '../src/events.js';
import { mapDiscussion, mapNote, mapOutcome } from '../src/gitlab.js';

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

test('classifyNote on the user\'s own MR', async () => {
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

test('advanceEntry moves to the MR\'s state and the newest note fetched', async () => {
  const notes = await notesFixture('author_notes');
  const next = advanceEntry(entry(), mr({ updatedAt: T(10, 10), notesCount: 4 }), notes);
  assert.deepEqual(next, entry({ updatedAt: T(10, 10), notesCount: 4, lastNoteId: 1010 }));
});

test('advanceEntry never moves lastNoteId backwards', () => {
  const next = advanceEntry(entry({ lastNoteId: 1010 }), mr(), []);
  assert.equal(next.lastNoteId, 1010);
});

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

test('outcomeEvent is silent for the user\'s own merge or close', () => {
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
