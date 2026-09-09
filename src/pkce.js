// 64 random bytes encode to 86 base64url characters, comfortably inside the 43..128 that
// RFC 7636 section 4.1 requires of a code verifier.
const VERIFIER_BYTES = 64;
const STATE_BYTES = 32;

/** Unpadded base64url, the only encoding RFC 7636 accepts for the verifier and challenge. */
export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomVerifier() {
  return randomBase64Url(VERIFIER_BYTES);
}

export function randomState() {
  return randomBase64Url(STATE_BYTES);
}

/** `code_challenge` for method S256: base64url(SHA-256(ascii(verifier))). */
export async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
