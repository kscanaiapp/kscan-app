'use strict';

/** Spec section 8: the paired experiment is only valid over an identical candidate universe. */

const test = require('node:test');
const assert = require('node:assert');

const { fingerprintUniverse, assertSameUniverse, canonicaliseCandidate } = require('../candidateUniverse');

const c = (id, extra = {}) => ({
  id,
  category: 'dress',
  color_normalized: 'navy',
  silhouette: 'a-line',
  material: 'cotton',
  pattern: 'solid',
  purchaseUrl: 'https://retailer.example/x',
  availability: 'in_stock',
  ...extra,
});
const entry = (candidate, sha = 'sha-' + candidate.id) => ({ candidate, imageIdentity: { sha256: sha } });

test('UNIVERSE: the fingerprint is order-independent - the same set in any order hashes identically', () => {
  const a = fingerprintUniverse([entry(c('x')), entry(c('y')), entry(c('z'))]);
  const b = fingerprintUniverse([entry(c('z')), entry(c('x')), entry(c('y'))]);
  assert.strictEqual(a.hash, b.hash, 'ordering must not change the universe hash - that is what makes the check usable');
  assert.deepStrictEqual(a.members, b.members);
});

test('UNIVERSE: membership changes the hash', () => {
  const three = fingerprintUniverse([entry(c('x')), entry(c('y')), entry(c('z'))]);
  const two = fingerprintUniverse([entry(c('x')), entry(c('y'))]);
  assert.notStrictEqual(three.hash, two.hash);
  assert.strictEqual(three.memberCount, 3);
});

test('UNIVERSE: a quietly rewritten attribute changes the hash', () => {
  const original = fingerprintUniverse([entry(c('x'))]);
  for (const mutation of [
    { color_normalized: 'black' },
    { silhouette: 'fitted' },
    { material: 'leather' },
    { pattern: 'striped' },
    { availability: 'out_of_stock' },
    { purchaseUrl: null },
  ]) {
    assert.notStrictEqual(
      fingerprintUniverse([entry(c('x', mutation))]).hash,
      original.hash,
      `${JSON.stringify(mutation)} must change the universe fingerprint`,
    );
  }
});

test('UNIVERSE: different image bytes for the same product change the hash', () => {
  const a = fingerprintUniverse([entry(c('x'), 'sha-one')]);
  const b = fingerprintUniverse([entry(c('x'), 'sha-two')]);
  assert.notStrictEqual(a.hash, b.hash, 'the bytes actually embedded are part of the universe identity');
});

test('UNIVERSE: absent values are canonicalised to null, never dropped', () => {
  // JSON.stringify silently drops undefined keys, which would make two
  // materially different candidate sets hash identically.
  const canonical = canonicaliseCandidate({ id: 'x' }, undefined);
  for (const key of ['imageSha256', 'category', 'color', 'silhouette', 'material', 'pattern', 'availability']) {
    assert.strictEqual(canonical[key], null, `${key} must be null, not undefined`);
  }
});

test('UNIVERSE: a duplicate candidateId within one universe is refused', () => {
  assert.throws(() => fingerprintUniverse([entry(c('x')), entry(c('x'))]), /CANDIDATE_UNIVERSE_INVALID/);
});

test('NEGATIVE CONTROL ANCHOR: a challenger that drops a candidate is detected as an invalid comparison', () => {
  const entries = [entry(c('x')), entry(c('y')), entry(c('z'))];
  const control = fingerprintUniverse(entries);
  const challenger = fingerprintUniverse([entry(c('x')), entry(c('y'))]); // dropped 'z'

  const verdict = assertSameUniverse(control, challenger, ['x', 'y', 'z'], ['x', 'y']);
  assert.strictEqual(verdict.identical, false);
  assert.ok(verdict.reasons.some((r) => r.includes('UNIVERSE_HASH_MISMATCH')));
  assert.ok(verdict.reasons.some((r) => r.includes('DROPPED_BY_CHALLENGER: z')));
});

test('NEGATIVE CONTROL ANCHOR: a challenger that invents a candidate is detected', () => {
  const control = fingerprintUniverse([entry(c('x'))]);
  const challenger = fingerprintUniverse([entry(c('x')), entry(c('smuggled'))]);
  const verdict = assertSameUniverse(control, challenger, ['x'], ['x', 'smuggled']);
  assert.strictEqual(verdict.identical, false);
  assert.ok(verdict.reasons.some((r) => r.includes('ADDED_BY_CHALLENGER: smuggled')));
});

test('UNIVERSE: the same set in two different orders is reported as identical', () => {
  const entries = [entry(c('x')), entry(c('y')), entry(c('z'))];
  const fingerprint = fingerprintUniverse(entries);
  const verdict = assertSameUniverse(fingerprint, fingerprint, ['x', 'y', 'z'], ['z', 'x', 'y']);
  assert.strictEqual(verdict.identical, true, 'reordering alone is exactly what the challenger is allowed to do');
  assert.deepStrictEqual(verdict.reasons, []);
});
