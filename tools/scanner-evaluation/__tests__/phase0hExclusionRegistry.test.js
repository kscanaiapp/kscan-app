'use strict';

/**
 * Phase 0H — exclusion registry enforcement.
 *
 * The eight QA fixtures are `excluded_pending_provenance`. Before this phase the
 * exclusion existed only as prose in an inventory document, which cannot stop a
 * file being added to a manifest. These tests exercise the mechanism that can.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../lib/exclusionRegistry');
const { validateCase } = require('../lib/datasetValidate');

const BOTTOM_SKIRT_SHA = '3488934132872918e05c6663c87322c994b84ecf989dbad865d32501b2d58ae7';
const FOOTWEAR_SHA = '8c4f330f9a966ca41ee4b1558849528bf094acfc5bfb195723c8033b8c61b3b5';

function governedCase(overrides = {}) {
  return {
    caseId: 'gov-1',
    datasetVersion: '0.2.0',
    imageReferences: [{ refType: 'governed_object_storage', refValue: 'storage://build4-scanner-evals/gov-1/front' }],
    imageHashes: [`sha256:${'d'.repeat(64)}`],
    imageCount: 1,
    sameItemAcrossImages: 'not_applicable',
    category: 'top',
    clothingType: 'unknown',
    subtype: 'unknown',
    primaryColor: 'unknown',
    secondaryColors: 'unknown',
    material: 'unknown',
    pattern: 'unknown',
    brand: 'unknown',
    exactProduct: 'unknown',
    expectedResultType: 'identified_style',
    expectedAbstention: false,
    reviewStatus: 'approved',
    reviewerCount: 1,
    labelConfidence: 'medium',
    sourceClass: 'internally_generated',
    authorizationStatus: 'approved_internal_eval',
    privacyDisposition: 'hash_and_label_only',
    notes: 'test',
    ...overrides,
  };
}

function exclusionErrors(caseRecord) {
  return validateCase(caseRecord).errors.filter((e) => /excluded from evaluation use/.test(e.message));
}

// ── Registry contents ────────────────────────────────────────────────────────

test('registry covers all eight pending-provenance fixtures', () => {
  assert.equal(registry.REGISTRY.entries.length, 8);
  for (const entry of registry.REGISTRY.entries) {
    assert.match(entry.excludedPath, /^assets\/qa_fixtures\/.+\.jpg$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.reasonCode, 'excluded_pending_provenance');
  }
});

test('the exclusion is not characterized as permanent', () => {
  assert.equal(registry.REGISTRY.notPermanent, true);
  assert.ok(registry.REGISTRY.reintroductionRequires.length >= 2);
  // And it asserts nothing about age, ownership, consent or legality.
  const blob = JSON.stringify(registry.REGISTRY).toLowerCase();
  for (const forbidden of ['minor', 'illegal', 'unlawful', 'stolen']) {
    assert.equal(blob.includes(forbidden), false, `registry must not assert "${forbidden}"`);
  }
});

test('enforcement declares all three axes', () => {
  assert.deepEqual(registry.REGISTRY.enforcement, [
    'normalized_repository_path',
    'sha256_content_hash',
    'derivative_source_relationship',
  ]);
});

// ── Axis 1: normalized path ──────────────────────────────────────────────────

test('rejects an excluded fixture by repository path', () => {
  const errors = exclusionErrors(
    governedCase({ imageReferences: [{ refType: 'g', refValue: 'assets/qa_fixtures/top.jpg' }] })
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /normalized_repository_path/);
});

test('path normalization defeats separator and prefix variation', () => {
  for (const variant of [
    '.\\assets\\qa_fixtures\\top.jpg',
    './assets/qa_fixtures/top.jpg',
    'ASSETS/QA_FIXTURES/TOP.JPG',
    '/assets/qa_fixtures/top.jpg',
  ]) {
    const errors = exclusionErrors(
      governedCase({ imageReferences: [{ refType: 'g', refValue: variant }] })
    );
    assert.ok(errors.length >= 1, `variant must be rejected: ${variant}`);
  }
});

// ── Axis 2: content hash ─────────────────────────────────────────────────────

test('rejects excluded content by sha256 even from a different path', () => {
  const errors = exclusionErrors(
    governedCase({
      imageReferences: [{ refType: 'g', refValue: 'storage://build4-scanner-evals/renamed/front' }],
      imageHashes: [`sha256:${BOTTOM_SKIRT_SHA}`],
    })
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /sha256_content_hash/);
});

test('hash matching accepts bare hex and sha256: prefixed forms', () => {
  assert.equal(registry.checkReference({ sha256: FOOTWEAR_SHA }).excluded, true);
  assert.equal(registry.checkReference({ sha256: `sha256:${FOOTWEAR_SHA}` }).excluded, true);
  assert.equal(registry.checkReference({ sha256: FOOTWEAR_SHA.toUpperCase() }).excluded, true);
});

// ── Axis 3: derivative source ────────────────────────────────────────────────

test('rejects a transformation derivative of excluded material', () => {
  const errors = exclusionErrors(
    governedCase({
      imageReferences: [
        {
          refType: 'g',
          refValue: 'storage://build4-scanner-evals/crop-1/front',
          derivedFromPath: 'assets/qa_fixtures/dress.jpg',
        },
      ],
    })
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /derivative_source_relationship/);
});

test('rejects a case-level derivative declared by source hash', () => {
  const errors = exclusionErrors(governedCase({ derivedFromSha256: FOOTWEAR_SHA }));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /derivative_source_relationship/);
});

// ── bottom_skirt.jpg dedicated test (contract requirement) ───────────────────

test('bottom_skirt.jpg is rejected from every artifact shape', () => {
  const path = 'assets/qa_fixtures/bottom_skirt.jpg';

  // Dataset manifest
  assert.ok(registry.scanArtifact({ cases: [{ imageReferences: [{ refValue: path }] }] }, 'dataset manifest').length >= 1);
  // Baseline manifest
  assert.ok(registry.scanArtifact({ baseline: { images: [{ path }] } }, 'baseline manifest').length >= 1);
  // Candidate list
  assert.ok(registry.scanArtifact({ candidates: [{ governedRef: path }] }, 'candidate list').length >= 1);
  // Derived-image source record
  assert.ok(registry.scanArtifact({ derived: [{ derivedFromPath: path }] }, 'derived-image source record').length >= 1);
  // Holdout list — a bare string entry
  assert.ok(registry.scanArtifact({ holdout: [path] }, 'holdout list').length >= 1);

  // And by hash, in a holdout list that never names the path.
  const byHash = registry.scanArtifact({ holdout: [{ sha256: BOTTOM_SKIRT_SHA }] }, 'holdout list');
  assert.ok(byHash.length >= 1);
  assert.equal(byHash[0].reasonCode, 'excluded_pending_provenance');
});

// ── Control: a clean governed case must still be admissible ──────────────────

test('a clean governed case is not rejected by the registry', () => {
  const result = validateCase(governedCase());
  const errors = result.errors.filter((e) => /excluded from evaluation use/.test(e.message));
  assert.deepEqual(errors, [], 'the registry must not reject legitimate governed imagery');
});

test('enforcement is unconditional, not behind a validation option', () => {
  // The same case must be rejected under every validation profile.
  const bad = governedCase({ imageReferences: [{ refType: 'g', refValue: 'assets/qa_fixtures/accessory.jpg' }] });
  for (const options of [{}, { requirePhase0bPrivacy: true }, { requireTwoReviewers: true }]) {
    const errors = validateCase(bad, options).errors.filter((e) => /excluded from evaluation use/.test(e.message));
    assert.ok(errors.length >= 1, `must be rejected under ${JSON.stringify(options)}`);
  }
});
