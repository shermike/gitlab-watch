// Only `https://gitlab.com` is targeted and tested; self-hosted instances are out of scope
// for v1 (design §2), and this constant is the single place a future port would change.
export const GITLAB_HOST = 'https://gitlab.com';

// The Application ID of a user-owned OAuth application. Public by design: the application is
// non-confidential, so there is no client secret and this value is not a credential
// (design §5.1).
export const CLIENT_ID = 'e11265a7d02cffbea26e996eb86d00215bb9ab6977712cb450fb50b4e7bf32f0';

// The extension only reads; a stolen token cannot modify anything (design §3).
export const SCOPE = 'read_api';

export const ALARM_NAME = 'poll';

// One minute is the shortest period Manifest V3 permits (design §7).
export const ALARM_PERIOD_MINUTES = 1;

export const TODOS_PER_PAGE = 100;
export const MRS_PER_PAGE = 50;

// The newest page of a changed merge request's notes is all that is read; more than a hundred
// notes inside one poll interval is not a realistic personal workload (notifications design §4.2).
export const NOTES_PER_PAGE = 100;

export const DISCUSSIONS_PER_PAGE = 100;

// The discussion walk that finds replies stops after this many pages; notes it did not reach are
// dropped rather than guessed at (notifications design §4.2 step 3).
export const DISCUSSION_PAGES_MAX = 5;

// `events` holds at most this many entries, and none older than the age below
// (notifications design §5).
export const EVENTS_MAX = 100;
export const EVENTS_MAX_AGE_MS = 14 * 86_400_000;

// Characters of a comment kept for the row tooltip (notifications design §5).
export const EXCERPT_MAX = 200;

// A token counts as stale five minutes before it expires, so a request never starts with a
// token that could expire mid-flight (design §5.3).
export const TOKEN_STALE_MARGIN_MS = 300_000;

// A popup-initiated refresh is a no-op while the snapshot is younger than this (design §7).
export const MANUAL_REFRESH_MIN_AGE_MS = 30_000;

// How long polling pauses after HTTP 429 (design §10).
export const RATELIMIT_BACKOFF_MS = 300_000;
