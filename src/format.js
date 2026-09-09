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

/** A to-do's `action_name` as prose: "review_requested" reads as "review requested". */
export function humaniseAction(actionName) {
  return (actionName ?? '').replace(/_/g, ' ');
}
