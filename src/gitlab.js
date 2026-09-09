import { GITLAB_HOST, MRS_PER_PAGE, TODOS_PER_PAGE } from './config.js';

const API = `${GITLAB_HOST}/api/v4`;

// GitLab puts "Draft: " (and historically "WIP: ") in the title itself; the popup shows a
// Draft chip instead, so the prefix would say the same thing twice.
const DRAFT_PREFIX = /^\s*(draft|wip)\s*:\s*/i;

export function userUrl() {
  return `${API}/user`;
}

export function todosUrl() {
  return `${API}/todos?state=pending&per_page=${TODOS_PER_PAGE}`;
}

// `scope=all` is required: without it /merge_requests returns only MRs the user created,
// which would empty the review list with no error to notice (design §7).
function mergeRequestsUrl(filter) {
  return (
    `${API}/merge_requests?scope=all&state=opened&${filter}` +
    `&order_by=updated_at&sort=desc&per_page=${MRS_PER_PAGE}`
  );
}

export function reviewsUrl(userId) {
  return mergeRequestsUrl(`reviewer_id=${userId}`);
}

export function mineUrl(userId) {
  return mergeRequestsUrl(`author_id=${userId}`);
}

/**
 * Maps an HTTP status to the `inbox.error.kind` the badge and popup branch on (design §10).
 * A 403 stays `unknown` on purpose: it means one resource is forbidden, not that the session
 * is dead, and treating it as `auth` would sign the user out over a single bad project.
 */
export function errorKindForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 429) return 'ratelimit';
  if (status >= 500) return 'network';
  return 'unknown';
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = errorKindForStatus(status);
  }
}

/**
 * One authenticated GET. No retry and no token handling — the caller owns both, which is what
 * keeps this module free of storage and any `chrome` extension API.
 *
 * `nextPage` is GitLab's `x-next-page` header: non-empty exactly when further pages exist,
 * which is how truncation is detected without requesting a second page (design §7).
 */
export async function apiGet(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiError(response.status, `GET ${url} responded ${response.status}`);
  }
  return {
    body: await response.json(),
    nextPage: response.headers.get('x-next-page') ?? '',
  };
}

/** ISO 8601 to epoch milliseconds; 0 stands for "no timestamp". */
function epochMs(iso) {
  const parsed = Date.parse(iso ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function mapUser(raw) {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    avatarUrl: raw.avatar_url ?? '',
    webUrl: raw.web_url ?? '',
  };
}

export function mapTodo(raw) {
  return {
    id: raw.id,
    // A to-do on a commit or a deleted object has no target; `body` is then the only text.
    title: raw.target?.title ?? raw.body ?? '',
    url: raw.target_url ?? '',
    project: raw.project?.path_with_namespace ?? '',
    actionName: raw.action_name ?? '',
    authorName: raw.author?.name ?? '',
    authorAvatar: raw.author?.avatar_url ?? '',
    createdAt: epochMs(raw.created_at),
  };
}

export function mapMr(raw) {
  return {
    id: raw.id,
    title: (raw.title ?? '').replace(DRAFT_PREFIX, ''),
    url: raw.web_url ?? '',
    // `references.full` is "group/project!123": the project path and the MR number in one
    // field, with no extra request (design §6).
    reference: raw.references?.full ?? '',
    authorName: raw.author?.name ?? '',
    authorAvatar: raw.author?.avatar_url ?? '',
    updatedAt: epochMs(raw.updated_at),
    draft: raw.draft === true || raw.work_in_progress === true,
  };
}
