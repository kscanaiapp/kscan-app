'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const patch = require('../lib/datasetPatchV031');
const { buildPacket, governanceSummary } = require('../build-blinded-review-packet');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE = path.join(ROOT, 'evals', 'scanner-accuracy', 'tier-a-manifest.v0.3.0.json');

function sourceManifest() {
  return JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
}

test('v0.3.1 candidate is deterministic and leaves v0.3.0 bytes untouched', () => {
  const before = fs.readFileSync(SOURCE);
  const first = patch.buildCandidate(sourceManifest());
  const second = patch.buildCandidate(sourceManifest());
  assert.deepEqual(first, second);
  assert.deepEqual(fs.readFileSync(SOURCE), before);
  assert.equal(patch.validateCandidate(first).ok, true);
});

test('duplicate mug cases become one opaque two-view holdout case with one weight', () => {
  const candidate = patch.buildCandidate(sourceManifest());
  const validation = patch.validateCandidate(candidate);
  const merged = candidate.cases.find((record) => record.caseId === validation.mergedCaseId);
  assert.match(merged.caseId, /^case-[a-f0-9]{16}$/);
  assert.equal(merged.imageCount, 2);
  assert.equal(merged.sameItemAcrossImages, true);
  assert.equal(merged.patchMetadata.caseWeight, 1);
  assert.deepEqual(merged.patchMetadata.originalCaseIds, patch.DUPLICATE_CASE_IDS);
  assert.equal(merged.patchMetadata.originalSourceHashes.length, 2);
  assert.match(merged.patchMetadata.mergeEvidence, /Project owner designated/);
  assert.doesNotMatch(merged.patchMetadata.mergeEvidence, /review|adjudicat/i);
  assert.equal(candidate.split.holdout.includes(merged.caseId), true);
  for (const id of patch.DUPLICATE_CASE_IDS) assert.equal(candidate.cases.some((record) => record.caseId === id), false);
});

test('candidate counts are truthful and all 56 source hashes are preserved', () => {
  const source = sourceManifest();
  const candidate = patch.buildCandidate(source);
  assert.equal(candidate.caseCount, 40);
  assert.equal(candidate.sourceImageCount, 56);
  assert.equal(candidate.split.development.length, 33);
  assert.equal(candidate.split.holdout.length, 7);
  assert.deepEqual(
    candidate.cases.flatMap((record) => record.imageHashes).slice().sort(),
    source.cases.flatMap((record) => record.imageHashes).slice().sort()
  );
});

test('all non-fashion cases use the canonical guide encoding', () => {
  const candidate = patch.buildCandidate(sourceManifest());
  for (const record of candidate.cases.filter((item) => item.nonFashion === true)) {
    for (const field of [
      'category', 'clothingType', 'subtype', 'primaryColor', 'secondaryColors',
      'material', 'pattern', 'brand', 'exactProduct',
    ]) assert.equal(record[field], 'not_applicable', `${record.caseId}.${field}`);
    assert.equal(record.expectedResultType, 'insufficient_evidence');
    assert.equal(record.expectedAbstention, true);
  }
});

test('blinded packet creator creates a new output tree and refuses collisions', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'v031-review-packet-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const storageRoot = path.join(tempRoot, 'storage');
  const sourceDir = path.join(storageRoot, 'opaque-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, 'primary.jpg');
  fs.writeFileSync(source, Buffer.from('mechanical review packet fixture'));
  const hash = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')}`;
  const previous = process.env.KSCAN_EVAL_STORAGE_ROOT;
  process.env.KSCAN_EVAL_STORAGE_ROOT = storageRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.KSCAN_EVAL_STORAGE_ROOT;
    else process.env.KSCAN_EVAL_STORAGE_ROOT = previous;
  });
  const manifest = {
    datasetVersion: '0.3.1',
    sourceAggregateSha256: 'a'.repeat(64),
    split: { development: ['opaque-source'], holdout: [] },
    cases: [{
      caseId: 'opaque-source',
      imageReferences: [{ refValue: 'storage://eval/tier-a/opaque-source/primary' }],
      imageHashes: [hash],
      authorizationStatus: 'approved_internal_eval',
      privacyDisposition: 'hash_and_label_only',
      privacyReviewDate: '2026-07-30',
      retentionPolicyRef: 'retention-policy',
      exifRemoved: true,
      faceReviewState: 'no_face_present',
      plateReviewState: 'no_plate_present',
      derivativeStatus: 'masked_derivative',
    }],
  };
  const outputDir = path.join(tempRoot, 'new-version-parent', 'packet');
  const result = buildPacket(manifest, { split: 'development', outputDir });
  assert.equal(result.caseCount, 1);
  assert.equal(result.imageCount, 1);
  assert.equal(fs.existsSync(result.briefPath), true);
  assert.equal(fs.existsSync(result.mapPath), true);
  const brief = JSON.parse(fs.readFileSync(result.briefPath, 'utf8'));
  assert.equal(brief.cases[0].governance.complete, true);
  assert.equal(new Set(brief.reviewedFields).size, brief.reviewedFields.length);
  assert.throws(() => buildPacket(manifest, { split: 'development', outputDir }), /output collision/);
});

test('governance summary fails closed when any required record is absent', () => {
  const summary = governanceSummary({
    authorizationStatus: 'approved_internal_eval',
    privacyDisposition: 'hash_and_label_only',
    privacyReviewDate: '2026-07-30',
    retentionPolicyRef: 'retention-policy',
    exifRemoved: true,
    faceReviewState: 'no_face_present',
    plateReviewState: 'no_plate_present',
  });
  assert.equal(summary.governedDerivativeApproved, false);
  assert.equal(summary.complete, false);
});
