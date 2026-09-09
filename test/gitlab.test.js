import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ApiError,
  apiGet,
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

test('mapTodo takes the title from the target even when body carries different text', async () => {
  const [, , todo] = await fixture('todos');
  const mapped = mapTodo(todo);
  // A `mentioned` to-do carries the note text in `body` and the merge request's title in
  // `target`, so this is the case that distinguishes the two fallback orders.
  assert.equal(mapped.title, 'Replace the retry loop with a single alarm');
  assert.notEqual(mapped.title, todo.body);
  assert.equal(mapped.url, 'https://gitlab.com/group/project/-/merge_requests/9#note_11');
  assert.equal(mapped.createdAt, Date.UTC(2026, 8, 9, 10, 15, 0));
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

describe('apiGet', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns the parsed body, with nextPage empty when the header is absent', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 42 }), { status: 200 });
    assert.deepEqual(await apiGet('https://gitlab.com/api/v4/user', 'tok'), {
      body: { id: 42 },
      nextPage: '',
    });
  });

  it('carries the x-next-page header value in nextPage when present', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { 'x-next-page': '2' } });
    const result = await apiGet('https://gitlab.com/api/v4/todos', 'tok');
    assert.equal(result.nextPage, '2');
  });

  it('sends the token as a Bearer Authorization header', async () => {
    let seenHeaders;
    globalThis.fetch = async (_url, init) => {
      seenHeaders = init.headers;
      return new Response('{}', { status: 200 });
    };
    await apiGet('https://gitlab.com/api/v4/user', 'secret-token');
    assert.equal(seenHeaders.Authorization, 'Bearer secret-token');
  });

  it('throws ApiError with the real status and kind for a 401', async () => {
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(apiGet('https://gitlab.com/api/v4/user', 'tok'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.kind, 'auth');
      return true;
    });
  });

  it('throws ApiError with the real status and kind for a 429', async () => {
    globalThis.fetch = async () => new Response(null, { status: 429 });
    await assert.rejects(apiGet('https://gitlab.com/api/v4/todos', 'tok'), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.kind, 'ratelimit');
      return true;
    });
  });
});
