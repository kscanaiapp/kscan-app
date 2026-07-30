#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ROOT } = require('./lib/governedStorage');
const { validateCandidate } = require('./lib/datasetPatchV031');
const runIdentity = require('./lib/runIdentity');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(file) {
  const absolute = path.resolve(file);
  return { absolute, raw: fs.readFileSync(absolute), value: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}

function repoRelative(absolute) {
  const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
  if (relative === '..' || relative.startsWith('../')) throw new Error(`${absolute} is outside the repository`);
  return relative;
}

function writeNew(file, value) {
  if (fs.existsSync(file)) throw new Error(`output collision: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

const manifest = readJson(argument('--manifest'));
const review = readJson(argument('--review'));
const patch = readJson(argument('--patch'));
const guide = { absolute: argument('--guide-lock') };
guide.raw = fs.readFileSync(guide.absolute);
const holdoutBrief = readJson(argument('--holdout-brief'));
const reviewerA = readJson(argument('--lock-a'));
const reviewerB = readJson(argument('--lock-b'));
const adjudication = readJson(argument('--adjudication-lock'));
const freezeOut = argument('--freeze-out');
const sealOut = argument('--seal-out');

const validation = validateCandidate(manifest.value);
if (!validation.ok || manifest.value.patchState !== 'reviewed_ground_truth') {
  throw new Error(`manifest is not reviewed v0.3.1 ground truth: ${validation.errors.join('; ')}`);
}
if (review.value.datasetVersion !== '0.3.1' || review.value.holdout.unresolvedCount !== 0) {
  throw new Error('review summary is not a complete v0.3.1 review');
}
if (patch.value.sourceVersion !== '0.3.0' || patch.value.patchVersion !== '0.3.1') {
  throw new Error('patch manifest version mismatch');
}
const guideHash = sha256(guide.raw);
if (guideHash !== review.value.guideSha256 || guideHash !== holdoutBrief.value.guideSha256) {
  throw new Error('labeling guide hash mismatch');
}
for (const [name, lock, expected] of [
  ['Reviewer A', reviewerA.value, review.value.holdout.reviewerA],
  ['Reviewer B', reviewerB.value, review.value.holdout.reviewerB],
]) {
  if (lock.artifactSha256 !== expected.artifactSha256 || lock.labelSetSha256 !== expected.labelSetSha256) {
    throw new Error(`${name} lock does not match review summary`);
  }
}
if (adjudication.value.artifactSha256 !== review.value.holdout.adjudicationArtifactSha256
    || adjudication.value.decisionSetSha256 !== review.value.holdout.adjudicationDecisionSetSha256
    || adjudication.value.unresolvedCount !== 0) {
  throw new Error('adjudication lock does not match review summary');
}

const governedFiles = [manifest.absolute, review.absolute, patch.absolute, guide.absolute];
const files = Object.fromEntries(governedFiles.map((absolute) => [repoRelative(absolute), sha256(fs.readFileSync(absolute))]));
const aggregateInput = Object.keys(files).sort().map((relative) => `${relative}:${files[relative]}\n`).join('');
const aggregateSha256 = sha256(Buffer.from(aggregateInput, 'utf8'));

const freeze = {
  frozenAs: 'LICENSED-WEB-IMAGE PILOT BENCHMARK',
  datasetVersion: '0.3.1',
  freezeDate: '2026-07-30',
  caseCount: 40,
  imageCount: 56,
  development: 33,
  holdout: 7,
  notARealWorldSmartGlassesBenchmark: true,
  notAComprehensiveBrandAccuracyCorpus: true,
  positiveBrandSupport: 'EXPLORATORY',
  reviewStatus: 'locked isolated AI review passes; holdout disagreements adjudicated',
  lineEndings: 'LF, normalised so the hash reproduces from a fresh clone',
  files,
  aggregateSha256,
  imagesInGit: 0,
  governedStorage: 'KScan-eval-storage-private/tier-a (outside every Git worktree); resolve with KSCAN_EVAL_STORAGE_ROOT',
};

const reviewedFields = holdoutBrief.value.reviewedFields;
const holdoutSet = new Set(manifest.value.split.holdout);
const holdoutGroundTruth = manifest.value.cases
  .filter((record) => holdoutSet.has(record.caseId))
  .sort((left, right) => left.caseId.localeCompare(right.caseId))
  .map((record) => ({
    caseId: record.caseId,
    ...Object.fromEntries(reviewedFields.map((field) => [field, record[field]])),
  }));
const holdoutCases = manifest.value.cases.filter((record) => holdoutSet.has(record.caseId));
const seal = {
  sealVersion: '1.0.0',
  sealedAt: new Date().toISOString(),
  datasetVersion: '0.3.1',
  datasetAggregateSha256: aggregateSha256,
  datasetManifestSha256: files[repoRelative(manifest.absolute)],
  reviewArtifactSha256: sha256(review.raw),
  finalGroundTruthSha256: manifest.value.finalGroundTruthSha256,
  holdoutGroundTruthSha256: sha256(JSON.stringify(holdoutGroundTruth)),
  lockedLabelSha256: runIdentity.lockedLabelHash(holdoutCases),
  holdoutCaseIds: manifest.value.split.holdout.slice(),
  holdoutCaseCount: 7,
  holdoutImageCount: 9,
  labelingGuideVersion: '1.1.0',
  labelingGuideSha256: guideHash,
  sourceImageAggregateSha256: holdoutBrief.value.sourceImageAggregateSha256,
  opaqueCaseMapSha256: holdoutBrief.value.opaqueCaseMapSha256,
  reviewedFields,
  reviewerA: {
    artifactSha256: reviewerA.value.artifactSha256,
    labelSetSha256: reviewerA.value.labelSetSha256,
    lockedAt: reviewerA.value.lockedAt,
  },
  reviewerB: {
    artifactSha256: reviewerB.value.artifactSha256,
    labelSetSha256: reviewerB.value.labelSetSha256,
    lockedAt: reviewerB.value.lockedAt,
  },
  agreement: review.value.holdout.exactStringAgreement,
  reviewerACompletedAt: reviewerA.value.lockedAt,
  reviewerBCompletedAt: reviewerB.value.lockedAt,
  adjudicationCompletedAt: adjudication.value.lockedAt,
  adjudication: {
    artifactSha256: adjudication.value.artifactSha256,
    decisionSetSha256: adjudication.value.decisionSetSha256,
    decisionCount: adjudication.value.decisionCount,
    unresolvedCount: 0,
    lockedAt: adjudication.value.lockedAt,
  },
  scannerOutputSeenBeforeLock: false,
  limitation: review.value.limitation,
};

writeNew(freezeOut, freeze);
writeNew(sealOut, seal);
process.stdout.write(`${JSON.stringify({ ok: true, aggregateSha256, holdoutGroundTruthSha256: seal.holdoutGroundTruthSha256 }, null, 2)}\n`);
