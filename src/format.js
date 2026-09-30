const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Two characters is all the badge renders legibly.
const BADGE_MAX = 99;

/** Toolbar badge text for a pending to-do count. Empty means "draw no badge". */
export function badgeText(count) {
  if (!count) return '';
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/**
 * A coarse age, rounded down: "20 min ago". A `timestamp` of 0 or undefined means "never",
 * and so does a future timestamp on a skewed clock; both render as "just now" rather than as
 * a nonsense age.
 */
export function relativeTime(timestamp, now = Date.now()) {
  const elapsed = now - timestamp;
  if (!Number.isFinite(elapsed) || !timestamp || elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

/**
 * A to-do's `action_name` as a sentence-case label: "review_requested" reads as
 * "Review requested". It heads the row in the popup, which is why it is capitalised here
 * rather than by a CSS transform that would also shout an all-caps project name.
 */
export function humaniseAction(actionName) {
  const words = (actionName ?? '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The lead line of an event row in the Notifications tab (notifications design §6).
const EVENT_LABELS = {
  comment: 'New comment',
  reply: 'Reply in your thread',
  commits: 'New commits',
  approved: 'Approved',
  unapproved: 'Approval revoked',
  changes_requested: 'Changes requested',
  merged: 'Merged',
  closed: 'Closed',
};

/** An event kind as its row's lead line; an unknown kind reads as its sentence-case name. */
export function eventLabel(kind) {
  return EVENT_LABELS[kind] ?? humaniseAction(kind);
}

/**
 * Who is asked to review a merge request, as the muted line of a Mine row shows it: every
 * reviewer's name in GitLab's order, or "No reviewers" when nobody is.
 */
export function reviewerLabel(names) {
  return names?.length ? names.join(', ') : 'No reviewers';
}
