import {
  ALARM_NAME,
  ALARM_PERIOD_MINUTES,
  MANUAL_REFRESH_MIN_AGE_MS,
  RATELIMIT_BACKOFF_MS,
} from './config.js';
import { AuthError, getAccessToken, refresh, signIn, signOut } from './auth.js';
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
  if (me?.id) return me;
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

// A poll's failure decides whether the session ends, throttles, or merely retries, so a
// mixed failure must surface the most consequential cause: a 401 hidden behind a concurrent
// 429 would leave a dead session showing a stale count for the whole backoff (design §8, §10).
const KIND_SEVERITY = ['auth', 'ratelimit', 'network', 'unknown'];

function mostSevere(reasons) {
  return reasons.reduce((worst, reason) =>
    KIND_SEVERITY.indexOf(errorKind(reason)) < KIND_SEVERITY.indexOf(errorKind(worst)) ? reason : worst,
  );
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
  // The worker's own console is the only place a poll failure can be inspected; without this
  // an unexpected error reaches the user as a generic network notice and leaves no stack.
  console.error('poll failed', error);
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
    const rejected = results.filter((result) => result.status === 'rejected');
    if (rejected.length > 0) throw mostSevere(rejected.map((result) => result.reason));

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
