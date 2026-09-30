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

/** The to-dos that are not marked read; what the popup's To-dos list shows. */
export function unread(todos, readIds) {
  return (todos ?? []).filter((todo) => !readIds?.[todo.id]);
}

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

/** Reads the named keys, or the whole schema when called with no arguments. */
export function read(...keys) {
  const wanted = keys.length > 0 ? keys : Object.keys(SCHEMA_DEFAULTS);
  const defaults = {};
  for (const key of wanted) defaults[key] = SCHEMA_DEFAULTS[key];
  return chrome.storage.local.get(defaults);
}

export function write(patch) {
  return chrome.storage.local.set(patch);
}

/** Calls back with the changed keys of the local area, ignoring every other area. */
export function onChanged(listener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') listener(changes);
  });
}
