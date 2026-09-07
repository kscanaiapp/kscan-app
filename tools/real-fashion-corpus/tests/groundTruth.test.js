'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveGrade,
  evaluateIdentityEligibility,
  checkProvenanceSelfContained,
  hasDurableIdentifier,
  hasColorwayLevelTruth,
} = require('../lib/groundTruth');
const { makeGarment } = require('./fixtures/sampleRecords');

/* ------------------------------------------------------------------ *
 * Grade derivation (mission section 6)
 * ------------------------------------------------------------------ */

test('GROUND TRUTH: a full identifier chain derives IDENTIFIER_GRADE', () => {
  const { grade, reasons } = deriveGrade(makeGarment().groundTruth);
  assert.equal(grade, 'IDENTIFIER_GRADE');
  assert.deepEqual(reasons, []);
});

test('GROUND TRUTH: brand + evidence but no durable identifier derives PARTIAL, not IDENTIFIER_GRADE', () => {
  const groundTruth = makeGarment({
    groundTruth: {
      assertedGrade: 'PARTIAL',
      identity: { style: { styleCode: undefined }, variant: { gtin: undefined } },
    },
  }).groundTruth;
  const { grade, reasons } = deriveGrade(groundTruth);
  assert.equal(grade, 'PARTIAL');
  assert.ok(
    reasons.some((r) => r.includes('no durable identifier')),
    `expected a durable-identifier reason, got ${JSON.stringify(reasons)}`,
  );
});

test('GROUND TRUTH: no usable evidence derives VISUAL_ONLY even when identifiers are typed in', () => {
  // An operator can type a style code without having verified it. Without an
  // evidence record the claim is unsupported, so the grade must not rise.
  const groundTruth = makeGarment({ groundTruth: { assertedGrade: 'VISUAL_ONLY', evidence: [] } }).groundTruth;
  const { grade, reasons } = deriveGrade(groundTruth);
  assert.equal(grade, 'VISUAL_ONLY');
  assert.ok(reasons.some((r) => r.includes('no usable non-model evidence')));
});

test('GROUND TRUTH: an evidence record missing verifiedBy does not count toward a grade', () => {
  // Everything else about this record is well-formed - only the attestation of
  // WHO verified it is absent, and that alone is enough to make it unusable.
  const groundTruth = makeGarment({
    groundTruth: {
      evidence: [
        {
          evidenceType: 'MANUFACTURER_TAG',
          verifiedOn: '2026-09-01',
          observedFacts: { brandOnTag: 'Test Brand', styleCodeOnTag: 'TB-QJ-1200' },
        },
      ],
    },
  }).groundTruth;
  assert.equal(deriveGrade(groundTruth).grade, 'VISUAL_ONLY');
});

/* ------------------------------------------------------------------ *
 * The absolute ground-truth rule (mission section 5)
 * ------------------------------------------------------------------ */

test('GROUND TRUTH: model-derived evidence is INVALID, not merely downgraded', () => {
  // A downgrade would leave the record usable. Section 5 says the model may
  // never create its own truth at all, so this must be a hard refusal.
  for (const evidenceType of ['KSCAN_RESULT', 'GEMINI_OUTPUT', 'LLAMA_OUTPUT', 'LLM_GENERATED_SKU']) {
    const groundTruth = makeGarment({
      groundTruth: { evidence: [{ evidenceType }] },
    }).groundTruth;
    const result = deriveGrade(groundTruth);
    assert.equal(result.invalid, true, `${evidenceType} should invalidate the record`);
    assert.equal(result.grade, null, `${evidenceType} must not yield any usable grade`);
  }
});

test('GROUND TRUTH: modelDerived:true on an otherwise-allowed evidence type is still refused', () => {
  const groundTruth = makeGarment({
    groundTruth: { evidence: [{ evidenceType: 'RETAILER_PDP', modelDerived: true }] },
  }).groundTruth;
  const result = deriveGrade(groundTruth);
  assert.equal(result.invalid, true);
});

/* ------------------------------------------------------------------ *
 * Identity eligibility - the denominator rule (invariants 42.3 / 42.4)
 * ------------------------------------------------------------------ */

test('IDENTITY ELIGIBILITY: an IDENTIFIER_GRADE colorway-level garment is eligible', () => {
  const result = evaluateIdentityEligibility(makeGarment());
  assert.equal(result.eligible, true, `expected eligible, reasons: ${JSON.stringify(result.reasons)}`);
});

test('IDENTITY ELIGIBILITY: a PARTIAL garment is NOT eligible for an exact-identity denominator', () => {
  const garment = makeGarment({
    groundTruth: {
      assertedGrade: 'PARTIAL',
      identity: { style: { styleCode: undefined }, variant: { gtin: undefined } },
    },
  });
  const result = evaluateIdentityEligibility(garment);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('IDENTIFIER_GRADE')));
});

test('IDENTITY ELIGIBILITY: a VISUAL_ONLY garment is NOT eligible', () => {
  const garment = makeGarment({ groundTruth: { assertedGrade: 'VISUAL_ONLY', evidence: [] } });
  assert.equal(evaluateIdentityEligibility(garment).eligible, false);
});

test('IDENTITY ELIGIBILITY: identifier-grade WITHOUT colorway-level truth is not eligible', () => {
  // The right style in the wrong colour is a different product to a shopper,
  // so exact identity is not establishable (mission section 6).
  const garment = makeGarment({
    groundTruth: { identity: { variant: { colorwayName: undefined, colorwayCode: undefined } } },
  });
  const result = evaluateIdentityEligibility(garment);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((r) => r.includes('colorway-level truth')));
});

test('IDENTITY ELIGIBILITY: either a styleCode or a gtin alone satisfies the durable-identifier rule', () => {
  const styleOnly = makeGarment({ groundTruth: { identity: { variant: { gtin: undefined } } } });
  const gtinOnly = makeGarment({ groundTruth: { identity: { style: { styleCode: undefined } } } });
  assert.equal(hasDurableIdentifier(styleOnly.groundTruth.identity), true);
  assert.equal(hasDurableIdentifier(gtinOnly.groundTruth.identity), true);
  assert.equal(evaluateIdentityEligibility(styleOnly).eligible, true);
  assert.equal(evaluateIdentityEligibility(gtinOnly).eligible, true);
});

test('IDENTITY ELIGIBILITY: a retailer-internal product id is NOT a durable identifier', () => {
  // It dies with the listing, so it cannot carry identity past link rot.
  const identity = {
    style: { brand: 'X', productName: 'Y', retailerProductId: 'ABC-999' },
    variant: { colorwayName: 'Red' },
  };
  assert.equal(hasDurableIdentifier(identity), false);
  assert.equal(hasColorwayLevelTruth(identity), true);
});

test('IDENTITY ELIGIBILITY: a model-poisoned garment is never eligible and is flagged invalid', () => {
  const garment = makeGarment({ groundTruth: { evidence: [{ evidenceType: 'KSCAN_RESULT' }] } });
  const result = evaluateIdentityEligibility(garment);
  assert.equal(result.eligible, false);
  assert.equal(result.invalid, true);
});

/* ------------------------------------------------------------------ *
 * Provenance survives link rot (invariant 42.7)
 * ------------------------------------------------------------------ */

test('PROVENANCE: a record whose facts were transcribed survives removal of every URL pointer', () => {
  const garment = makeGarment({
    groundTruth: {
      evidence: [
        {
          evidenceType: 'RETAILER_PDP',
          urlPointer: 'https://retailer.example/product/12345',
          verifiedOn: '2026-09-01',
          verifiedBy: 'COL-TEST-01',
          observedFacts: { brand: 'Test Brand', styleCode: 'TB-QJ-1200', colorway: 'Deep Navy' },
        },
      ],
    },
  });
  const result = checkProvenanceSelfContained(garment);
  assert.equal(result.selfContained, true, `reasons: ${JSON.stringify(result.reasons)}`);
});

test('PROVENANCE: a record whose only evidence was the URL is NOT self-contained', () => {
  const garment = makeGarment({
    groundTruth: {
      evidence: [
        {
          evidenceType: 'RETAILER_PDP',
          urlPointer: 'https://retailer.example/product/12345',
          verifiedOn: '2026-09-01',
          verifiedBy: 'COL-TEST-01',
          observedFacts: {},
        },
      ],
    },
  });
  const result = checkProvenanceSelfContained(garment);
  assert.equal(result.selfContained, false);
  assert.ok(result.reasons.some((r) => r.includes('observedFacts') || r.includes('unusable')));
});

test('PROVENANCE: the derived grade is unchanged by URL removal for a well-formed record', () => {
  // This is the actual link-rot guarantee: a dead retail URL alone must never
  // invalidate a self-contained identifier-grade fixture (mission section 36).
  const garment = makeGarment({
    groundTruth: {
      evidence: [
        {
          evidenceType: 'MANUFACTURER_TAG',
          urlPointer: 'https://retailer.example/p/1',
          verifiedOn: '2026-09-01',
          verifiedBy: 'COL-TEST-01',
          observedFacts: { brandOnTag: 'Test Brand', styleCodeOnTag: 'TB-QJ-1200', colorwayOnTag: 'Deep Navy' },
        },
      ],
    },
  });
  const before = deriveGrade(garment.groundTruth).grade;
  const result = checkProvenanceSelfContained(garment);
  assert.equal(before, 'IDENTIFIER_GRADE');
  assert.equal(result.selfContained, true);
});
