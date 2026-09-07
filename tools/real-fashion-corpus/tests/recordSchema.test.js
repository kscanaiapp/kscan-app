'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateGarment, validateCase } = require('../lib/recordSchema');
const { makeGarment, makeCase } = require('./fixtures/sampleRecords');

function expectInvalid(result, matcher, label) {
  assert.equal(result.valid, false, `${label}: expected invalid but it validated`);
  assert.ok(
    result.errors.some((e) => matcher.test(e)),
    `${label}: no error matched ${matcher}. Errors were:\n  ${result.errors.join('\n  ')}`,
  );
}

/* ------------------------------------------------------------------ *
 * Garment
 * ------------------------------------------------------------------ */

test('GARMENT SCHEMA: the reference garment validates', () => {
  const result = validateGarment(makeGarment());
  assert.equal(result.valid, true, `errors: ${result.errors.join('; ')}`);
});

test('GARMENT SCHEMA: model-derived evidence is rejected by the schema, not just by grading', () => {
  // Three independent refusals guard mission section 5; this is the first.
  for (const evidenceType of ['KSCAN_RESULT', 'SCANNER_OUTPUT', 'GEMINI_OUTPUT', 'LLM_INFERRED_BRAND']) {
    const garment = makeGarment({ groundTruth: { evidence: [{ evidenceType, verifiedOn: '2026-09-01', verifiedBy: 'X', observedFacts: { a: 1 } }] } });
    expectInvalid(validateGarment(garment), /model-derived and forbidden/, evidenceType);
  }
});

test('GARMENT SCHEMA: an asserted grade higher than the evidence supports is rejected', () => {
  // Grade inflation must be a validation error, not a surviving typo.
  const garment = makeGarment({
    groundTruth: {
      assertedGrade: 'IDENTIFIER_GRADE',
      identity: { style: { styleCode: undefined }, variant: { gtin: undefined } },
    },
  });
  expectInvalid(validateGarment(garment), /assertedGrade is IDENTIFIER_GRADE but the evidence present only supports PARTIAL/, 'inflated grade');
});

test('GARMENT SCHEMA: an asserted grade LOWER than the evidence supports is also rejected', () => {
  // Deflation is equally a mislabel, and would wrongly shrink the identity
  // denominator rather than inflate it.
  const garment = makeGarment({ groundTruth: { assertedGrade: 'PARTIAL' } });
  expectInvalid(validateGarment(garment), /assertedGrade is PARTIAL but the evidence present only supports IDENTIFIER_GRADE/, 'deflated grade');
});

test('GARMENT SCHEMA: evidence without observedFacts is rejected (URL cannot be the only evidence)', () => {
  const garment = makeGarment({
    groundTruth: {
      evidence: [{ evidenceType: 'RETAILER_PDP', verifiedOn: '2026-09-01', verifiedBy: 'X', urlPointer: 'https://x.example/p' }],
    },
  });
  expectInvalid(validateGarment(garment), /observedFacts is required/, 'missing observedFacts');
});

test('GARMENT SCHEMA: catalogStateVerifiedOn is required (mission section 20)', () => {
  const garment = makeGarment({ groundTruth: { catalogStateVerifiedOn: undefined } });
  expectInvalid(validateGarment(garment), /catalogStateVerifiedOn/, 'missing catalogue date');
});

test('GARMENT SCHEMA: an in-store capture must attest that store policy was respected', () => {
  const garment = makeGarment({ collection: { source: 'AUTHORIZED_IN_STORE' } });
  expectInvalid(validateGarment(garment), /storePolicyRespected/, 'in-store without attestation');

  const ok = makeGarment({ collection: { source: 'AUTHORIZED_IN_STORE', storePolicyRespected: true } });
  assert.equal(validateGarment(ok).valid, true);
});

test('GARMENT SCHEMA: a result-set hard negative may not claim a capture', () => {
  // Mission section 14 keeps the two hard-negative kinds distinct. A metadata
  // -only record claiming an asset would inflate the real capture count.
  const garment = makeGarment({
    resultSetHardNegatives: [
      { reason: 'same silhouette, different brand', identity: { brand: 'Other' }, assetPath: 'G001/x.jpg' },
    ],
  });
  expectInvalid(validateGarment(garment), /must not carry assetPath or caseId/, 'result-set HN with asset');
});

test('GARMENT SCHEMA: a well-formed result-set hard negative is accepted with no capture', () => {
  const garment = makeGarment({
    resultSetHardNegatives: [
      {
        reason: 'visually near-identical quilted jacket from an adjacent brand',
        identity: { brand: 'Adjacent Brand', styleCode: 'AB-QJ-9', colorwayName: 'Navy' },
      },
    ],
  });
  assert.equal(validateGarment(garment).valid, true, validateGarment(garment).errors.join('; '));
});

test('GARMENT SCHEMA: a privacy-prohibited field anywhere in the record is rejected', () => {
  const garment = makeGarment({ collection: { email: 'collector@example.com' } });
  expectInvalid(validateGarment(garment), /privacy_violation/, 'email in record');
});

/* ------------------------------------------------------------------ *
 * Case
 * ------------------------------------------------------------------ */

test('CASE SCHEMA: the reference case validates', () => {
  const result = validateCase(makeCase());
  assert.equal(result.valid, true, `errors: ${result.errors.join('; ')}`);
});

test('CASE SCHEMA: every case names the garment it captured', () => {
  expectInvalid(validateCase(makeCase({ garmentId: undefined })), /garmentId must match G###/, 'no garmentId');
});

test('CASE SCHEMA: an asset claiming location EXIF was NOT stripped is rejected', () => {
  const record = makeCase({ asset: { exifSanitization: { locationStripped: false } } });
  expectInvalid(validateCase(record), /locationStripped must be true/, 'unstripped location');
});

test('CASE SCHEMA: a stale EXIF policy version is rejected', () => {
  const record = makeCase({ asset: { exifSanitization: { policyVersion: 'rfc-exif-policy-v0' } } });
  expectInvalid(validateCase(record), /policyVersion must be/, 'stale exif policy');
});

test('CASE SCHEMA: capture profile must agree with the device platform', () => {
  const mismatched = makeCase({
    capture: { device: { platform: 'android', model: 'Test Android' }, captureProfile: 'ios-current-v1' },
  });
  expectInvalid(validateCase(mismatched), /platform is 'android' but captureProfile is 'ios-current-v1'/, 'profile mismatch');
});

test('CASE SCHEMA: captured dimensions are required (mission section 15 - do not fabricate parity)', () => {
  expectInvalid(validateCase(makeCase({ capture: { capturedDimensions: undefined } })), /capturedDimensions is required/, 'no dimensions');
});

test('CASE SCHEMA: a WORN capture requires explicit collector consent', () => {
  const noConsent = makeCase({
    capture: { captureType: 'WORN', consent: { humanPresent: true, consentStatus: 'NOT_APPLICABLE' } },
  });
  expectInvalid(validateCase(noConsent), /EXPLICIT_COLLECTOR_CONSENT/, 'worn without consent');

  const withConsent = makeCase({
    capture: { captureType: 'WORN', consent: { humanPresent: true, consentStatus: 'EXPLICIT_COLLECTOR_CONSENT' } },
  });
  assert.equal(validateCase(withConsent).valid, true, validateCase(withConsent).errors.join('; '));
});

test('CASE SCHEMA: a WORN capture that claims no human present is rejected as internally inconsistent', () => {
  const record = makeCase({ capture: { captureType: 'WORN' } });
  expectInvalid(validateCase(record), /implies a human is present/, 'worn but humanPresent false');
});

test('CASE SCHEMA: unrelated people in frame are rejected outright', () => {
  const record = makeCase({
    capture: {
      captureType: 'WORN',
      consent: { humanPresent: true, consentStatus: 'EXPLICIT_COLLECTOR_CONSENT', unrelatedPeoplePresent: true },
    },
  });
  expectInvalid(validateCase(record), /no unrelated people/, 'unrelated people');
});

test('CASE SCHEMA: biometric or inferred-sensitive-attribute annotations are refused', () => {
  for (const field of ['biometric', 'faceEmbedding', 'inferredAge', 'inferredGender', 'inferredEthnicity']) {
    const record = makeCase({ capture: { consent: { [field]: 'anything' } } });
    expectInvalid(validateCase(record), new RegExp(`${field} is forbidden`), field);
  }
});

test('CASE SCHEMA: an asset path escaping the asset root is rejected', () => {
  for (const bad of ['../secrets/x.jpg', '/etc/passwd', 'C:/Users/x/photo.jpg']) {
    expectInvalid(validateCase(makeCase({ asset: { assetPath: bad } })), /relative path inside the asset root/, bad);
  }
});

test('CASE SCHEMA: sha256 must be a real 64-char lowercase hex digest', () => {
  for (const bad of ['abc', 'A'.repeat(64), '0'.repeat(63)]) {
    expectInvalid(validateCase(makeCase({ asset: { sha256: bad } })), /sha256 must be a 64-character/, bad);
  }
});

test('CASE SCHEMA: an input hard negative must name a DIFFERENT garment', () => {
  expectInvalid(
    validateCase(makeCase({ inputHardNegativeOf: 'G001' })),
    /must name a DIFFERENT garment/,
    'self hard-negative',
  );
  assert.equal(validateCase(makeCase({ inputHardNegativeOf: 'G002' })).valid, true);
});

test('CASE SCHEMA: a PIPELINE_TEST_ASSET case must declare what it exercises', () => {
  expectInvalid(
    validateCase(makeCase({ pipelineTestPurpose: undefined })),
    /must state pipelineTestPurpose/,
    'test asset without purpose',
  );
});

test('CASE SCHEMA: a REAL_CAPTURE case must NOT carry pipelineTestPurpose', () => {
  const record = makeCase({ assetTier: 'REAL_CAPTURE' });
  expectInvalid(validateCase(record), /must not carry pipelineTestPurpose/, 'real case with test purpose');
});

test('CASE SCHEMA: a case may not be its own pair', () => {
  expectInvalid(
    validateCase(makeCase({ pairing: { pairedCaseId: 'C0001' } })),
    /must not be the case itself/,
    'self pair',
  );
});

test('CASE SCHEMA: unknown difficulty strata are rejected rather than silently kept', () => {
  expectInvalid(
    validateCase(makeCase({ difficultyStrata: ['DARK_GARMENT', 'SPARKLY'] })),
    /unknown value "SPARKLY"/,
    'unknown stratum',
  );
});
