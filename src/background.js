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
