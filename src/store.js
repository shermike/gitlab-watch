/**
 * The `chrome.storage.local` schema (design §6). Every read goes through these defaults, so
 * no caller has to distinguish "unset" from "set to the default".
 *
 * `inbox: null` means "no poll has ever succeeded", and is what makes the popup show its
 * skeleton rather than three empty lists.
 *
 * `readIds` holds the to-dos the user has dismissed: `{ "42": true }`. Only to-dos carry it —
 * a merge request awaiting review is live GitLab state, not an inbox item — and it is pruned
 * to the live snapshot on every successful poll, so it cannot outgrow what it hides.
 */
const SCHEMA_DEFAULTS = {
  auth: null,
  me: null,
  inbox: null,
  ui: { activeTab: 'todos' },
  readIds: {},
  backoffUntil: 0,
};

/** The three lists a snapshot carries, in the order the popup's tabs present them. */
export const LISTS = ['todos', 'reviews', 'mine'];

/** The to-dos that are not marked read; what the popup's To-dos list shows. */
export function unread(todos, readIds) {
  return (todos ?? []).filter((todo) => !readIds?.[todo.id]);
}

/**
 * The number on the toolbar badge: unread to-dos plus every merge request awaiting the user's
 * review. A review stays counted until it is no longer requested of the user — that is the
 * point of putting it on the badge, and unlike `mine` it is a set that does reach zero.
 *
 * A review request normally arrives as a to-do as well, and marking that to-do read does not
 * mean the review is done, so an MR must not be counted twice. A to-do is dropped from the
 * count when it points at an MR already in the review list; its fragment goes first, because
 * a to-do raised by a comment points into the same MR with a `#note_17` on the end.
 */
export function badgeCount(inbox, readIds) {
  const reviews = inbox?.reviews ?? [];
  const reviewUrls = new Set(reviews.map((mr) => mr.url).filter(Boolean));
  const counted = unread(inbox?.todos, readIds).filter(
    (todo) => !reviewUrls.has((todo.url ?? '').split('#')[0]),
  );
  return reviews.length + counted.length;
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
