#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT } = require('./lib/governedStorage');
const { buildCandidate, validateCandidate, DUPLICATE_CASE_IDS } = require('./lib/datasetPatchV031');
const { validateReviewSubmission } = require('./lib/reviewValidation');
const { compareReviews, lockLabelSet } = require('./lib/holdoutReview');

const LABEL_FIELDS = Object.freeze([
  'category', 'clothingType', 'subtype', 'primaryColor', 'secondaryColors', 'material',
  'pattern', 'brand', 'exactProduct', 'expectedResultType', 'expectedAbstention',
  'nonFashion', 'visiblePerson', 'sameItemAcrossImages', 'labelConfidence',
]);
const REVIEW_METADATA_FIELDS = Object.freeze([
  'brandEvidenceState', 'expectedBrandAssertionBehavior', 'subjectDesignation',
  'privacyAndAuthorizationComplete',
]);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function read(file) { const raw = fs.readFileSync(file); return { raw, value: JSON.parse(raw.toString('utf8')) }; }
function arg(name) { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`); return path.resolve(process.argv[i + 1]); }
function writeNew(file, value) { if (fs.existsSync(file)) throw new Error(`output collision: ${file}`); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function lockMatches(raw, normalized, lock) {
  return sha256(raw) === lock.artifactSha256 && lockLabelSet(normalized) === lock.labelSetSha256;
}

const source = read(arg('--source')).value;
const devBrief = read(arg('--dev-brief')).value;
const devMap = read(arg('--dev-map')).value;
const devRaw = read(arg('--dev-review'));
const devLock = read(arg('--dev-lock')).value;
const holdBrief = read(arg('--holdout-brief')).value;
const holdMap = read(arg('--holdout-map')).value;
const aRaw = read(arg('--review-a'));
const aLock = read(arg('--lock-a')).value;
const bRaw = read(arg('--review-b'));
const bLock = read(arg('--lock-b')).value;
const adjRaw = read(arg('--adjudication'));
const adjLock = read(arg('--adjudication-lock')).value;
const manifestOut = arg('--manifest-out');
const reviewOut = arg('--review-out');
const patchOut = arg('--patch-out');

const devResult = validateReviewSubmission(devRaw.value, devBrief, { expectedRole: 'development_reviewer' });
const aResult = validateReviewSubmission(aRaw.value, holdBrief, { expectedRole: 'A' });
const bResult = validateReviewSubmission(bRaw.value, holdBrief, { expectedRole: 'B' });
if (!devResult.ok || !aResult.ok || !bResult.ok) throw new Error('one or more review artifacts failed validation');
if (!lockMatches(devRaw.raw, devResult.normalized, devLock)) throw new Error('development review lock mismatch');
if (!lockMatches(aRaw.raw, aResult.normalized, aLock)) throw new Error('Reviewer A lock mismatch');
if (!lockMatches(bRaw.raw, bResult.normalized, bLock)) throw new Error('Reviewer B lock mismatch');
if (sha256(adjRaw.raw) !== adjLock.artifactSha256) throw new Error('adjudication artifact lock mismatch');
if (adjRaw.value.unresolvedCount !== 0 || adjRaw.value.adjudications.some((d) => d.unresolvedGuideContradiction)) throw new Error('unresolved adjudication');

const comparison = compareReviews(aResult.normalized, bResult.normalized);
const expectedDecisions = comparison.disagreements.map((d) => `${d.blindId}|${d.field}`).sort();
const actualDecisions = adjRaw.value.adjudications.map((d) => `${d.blindId}|${d.field}`).sort();
if (JSON.stringify(expectedDecisions) !== JSON.stringify(actualDecisions)) throw new Error('adjudication does not exactly cover disagreements');

const candidate = buildCandidate(source);
const byCase = new Map(candidate.cases.map((record) => [record.caseId, record]));
const applySplit = (review, map, reviewerCount, adjudications = []) => {
  const mapByBlind = new Map(map.cases.map((record) => [record.blindId, record.caseId]));
  for (const reviewed of review.labels) {
    const caseId = mapByBlind.get(reviewed.blindId);
    const record = byCase.get(caseId);
    if (!record) throw new Error(`review map names missing case ${caseId}`);
    const finalLabel = JSON.parse(JSON.stringify(reviewed));
    for (const decision of adjudications.filter((d) => d.blindId === reviewed.blindId)) finalLabel[decision.field] = decision.finalValue;
    if (finalLabel.privacyAndAuthorizationComplete !== true) throw new Error(`${caseId} governance review is incomplete`);
    for (const field of [...LABEL_FIELDS, ...REVIEW_METADATA_FIELDS]) record[field] = finalLabel[field];
    record.reviewStatus = 'approved';
    record.reviewerCount = reviewerCount;
    record.brandVisible = finalLabel.brandEvidenceState === 'product_level_evidence';
    record.patchMetadata = {
      ...(record.patchMetadata || {}),
      subjectDesignation: finalLabel.subjectDesignation,
      brandEvidenceState: finalLabel.brandEvidenceState,
      expectedBrandAssertionBehavior: finalLabel.expectedBrandAssertionBehavior,
      privacyAndAuthorizationComplete: true,
    };
  }
};
applySplit(devResult.normalized, devMap, 1);
applySplit(aResult.normalized, holdMap, 3, adjRaw.value.adjudications);
candidate.patchState = 'reviewed_ground_truth';
candidate.review = {
  guideVersion: '1.1.0',
  guideSha256: devBrief.guideSha256,
  developmentArtifactSha256: devLock.artifactSha256,
  reviewerAArtifactSha256: aLock.artifactSha256,
  reviewerBArtifactSha256: bLock.artifactSha256,
  adjudicationArtifactSha256: adjLock.artifactSha256,
  unresolvedCount: 0,
};
const finalGroundTruth = candidate.cases.slice().sort((x, y) => x.caseId.localeCompare(y.caseId)).map((record) => ({
  caseId: record.caseId,
  ...Object.fromEntries(LABEL_FIELDS.map((field) => [field, record[field]])),
}));
candidate.finalGroundTruthSha256 = sha256(JSON.stringify(finalGroundTruth));
const validation = validateCandidate(candidate);
if (!validation.ok) throw new Error(`final candidate invalid: ${validation.errors.join('; ')}`);

const reviewSummary = {
  reviewArtifactVersion: '1.0.0', datasetVersion: '0.3.1', reviewType: 'independent isolated AI review passes',
  guideVersion: '1.1.0', guideSha256: devBrief.guideSha256,
  development: { caseCount: 33, artifactSha256: devLock.artifactSha256, labelSetSha256: devLock.labelSetSha256 },
  holdout: {
    caseCount: 7, imageCount: holdBrief.cases.reduce((n, c) => n + c.images.length, 0),
    reviewerA: { artifactSha256: aLock.artifactSha256, labelSetSha256: aLock.labelSetSha256 },
    reviewerB: { artifactSha256: bLock.artifactSha256, labelSetSha256: bLock.labelSetSha256 },
    exactStringAgreement: { numerator: comparison.overall.agreedFieldInstances, denominator: comparison.overall.comparedFieldInstances, rate: comparison.overall.rate },
    disagreementCount: comparison.disagreementCount,
    disagreementClasses: Object.fromEntries([...new Set(adjRaw.value.adjudications.map((d) => d.resolutionClass))].map((kind) => [kind, adjRaw.value.adjudications.filter((d) => d.resolutionClass === kind).length])),
    adjudicationArtifactSha256: adjLock.artifactSha256, adjudicationDecisionSetSha256: adjLock.decisionSetSha256,
    unresolvedCount: 0, sameItemIdentityAgreed: comparison.sameItem.agreed,
  },
  finalGroundTruthSha256: candidate.finalGroundTruthSha256,
  limitation: 'Agreement is between two isolated same-model AI review passes, not human inter-reviewer agreement, and is an optimistic bound because errors may be correlated.',
};
const patchManifest = {
  patchVersion: '0.3.1', sourceVersion: '0.3.0', sourceManifestSha256: sha256(fs.readFileSync(arg('--source'))),
  changes: ['merged the two owner-designated mug views into one holdout case with one weight', 'applied locked development review labels', 'applied locked and adjudicated holdout labels', 'added required review-linked metadata'],
  originalDuplicateCaseIds: DUPLICATE_CASE_IDS, mergedCaseId: validation.mergedCaseId,
  caseCount: 40, imageCount: 56, development: 33, holdout: 7,
  finalGroundTruthSha256: candidate.finalGroundTruthSha256,
};
writeNew(manifestOut, candidate);
writeNew(reviewOut, reviewSummary);
writeNew(patchOut, patchManifest);
process.stdout.write(`${JSON.stringify({ ok: true, manifestOut, reviewOut, patchOut, finalGroundTruthSha256: candidate.finalGroundTruthSha256 }, null, 2)}\n`);
