import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  base64UrlEncode,
  challengeFromVerifier,
  randomState,
  randomVerifier,
} from '../src/pkce.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

test('base64UrlEncode uses the URL alphabet and drops padding', () => {
  // "hi" is two bytes, so plain base64 would pad it to "aGk=".
  assert.equal(base64UrlEncode(new TextEncoder().encode('hi')), 'aGk');
  // 0xfb 0xff is "+/8=" in plain base64, exercising both substitutions and the padding strip.
  assert.equal(base64UrlEncode(new Uint8Array([0xfb, 0xff])), '-_8');
});

test('challengeFromVerifier matches the RFC 7636 Appendix B vector', async () => {
  const challenge = await challengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomVerifier is 86 base64url characters, inside the RFC 7636 43..128 range', () => {
  const verifier = randomVerifier();
  assert.equal(verifier.length, 86);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, BASE64URL);
});

test('randomVerifier does not repeat', () => {
  assert.notEqual(randomVerifier(), randomVerifier());
});

test('randomState is 43 base64url characters', () => {
  const state = randomState();
  assert.equal(state.length, 43);
  assert.match(state, BASE64URL);
});

test('randomState does not repeat', () => {
  assert.notEqual(randomState(), randomState());
});
