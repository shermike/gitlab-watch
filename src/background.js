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
import { collectEvents, mergeEvents } from './events.js';
import { badgeCount, pruneReadIds, read, write } from './store.js';

const BADGE_COLOR = '#E24329';
const BADGE_ERROR_COLOR = '#DB3B21';

const ERROR_MESSAGES = {
  auth: 'Session expired — sign in again.',
  network: 'GitLab is unreachable. Showing the last known state.',
  ratelimit: 'Rate limited by GitLab. Retrying in a few minutes.',
  unknown: 'Unexpected error talking to GitLab.',
};

// `ERROR_MESSAGES.network` promises a previous state that does not exist yet on the very
// first poll — a network blip right after sign-in must not read as a confident all-clear.
const NETWORK_ERROR_FIRST_RUN = 'GitLab is unreachable. Nothing has been fetched yet.';

// Everything a session accumulates besides its tokens. Written on sign-in and sign-out, so one
// session's snapshot, read marks, error, watch state and events never leak into the next
// (design §6, notifications design §5).
const EMPTY_SESSION = { inbox: null, readIds: {}, backoffUntil: 0, watch: {}, events: [] };

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
  const fetchedAt = inbox?.fetchedAt ?? 0;
  // Only the network message claims a previous state; a first-ever poll has none to show.
  const wording = kind === 'network' && fetchedAt === 0 ? NETWORK_ERROR_FIRST_RUN : message;
  await write({
    inbox: {
      todos: inbox?.todos ?? [],
      reviews: inbox?.reviews ?? [],
      mine: inbox?.mine ?? [],
      truncated: inbox?.truncated ?? { todos: false, reviews: false, mine: false },
      fetchedAt,
      error: { kind, message: wording },
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
 * The badge counts the Notifications feed plus the merge requests awaiting the user's review
 * (design §8, notifications design §7). A network or rate-limit error leaves the last count standing: it is still
 * the best information available.
 */
async function applyBadge() {
  const { auth, inbox, readIds, events } = await read('auth', 'inbox', 'readIds', 'events');
  if (inbox?.error?.kind === 'auth') {
    await setBadge('!', BADGE_ERROR_COLOR);
    return;
  }
  if (!auth) {
    await setBadge('', BADGE_COLOR);
    return;
  }
  await setBadge(badgeText(badgeCount(inbox, readIds, events)), BADGE_COLOR);
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  try {
    // Chrome 110+ only, and the API most likely to differ between browsers; a default text
    // colour is a far better outcome than a badge that stops updating.
    await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  } catch {
    // The badge is already drawn; the text colour is cosmetic.
  }
}

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

/**
 * Fetches all three lists and writes one snapshot. The three run concurrently and the
 * snapshot is written only if all three succeed, so the popup never sees a half-updated
 * state (design §7). Event detection runs after the snapshot is written, so the lists are never
 * held back by it (notifications design §4.2).
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
    const snapshot = {
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
    };
    await write({ inbox: snapshot, backoffUntil: 0 });
    await detectEvents(me, snapshot);
    // Read here rather than alongside `auth` at the top: the requests above take as long as
    // they take, and a `markRead` that lands while they are in flight must not be pruned away
    // by a snapshot that predates it.
    const { readIds, events } = await read('readIds', 'events');
    await write({ readIds: pruneReadIds(readIds, snapshot.todos, events) });
  } catch (error) {
    await recordFailure(error);
  }
  await applyBadge();
}

/** Creates the poll alarm only when it is missing, leaving an existing schedule undisturbed. */
async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  }
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

// Recovers from the alarm being lost by any path other than `onInstalled` or `onStartup` —
// re-enabling a disabled extension, for one — since permanently stopped polling is the worst
// failure mode this extension has.
ensureAlarm();

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
  await write(EMPTY_SESSION);
  await ensureAlarm();
  await poll({ respectBackoff: false });
  return { ok: true };
}

/**
 * Hides one to-do from the list and from the badge count. The mark is all this extension can
 * do about it: `read_api` cannot resolve a to-do in GitLab (design §2), so this is local and
 * lasts exactly as long as the to-do stays in the snapshot.
 */
async function markRead({ id }) {
  if (id === undefined || id === null) {
    return { ok: false, message: `markRead needs a to-do id, got ${id}` };
  }
  const { readIds } = await read('readIds');
  await write({ readIds: { ...readIds, [id]: true } });
  await applyBadge();
  return { ok: true };
}

async function handleMessage(message) {
  switch (message?.type) {
    case 'signIn':
      return handleSignIn();
    case 'signOut':
      await signOut();
      await write(EMPTY_SESSION);
      await applyBadge();
      return { ok: true };
    case 'refresh':
      return refreshOnRequest();
    case 'markRead':
      return markRead(message);
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
