/**
 * The `chrome.storage.local` schema (design §6). Every read goes through these defaults, so
 * no caller has to distinguish "unset" from "set to the default".
 *
 * `inbox: null` means "no poll has ever succeeded", and is what makes the popup show its
 * skeleton rather than three empty lists.
 */
const SCHEMA_DEFAULTS = {
  auth: null,
  me: null,
  inbox: null,
  ui: { activeTab: 'todos' },
  backoffUntil: 0,
};

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
