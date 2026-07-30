'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAdjudicationPacket } = require('../lib/adjudicationPacket');
const { lockLabelSet, REVIEWED_FIELDS } = require('../lib/holdoutReview');

function digest(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function review(role, value) {
  const label = { blindId: 'rv-001', fieldEvidence: { category: `${role} evidence` } };
  for (const field of REVIEWED_FIELDS) label[field] = field === 'category' ? value : 'same';
  return {
    reviewerRole: role,
    guideSha256: 'guide',
    opaqueCaseMapSha256: 'map',
    sourceImageAggregateSha256: 'source',
    labels: [label],
    sameItemGroups: [],
  };
}

test('adjudication packet contains only disagreements with locked cited evidence', () => {
  const reviewA = review('A', 'dress');
  const reviewB = review('B', 'apparel');
  const rawA = Buffer.from(JSON.stringify(reviewA));
  const rawB = Buffer.from(JSON.stringify(reviewB));
  const lockA = { reviewerRole: 'A', artifactSha256: digest(rawA), labelSetSha256: lockLabelSet(reviewA), lockedAt: 'a' };
  const lockB = { reviewerRole: 'B', artifactSha256: digest(rawB), labelSetSha256: lockLabelSet(reviewB), lockedAt: 'b' };
  const brief = {
    datasetVersion: '0.3.1', guidePath: 'guide.md', guideSha256: 'guide',
    opaqueCaseMapSha256: 'map', sourceImageAggregateSha256: 'source',
    cases: [{ blindId: 'rv-001', images: [{ blindImageId: 'img-001', path: 'opaque.jpg' }] }],
  };
  const packet = buildAdjudicationPacket({ brief, reviewA, reviewB, lockA, lockB, rawA, rawB });
  assert.equal(packet.cases.length, 1);
  assert.equal(packet.cases[0].disagreements.length, 1);
  assert.equal(packet.cases[0].disagreements[0].field, 'category');
  assert.equal(packet.cases[0].disagreements[0].reviewerA.value, 'dress');
  assert.equal(packet.cases[0].disagreements[0].reviewerA.evidence.fieldEvidence, 'A evidence');
  assert.equal(packet.cases[0].disagreements[0].reviewerB.value, 'apparel');
  assert.equal(packet.cases[0].disagreements[0].reviewerB.evidence.fieldEvidence, 'B evidence');
  assert.equal(packet.curatorDraft, undefined);
});

test('adjudication packet rejects a review changed after locking', () => {
  const reviewA = review('A', 'dress');
  const reviewB = review('B', 'apparel');
  const rawA = Buffer.from(JSON.stringify(reviewA));
  const rawB = Buffer.from(JSON.stringify(reviewB));
  const lockA = { reviewerRole: 'A', artifactSha256: digest(rawA), labelSetSha256: lockLabelSet(reviewA), lockedAt: 'a' };
  const lockB = { reviewerRole: 'B', artifactSha256: digest(rawB), labelSetSha256: lockLabelSet(reviewB), lockedAt: 'b' };
  reviewA.labels[0].category = 'changed';
  assert.throws(
    () => buildAdjudicationPacket({ brief: {}, reviewA, reviewB, lockA, lockB, rawA, rawB }),
    /no longer match/,
  );
});
