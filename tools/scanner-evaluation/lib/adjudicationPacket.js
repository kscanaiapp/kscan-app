'use strict';

const crypto = require('crypto');
const { compareReviews, lockLabelSet } = require('./holdoutReview');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertLocked(role, rawBytes, review, lock) {
  const artifactSha256 = sha256(rawBytes);
  const labelSetSha256 = lockLabelSet(review);
  if (lock.reviewerRole !== role) throw new Error(`Reviewer ${role} lock has the wrong role`);
  if (artifactSha256 !== lock.artifactSha256) throw new Error(`Reviewer ${role} artifact no longer matches its lock`);
  if (labelSetSha256 !== lock.labelSetSha256) throw new Error(`Reviewer ${role} labels no longer match their lock`);
}

function citedEvidence(label, field) {
  return {
    fieldEvidence: label.fieldEvidence && label.fieldEvidence[field] || null,
    evidenceBasis: label.evidenceBasis || null,
    uncertaintyNotes: label.uncertaintyNotes || null,
  };
}

function buildAdjudicationPacket({ brief, reviewA, reviewB, lockA, lockB, rawA, rawB }) {
  assertLocked('A', rawA, reviewA, lockA);
  assertLocked('B', rawB, reviewB, lockB);

  for (const [name, valueA, valueB] of [
    ['guide hash', reviewA.guideSha256, reviewB.guideSha256],
    ['opaque case-map hash', reviewA.opaqueCaseMapSha256, reviewB.opaqueCaseMapSha256],
    ['source-image aggregate', reviewA.sourceImageAggregateSha256, reviewB.sourceImageAggregateSha256],
  ]) {
    if (!valueA || valueA !== valueB) throw new Error(`Reviewer locks disagree on ${name}`);
  }

  const comparison = compareReviews(reviewA, reviewB);
  const disagreementsById = new Map();
  const labelsA = new Map(reviewA.labels.map((label) => [label.blindId, label]));
  const labelsB = new Map(reviewB.labels.map((label) => [label.blindId, label]));
  for (const disagreement of comparison.disagreements) {
    if (disagreement.blindId === '*') throw new Error('Set-level disagreement requires an explicit case id before adjudication');
    if (!disagreementsById.has(disagreement.blindId)) disagreementsById.set(disagreement.blindId, []);
    const labelA = labelsA.get(disagreement.blindId);
    const labelB = labelsB.get(disagreement.blindId);
    disagreementsById.get(disagreement.blindId).push({
      field: disagreement.field,
      kind: disagreement.kind,
      reviewerA: { value: disagreement.reviewerA, evidence: citedEvidence(labelA, disagreement.field) },
      reviewerB: { value: disagreement.reviewerB, evidence: citedEvidence(labelB, disagreement.field) },
    });
  }

  const cases = brief.cases
    .filter((reviewCase) => disagreementsById.has(reviewCase.blindId))
    .map((reviewCase) => ({
      blindId: reviewCase.blindId,
      images: reviewCase.images.map((image) => ({
        blindImageId: image.blindImageId,
        sourcePath: image.path,
      })),
      disagreements: disagreementsById.get(reviewCase.blindId),
    }));

  return {
    reviewType: 'isolated AI holdout adjudication',
    datasetVersion: brief.datasetVersion,
    guidePath: brief.guidePath,
    guideSha256: brief.guideSha256,
    sourceImageAggregateSha256: brief.sourceImageAggregateSha256,
    opaqueCaseMapSha256: brief.opaqueCaseMapSha256,
    locks: {
      reviewerA: { artifactSha256: lockA.artifactSha256, labelSetSha256: lockA.labelSetSha256, lockedAt: lockA.lockedAt },
      reviewerB: { artifactSha256: lockB.artifactSha256, labelSetSha256: lockB.labelSetSha256, lockedAt: lockB.lockedAt },
    },
    agreement: {
      exactStringNumerator: comparison.overall.agreedFieldInstances,
      exactStringDenominator: comparison.overall.comparedFieldInstances,
      disagreementCount: comparison.disagreementCount,
      sameItemIdentityAgreed: comparison.sameItem.agreed,
    },
    instructions: [
      'Inspect only this brief, its copied opaque images, and the referenced labeling guide.',
      'Adjudicate every listed field from the image evidence, the guide, and the two locked cited decisions.',
      'Do not inspect curator drafts, manifests, provenance, source identifiers, Scanner output, or either full review artifact.',
      'A legitimate final unknown or unavailable token is resolved; identify any unresolved guide contradiction explicitly.',
      'Return one final value and field-level rationale for every disagreement. Do not relabel agreed fields.',
    ],
    cases,
  };
}

module.exports = { buildAdjudicationPacket };
