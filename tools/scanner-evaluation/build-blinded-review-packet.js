#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ROOT, resolveImageRef, sha256OfFile } = require('./lib/governedStorage');
const { assertOutsideGit } = require('./lib/imagePreparation');
const { REVIEWED_FIELDS } = require('./lib/holdoutReview');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function canonicalMapForHash(map) {
  return {
    datasetVersion: map.datasetVersion,
    split: map.split,
    sourceImageAggregateSha256: map.sourceImageAggregateSha256,
    cases: map.cases.map((record) => ({
      blindId: record.blindId,
      caseId: record.caseId,
      images: record.images.map((image) => ({
        blindImageId: image.blindImageId,
        sourceSha256: image.sourceSha256,
      })),
    })),
  };
}

function governanceSummary(record) {
  const approvedAuthorization = new Set([
    'approved_qa_fixture',
    'approved_internal_eval',
    'synthetic_no_image',
  ]);
  const allowedPrivacy = new Set([
    'hash_and_label_only',
    'governed_fixture_reference',
    'synthetic_text_only',
    'masked_derivative_approved',
  ]);
  const complete = {
    authorizationApproved: approvedAuthorization.has(record.authorizationStatus),
    privacyDispositionApproved: allowedPrivacy.has(record.privacyDisposition),
    privacyReviewDatePresent: typeof record.privacyReviewDate === 'string' && record.privacyReviewDate.length > 0,
    retentionPolicyPresent: typeof record.retentionPolicyRef === 'string' && record.retentionPolicyRef.length > 0,
    exifRemoved: record.exifRemoved === true,
    faceReviewComplete: typeof record.faceReviewState === 'string' && record.faceReviewState.length > 0,
    plateReviewComplete: typeof record.plateReviewState === 'string' && record.plateReviewState.length > 0,
    governedDerivativeApproved: record.derivativeStatus === 'masked_derivative',
  };
  return { ...complete, complete: Object.values(complete).every(Boolean) };
}

function buildPacket(manifest, { split, outputDir }) {
  if (!['development', 'holdout'].includes(split)) throw new Error(`invalid split: ${split}`);
  assertOutsideGit(outputDir);
  if (fs.existsSync(outputDir)) throw new Error(`output collision: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'images'), { recursive: false });

  const ids = manifest.split[split];
  const selected = ids.map((id) => manifest.cases.find((record) => record.caseId === id));
  if (selected.some((record) => !record)) throw new Error('split references a missing candidate case');
  selected.sort((a, b) => sha256(`order|${manifest.sourceAggregateSha256}|${a.caseId}`)
    .localeCompare(sha256(`order|${manifest.sourceAggregateSha256}|${b.caseId}`)));

  let imageNumber = 0;
  const cases = selected.map((record, caseIndex) => {
    const blindId = `rv-${String(caseIndex + 1).padStart(3, '0')}`;
    const images = record.imageReferences.map((ref, index) => {
      imageNumber += 1;
      const blindImageId = `img-${String(imageNumber).padStart(3, '0')}`;
      const sourcePath = resolveImageRef(ref.refValue);
      const expectedHash = record.imageHashes[index];
      const actualHash = sha256OfFile(sourcePath);
      if (actualHash !== expectedHash) throw new Error(`source hash mismatch for ${blindImageId}`);
      const reviewPath = path.join(outputDir, 'images', `${blindImageId}.jpg`);
      fs.copyFileSync(sourcePath, reviewPath, fs.constants.COPYFILE_EXCL);
      return { blindImageId, sourceRef: ref.refValue, sourceSha256: expectedHash, reviewPath };
    });
    return { blindId, caseId: record.caseId, images };
  });

  const map = {
    datasetVersion: manifest.datasetVersion,
    split,
    sourceImageAggregateSha256: manifest.sourceAggregateSha256,
    cases,
  };
  map.opaqueCaseMapSha256 = sha256(JSON.stringify(canonicalMapForHash(map)));
  const guidePath = path.join(ROOT, 'docs', 'scanner-accuracy', 'labeling-guide.md');
  const brief = {
    reviewType: 'independent isolated AI review pass',
    datasetVersion: manifest.datasetVersion,
    split,
    guidePath,
    guideSha256: sha256(fs.readFileSync(guidePath)),
    sourceImageAggregateSha256: manifest.sourceAggregateSha256,
    opaqueCaseMapSha256: map.opaqueCaseMapSha256,
    reviewedFields: [...new Set([...REVIEWED_FIELDS, 'labelConfidence'])],
    instructions: [
      'Inspect only the supplied guide and opaque image paths.',
      'Do not inspect repository manifests, filenames, provenance, curator drafts, prior reviews, or Scanner output.',
      'Label each opaque case as one review unit. Multi-view units are grouped because the task explicitly asks for set-level labeling and same-item verification.',
      'Use only the exact controlled vocabulary in guide 1.1.0; never write a natural-language replacement for an ontology token.',
      'Set privacyAndAuthorizationComplete from the blinded governance summary and the guide rule, without using it to infer visual labels.',
      'Provide field-level evidence and uncertainty. Do not invent enum values.',
    ],
    cases: cases.map((record) => ({
      blindId: record.blindId,
      images: record.images.map((image) => ({ blindImageId: image.blindImageId, path: image.reviewPath })),
      governance: governanceSummary(selected.find((candidate) => candidate.caseId === record.caseId)),
    })),
  };
  const mapPath = path.join(outputDir, 'private-case-map.json');
  const briefPath = path.join(outputDir, 'review-brief.json');
  fs.writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  fs.writeFileSync(briefPath, `${JSON.stringify(brief, null, 2)}\n`, 'utf8');
  return { briefPath, mapPath, caseCount: cases.length, imageCount: imageNumber, ...brief };
}

function main(argv = process.argv.slice(2)) {
  const manifestArg = value(argv, '--manifest');
  const split = value(argv, '--split');
  const outputDir = value(argv, '--output-dir');
  if (!manifestArg || !split || !outputDir) {
    throw new Error('Usage: --manifest <candidate.json> --split development|holdout --output-dir <outside-git-dir>');
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestArg), 'utf8'));
  const result = buildPacket(manifest, { split, outputDir: path.resolve(outputDir) });
  console.log(JSON.stringify({ ok: true, ...result, cases: undefined, instructions: undefined }, null, 2));
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { buildPacket, canonicalMapForHash, governanceSummary, main };
