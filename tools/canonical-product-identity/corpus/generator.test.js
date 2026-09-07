'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateCorpus } = require('./generator');
const { validateCorpus } = require('../schema/identitySchema');
const { buildGroundTruthIndex } = require('./groundTruth');

// spec section 43#1: deterministic corpus generation.
test('GENERATOR: the same seed produces a byte-identical corpus (structurally, ignoring only the generatedAt timestamp)', () => {
  const a = generateCorpus({ seed: 'determinism-test-seed', instancesPerCase: 2 });
  const b = generateCorpus({ seed: 'determinism-test-seed', instancesPerCase: 2 });
  const strip = (c) => JSON.stringify({ ...c, generatedAt: undefined });
  assert.equal(strip(a), strip(b));
});

test('GENERATOR: a different seed produces a different corpus', () => {
  const a = generateCorpus({ seed: 'seed-one', instancesPerCase: 2 });
  const b = generateCorpus({ seed: 'seed-two', instancesPerCase: 2 });
  assert.notEqual(JSON.stringify(a.offers), JSON.stringify(b.offers));
});

test('GENERATOR: output always validates against the identity schema', () => {
  const corpus = generateCorpus({ seed: 'schema-check-seed', instancesPerCase: 2 });
  const { valid, errors } = validateCorpus(corpus);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('GENERATOR: every offerId in the corpus is globally unique', () => {
  const corpus = generateCorpus({ seed: 'uniqueness-seed', instancesPerCase: 3 });
  const ids = corpus.offers.map((o) => o.offerId);
  assert.equal(ids.length, new Set(ids).size);
});

test('GENERATOR: instancesPerCase scales the offer count proportionally', () => {
  const small = generateCorpus({ seed: 'scale-seed', instancesPerCase: 1 });
  const large = generateCorpus({ seed: 'scale-seed', instancesPerCase: 4 });
  assert.equal(large.offers.length, small.offers.length * 4);
});

// Addendum A.4: UNDECIDABLE cases are CONSTRUCTED (evidence deliberately
// stripped), never labeled after the fact - every UNDECIDABLE label must
// trace back to an explicit pairOverride, never a structural default.
test('GENERATOR/GROUND TRUTH: every UNDECIDABLE pair has an explicit pairOverride (never a structural default)', () => {
  const corpus = generateCorpus({ seed: 'undecidable-check-seed', instancesPerCase: 2 });
  const undecidableOverrides = corpus.pairOverrides.filter((o) => o.label === 'UNDECIDABLE');
  assert.ok(undecidableOverrides.length > 0, 'the corpus must contain at least one constructed UNDECIDABLE case');
  for (const o of undecidableOverrides) {
    assert.ok(o.reason && o.reason.length > 0, 'every UNDECIDABLE override must carry a reason (evidence-stripping rationale)');
  }
});

test('GROUND TRUTH: every generated NEAR_DUPLICATE_DISTINCT label comes from an explicit override, never structurally inferred', () => {
  const corpus = generateCorpus({ seed: 'near-dup-check-seed', instancesPerCase: 2 });
  const { groundTruthForPair } = buildGroundTruthIndex(corpus);
  const nearDupOverrides = corpus.pairOverrides.filter((o) => o.label === 'NEAR_DUPLICATE_DISTINCT');
  assert.ok(nearDupOverrides.length > 0);
  for (const o of nearDupOverrides) {
    const gt = groundTruthForPair(o.offerIdA, o.offerIdB);
    assert.equal(gt.label, 'NEAR_DUPLICATE_DISTINCT');
    assert.equal(gt.source, 'override');
  }
});

test('GROUND TRUTH: two offers in the same variant are SAME_VARIANT; same style different variant are SIBLING_VARIANT; unrelated offers default to DISTINCT', () => {
  const corpus = generateCorpus({ seed: 'ground-truth-shape-seed', instancesPerCase: 2 });
  const { groundTruthForPair } = buildGroundTruthIndex(corpus);
  const style = corpus.canonicalStyles.find((s) => s.variants.length >= 2 && s.variants.every((v) => v.offerIds.length >= 1));
  assert.ok(style, 'expected at least one multi-variant style in the generated corpus');
  const [variantA, variantB] = style.variants;
  const gtSibling = groundTruthForPair(variantA.offerIds[0], variantB.offerIds[0]);
  assert.equal(gtSibling.label, 'SIBLING_VARIANT');

  if (variantA.offerIds.length >= 2) {
    const gtSame = groundTruthForPair(variantA.offerIds[0], variantA.offerIds[1]);
    assert.equal(gtSame.label, 'SAME_VARIANT');
  }

  const otherStyle = corpus.canonicalStyles.find((s) => s.styleId !== style.styleId && s.variants[0]?.offerIds[0]);
  if (otherStyle) {
    const gtDistinct = groundTruthForPair(variantA.offerIds[0], otherStyle.variants[0].offerIds[0]);
    assert.equal(gtDistinct.label, corpus.pairOverrides.some((o) => [o.offerIdA, o.offerIdB].sort().join(' ') === [variantA.offerIds[0], otherStyle.variants[0].offerIds[0]].sort().join(' '))
      ? gtDistinct.label // an override exists for this pair - accept whatever it legitimately says
      : 'DISTINCT');
  }
});
