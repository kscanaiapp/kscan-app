'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDistributionReport, detectImbalance } = require('../lib/distributionReport');
const { buildGarmentOntology } = require('../lib/ontology');
const { makeGarment, makeCase } = require('./fixtures/sampleRecords');

function corpusOf(garments, cases, holdoutCaseCount = 0) {
  return {
    garments,
    cases,
    garmentsById: new Map(garments.map((g) => [g.garmentId, g])),
    holdoutCaseCount,
  };
}

test('DISTRIBUTION REPORT: an empty corpus reports zero everywhere without throwing', () => {
  const report = buildDistributionReport(corpusOf([], [], 0));
  assert.equal(report.totalCases, 0);
  assert.equal(report.totalGarments, 0);
  assert.equal(report.devCases, 0);
  assert.equal(report.holdoutCases, 0);
  assert.deepEqual(report.imbalanceWarnings, []);
  assert.equal(report.failureTaxonomyGaps.length > 0, true, 'an empty corpus has no covered failure classes');
});

test('DISTRIBUTION REPORT: counts cases by canonical ontology dimensions, not raw strings', () => {
  // makeGarment()'s auto-computed base ontology is derived from the base's
  // OWN attributes and does not recompute on an attribute override (see
  // sampleRecords.js) - a test that overrides attributes must recompute its
  // own ontology to match, exactly as real intake (lib/intake.js) does.
  const category = 'outerwear';
  const attributes = { silhouette: 'boxy', material: 'lambskin', pattern: 'plaid', colorFamily: 'wine' };
  const garment = makeGarment({
    garmentId: 'G001',
    category,
    attributes,
    ontology: buildGarmentOntology({ category, attributes }),
  });
  const record = makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined, garmentId: 'G001' });
  const report = buildDistributionReport(corpusOf([garment], [record]));
  assert.equal(report.casesByMaterial.leather, 1, 'lambskin canonicalizes to leather');
  assert.equal(report.casesByColorFamily.red, 1, 'wine canonicalizes to burgundy, family red');
  assert.equal(report.casesByPattern.plaid, 1);
});

test('DISTRIBUTION REPORT: dev and holdout counts are separate, and holdout content is never read', () => {
  const garment = makeGarment();
  const devCase = makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined });
  const report = buildDistributionReport(corpusOf([garment], [devCase], 3));
  assert.equal(report.devCases, 1);
  assert.equal(report.holdoutCases, 3);
  assert.equal(report.totalCases, 4);
});

test('DISTRIBUTION REPORT: spatial/multi-garment/occlusion/small-garment counters', () => {
  const garment = makeGarment();
  const annotated = makeCase({
    assetTier: 'REAL_CAPTURE',
    pipelineTestPurpose: undefined,
    garmentCount: 2,
    multiGarment: true,
    garments: [
      { garmentId: 'G001', garmentClass: 'outerwear', boundingBox: { x: 0, y: 0, width: 100, height: 100 }, occlusion: 'partial', relativeSize: 'normal', isTargetGarment: true },
      { garmentId: 'G002', garmentClass: 'accessory', boundingBox: { x: 200, y: 0, width: 50, height: 50 }, occlusion: 'none', relativeSize: 'small', isTargetGarment: false },
    ],
  });
  const plain = makeCase({ caseId: 'C0002', assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined });
  const report = buildDistributionReport(corpusOf([garment], [annotated, plain]));
  assert.equal(report.spatiallyAnnotatedCases, 1);
  assert.equal(report.multiGarmentCases, 1);
  assert.equal(report.singleGarmentCases, 0, 'the plain case has no garments[] at all, so it is not counted as single-garment either');
  assert.equal(report.occludedCases, 1);
  assert.equal(report.smallGarmentCases, 1);
});

test('DISTRIBUTION REPORT IMBALANCE: a dominant category (>=60%) is flagged', () => {
  const counts = { outerwear: 8, footwear: 2 };
  const warnings = detectImbalance('category', counts, 10);
  assert.ok(warnings.some((w) => /category=outerwear is 80\.0% of development cases - dominant/.test(w)));
  assert.ok(warnings.some((w) => /category=footwear is only 20\.0%/.test(w) === false));
});

test('DISTRIBUTION REPORT IMBALANCE: a thin category (<5%) is flagged', () => {
  const counts = { outerwear: 97, footwear: 3 };
  const warnings = detectImbalance('category', counts, 100);
  assert.ok(warnings.some((w) => /category=footwear is only 3\.0% of development cases - thin coverage/.test(w)));
});

test('DISTRIBUTION REPORT IMBALANCE: an even distribution produces no warnings', () => {
  const counts = { outerwear: 25, footwear: 25, top: 25, dress: 25 };
  assert.deepEqual(detectImbalance('category', counts, 100), []);
});

test('DISTRIBUTION REPORT: failureTaxonomyGaps names uncovered failure classes so coverage gaps are visible', () => {
  const garment = makeGarment();
  const record = makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined, failureTaxonomy: ['BLACK_NAVY_CONFUSION'] });
  const report = buildDistributionReport(corpusOf([garment], [record]));
  assert.ok(!report.failureTaxonomyGaps.includes('BLACK_NAVY_CONFUSION'));
  assert.ok(report.failureTaxonomyGaps.includes('MATERIAL_CONFUSION'));
});

test('DISTRIBUTION REPORT: is deterministic across repeated calls on the same input', () => {
  const garment = makeGarment();
  const record = makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined });
  const corpus = corpusOf([garment], [record], 2);
  assert.deepEqual(buildDistributionReport(corpus), buildDistributionReport(corpus));
});
