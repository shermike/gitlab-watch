import { CLIENT_ID, GITLAB_HOST, SCOPE, TOKEN_STALE_MARGIN_MS } from './config.js';
import { challengeFromVerifier, randomState, randomVerifier } from './pkce.js';
import { read, write } from './store.js';

const AUTHORIZE_URL = `${GITLAB_HOST}/oauth/authorize`;
const TOKEN_URL = `${GITLAB_HOST}/oauth/token`;

/**
 * `terminal` means the session cannot be recovered by retrying and the user must sign in
 * again. Anything else — a timeout, a 5xx from the token endpoint — is transient, and the
 * next alarm retries it.
 */
export class AuthError extends Error {
  constructor(message, { terminal = false } = {}) {
    super(message);
    this.name = 'AuthError';
    this.terminal = terminal;
  }
}

// At most one refresh request is outstanding per worker lifetime. The worker can be
// terminated between calls, so this is an optimisation, not a correctness guarantee: a
// duplicated refresh after a restart invalidates the older token and the next call refreshes
// again (design §5.3).
let refreshInFlight = null;

// Taken from the API rather than hard-coded, so the registered redirect URI and the used one
// cannot drift (design §5.1).
function redirectUri() {
  return chrome.identity.getRedirectURL();
}

/**
 * Exchanges a grant for a token pair. No client secret: the OAuth application is
 * non-confidential, because a browser extension cannot keep one (design §5.1).
 */
async function exchange(grant) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri(),
        ...grant,
      }),
    });
  } catch (cause) {
    throw new AuthError(`Token endpoint unreachable: ${cause.message}`);
  }

  if (!response.ok) {
    // 400 invalid_grant on a refresh, or a rejected authorization code: unrecoverable.
    throw new AuthError(`Token endpoint responded ${response.status}`, {
      terminal: response.status === 400 || response.status === 401,
    });
  }

  const json = await response.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope ?? SCOPE,
  };
}

/** The full PKCE authorization-code flow. Stores the token pair on success (design §5.2). */
export async function signIn() {
  const verifier = randomVerifier();
  const state = randomState();
  const challenge = await challengeFromVerifier(verifier);

  const authorize = new URL(AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    state,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  let callbackUrl;
  try {
    callbackUrl = await chrome.identity.launchWebAuthFlow({
      interactive: true,
      url: authorize.toString(),
    });
  } catch (cause) {
    // The user closed the window, or the redirect never arrived.
    throw new AuthError(cause.message || 'Sign-in was cancelled.', { terminal: true });
  }

  const params = new URL(callbackUrl).searchParams;
  // A state mismatch means the response is not ours: abort and store nothing (design §5.2).
  if (params.get('state') !== state) {
    throw new AuthError('Sign-in failed, please try again.', { terminal: true });
  }
  const code = params.get('code');
  if (!code) {
    throw new AuthError(params.get('error_description') || 'Sign-in failed, please try again.', {
      terminal: true,
    });
  }

  const auth = await exchange({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
  });
  await write({ auth, me: null });
  return auth;
}

async function performRefresh() {
  const { auth } = await read('auth');
  if (!auth?.refreshToken) {
    throw new AuthError('Not signed in.', { terminal: true });
  }
  const usedRefreshToken = auth.refreshToken;
  const next = await exchange({
    grant_type: 'refresh_token',
    refresh_token: usedRefreshToken,
  });
  // The session can end, or another worker can rotate the pair, while this request is in
  // flight. Writing unconditionally would restore a session the user has just signed out
  // of, so the stored pair must still be the one this request went out with.
  const { auth: current } = await read('auth');
  if (current?.refreshToken !== usedRefreshToken) {
    throw new AuthError('Session ended while the token was being refreshed.', { terminal: true });
  }
  // GitLab rotates refresh tokens: the old one is invalid the moment this response arrives,
  // so the new pair must be persisted before anything else runs. Losing this write loses the
  // session (design §5.3).
  await write({ auth: next });
  return next;
}

/** Refreshes the token pair, collapsing concurrent callers onto one request. */
export function refresh() {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * A usable access token, refreshing first when the stored one is within
 * `TOKEN_STALE_MARGIN_MS` of expiry. Checked lazily before every call, never on a timer
 * (design §5.3).
 */
export async function getAccessToken() {
  const { auth } = await read('auth');
  if (!auth) throw new AuthError('Not signed in.', { terminal: true });
  if (Date.now() >= auth.expiresAt - TOKEN_STALE_MARGIN_MS) {
    return (await refresh()).accessToken;
  }
  return auth.accessToken;
}

/** Drops the local session. The authorization on GitLab's side is left alone (design §2). */
export async function signOut() {
  refreshInFlight = null;
  await write({ auth: null, me: null });
}
