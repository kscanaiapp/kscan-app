'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateReportShape } = require('./reportSchema');
const { RUBRIC_VERSION } = require('../evaluator/rubric');

function baseReport(overrides = {}) {
  return {
    reportSchemaVersion: 'fmql-report-schema-v1',
    sourceSha: 'a'.repeat(40),
    fixtureManifestHash: 'deadbeef',
    rubricVersion: RUBRIC_VERSION,
    corpusTier: ['SYNTHETIC'],
    generatedAt: new Date().toISOString(),
    metrics: {
      sampleCounts: { totalFixturesEvaluated: 1 },
      identityDistribution: { EXACT: 1 },
      substituteDistribution: { STRONG_SUBSTITUTE: 1 },
      fashionComponentAverages: {},
      duplicateMetrics: {},
      retailerNeutralityMetrics: {},
      captureProfileStratification: {},
    },
    controls: [{ name: 'x', verdict: 'PASS' }],
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
    ...overrides,
  };
}

test('REPORT SCHEMA: a well-formed report is accepted', () => {
  const { valid, errors } = validateReportShape(baseReport());
  assert.equal(valid, true, errors.join('; '));
});

test('REPORT SCHEMA: an empty report is rejected', () => {
  const { valid, errors } = validateReportShape({});
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});

test('REPORT SCHEMA: null/undefined report is rejected', () => {
  assert.equal(validateReportShape(null).valid, false);
  assert.equal(validateReportShape(undefined).valid, false);
});

test('REPORT SCHEMA: missing required top-level field is rejected', () => {
  const report = baseReport();
  delete report.sourceSha;
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('sourceSha')));
});

test('REPORT SCHEMA: missing a required metric dimension is rejected', () => {
  const report = baseReport();
  delete report.metrics.duplicateMetrics;
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('duplicateMetrics')));
});

test('REPORT SCHEMA: wrong benchmarkStatus string is rejected (spec section 7)', () => {
  const report = baseReport({ benchmarkStatus: 'PROVEN SUPERIOR TO COMPETITORS' });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('benchmarkStatus')));
});

test('REPORT SCHEMA: empty controls array is rejected', () => {
  const report = baseReport({ controls: [] });
  const { valid } = validateReportShape(report);
  assert.equal(valid, false);
});

test('REPORT SCHEMA: an invalid control verdict is rejected', () => {
  const report = baseReport({ controls: [{ name: 'x', verdict: 'MAYBE' }] });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('verdict must be one of')));
});

test('REPORT SCHEMA: a negative identity distribution count is rejected (allowed-range check)', () => {
  const report = baseReport();
  report.metrics.identityDistribution.EXACT = -1;
  const { valid } = validateReportShape(report);
  assert.equal(valid, false);
});

test('REPORT SCHEMA: a report carrying a privacy-prohibited field is rejected', () => {
  const report = baseReport({ debugUserId: undefined, user_id: 'abc' });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
});
