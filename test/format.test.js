import { test } from 'node:test';
import assert from 'node:assert/strict';

import { badgeText, humaniseAction, relativeTime } from '../src/format.js';

test('badgeText hides a zero count and caps at 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(150), '99+');
});

test('badgeText treats a missing count as zero', () => {
  assert.equal(badgeText(undefined), '');
  assert.equal(badgeText(null), '');
});

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const ago = (ms) => relativeTime(NOW - ms, NOW);

test('relativeTime rounds down at every unit boundary', () => {
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59_999), 'just now');
  assert.equal(ago(60_000), '1 min ago');
  assert.equal(ago(20 * 60_000), '20 min ago');
  assert.equal(ago(3_599_999), '59 min ago');
  assert.equal(ago(3_600_000), '1 h ago');
  assert.equal(ago(86_399_999), '23 h ago');
  assert.equal(ago(86_400_000), '1 d ago');
  assert.equal(ago(9 * 86_400_000), '9 d ago');
});

test('relativeTime does not produce a negative age on a skewed clock', () => {
  assert.equal(relativeTime(NOW + 60_000, NOW), 'just now');
});

// `fetchedAt` is 0 until a poll first succeeds, and "just now" is the least misleading thing
// to print for a value that means "never".
test('relativeTime survives a missing timestamp', () => {
  assert.equal(relativeTime(undefined, NOW), 'just now');
  assert.equal(relativeTime(0, NOW), 'just now');
});

test('humaniseAction replaces underscores', () => {
  assert.equal(humaniseAction('review_requested'), 'review requested');
  assert.equal(humaniseAction('mentioned'), 'mentioned');
  assert.equal(humaniseAction(''), '');
  assert.equal(humaniseAction(undefined), '');
});
