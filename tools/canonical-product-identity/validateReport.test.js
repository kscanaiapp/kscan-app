'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { independentSemanticChecks } = require('./validateReport');
const { validateReportShape } = require('./schema/reportSchema');
const { RESOLVER_VERSION, NORMALIZATION_VERSION } = require('./resolver/resolverVersion');
const { GENERATOR_VERSION } = require('./corpus/generator');
const { SCHEMA_VERSION: IDENTITY_SCHEMA_VERSION } = require('./schema/identitySchema');
const { REPORT_SCHEMA_VERSION } = require('./schema/reportSchema');

function validReport(overrides = {}) {
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    sourceSha: 'a'.repeat(40),
    corpusHash: 'hash',
    corpusTier: 'SYNTHETIC',
    resolverVersion: RESOLVER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: new Date().toISOString(),
    productionPromotion: 'HOLD - OWNER OPERATING-POINT + REAL-CORPUS VALIDATION REQUIRED',
    safetyMetrics: {
      totalPairsEvaluated: 10,
      autoMergePrecision: 1,
      autoMergeRecall: 0.8,
      falseMergeCount: 0,
      falseMergeRate: 0,
      falseMergeGateStatus: 'PASS - zero false merges',
      missedMergeRate: 0.2,
      abstentionRate: 0.1,
      abstentionCorrectness: 1,
      confusionMatrix: {
        SAME_VARIANT: { AUTO_MERGE: 4, PROPOSED_REVIEW: 1, ABSTAIN: 0, SEPARATE: 0 },
        SIBLING_VARIANT: { AUTO_MERGE: 0, PROPOSED_REVIEW: 0, ABSTAIN: 0, SEPARATE: 2 },
        NEAR_DUPLICATE_DISTINCT: { AUTO_MERGE: 0, PROPOSED_REVIEW: 0, ABSTAIN: 0, SEPARATE: 1 },
        DISTINCT: { AUTO_MERGE: 0, PROPOSED_REVIEW: 0, ABSTAIN: 1, SEPARATE: 1 },
        UNDECIDABLE: { AUTO_MERGE: 0, PROPOSED_REVIEW: 0, ABSTAIN: 1, SEPARATE: 0 },
      },
    },
    operatingCurve: [{ tier2AutoMergeThreshold: 'Infinity', autoMergePrecision: 1 }],
    incumbentComparison: { byMetric: { autoMergePrecision: 'N/A', autoMergeRecall: 'RESOLVER_BETTER', falseMergeRate: 'EQUAL', missedMergeRate: 'RESOLVER_BETTER', abstentionRate: 'RESOLVER_BETTER' } },
    qualityNoHarm: { summary: { overallVerdict: 'SAFE' } },
    placementSimulation: { evidenceClass: 'DERIVED_FROM_SOURCE' },
    resolverPerformance: [{ candidateSetSize: 10, p50Ms: 1, deterministic: true }],
    displayPolicy: { perWindow: [] },
    baseSanity: { verdict: 'PASS' },
    blockerLedger: [],
    decisionMemoCount: 5,
    divergenceFromBase: 'NO',
    ...overrides,
  };
}

// spec section 43#25: corrupted report fails independent validation.
test('VALIDATE REPORT: a well-formed report passes shape validation', () => {
  const { valid, errors } = validateReportShape(validReport());
  assert.equal(valid, true, JSON.stringify(errors));
});

test('VALIDATE REPORT: an empty object fails validation', () => {
  const { valid } = validateReportShape({});
  assert.equal(valid, false);
});

test('VALIDATE REPORT: a report missing safetyMetrics fails validation', () => {
  const report = validReport();
  delete report.safetyMetrics;
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /safetyMetrics/.test(e)));
});

test('VALIDATE REPORT: a report claiming false production-readiness (wrong productionPromotion wording) fails', () => {
  const report = validReport({ productionPromotion: 'READY FOR PRODUCTION' });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /productionPromotion/.test(e)));
});

test('VALIDATE REPORT: an empty operatingCurve array fails validation (section 26 requires the full sweep)', () => {
  const report = validReport({ operatingCurve: [] });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /operatingCurve/.test(e)));
});

test('VALIDATE REPORT: a privacy violation anywhere in the report fails validation', () => {
  const report = validReport({ leakedField: { user_id: 'abc' } });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('privacy_violation')));
});

// Addendum A.5#32 MUTATION CONTROL: bypassing the section 25 false-merge gate must fail a test.
test('VALIDATE REPORT (MUTATION CONTROL): a report whose confusionMatrix has an auto-merged DISTINCT pair but falseMergeCount=0/PASS is caught as internally inconsistent', () => {
  const report = validReport();
  report.safetyMetrics.confusionMatrix.DISTINCT.AUTO_MERGE = 3; // doctored - claims 0 false merges but the matrix shows 3
  const errors = independentSemanticChecks(report);
  assert.ok(errors.some((e) => /internally inconsistent/.test(e)));
});

test('VALIDATE REPORT (MUTATION CONTROL): a report that recomputes false merges > 0 but still claims a PASS gate status is rejected', () => {
  const report = validReport();
  report.safetyMetrics.confusionMatrix.DISTINCT.AUTO_MERGE = 3;
  report.safetyMetrics.falseMergeCount = 3; // internally consistent now...
  // ...but the gate status was NOT updated to reflect the failure - the bypass.
  report.safetyMetrics.falseMergeGateStatus = 'PASS - zero false merges';
  const errors = independentSemanticChecks(report);
  assert.ok(errors.some((e) => /gate bypass detected/.test(e)));
});

// Addendum A.5#33 MUTATION CONTROL: a doctored incumbent-comparison output
// claiming the resolver "always wins" must fail independent validation.
test('VALIDATE REPORT (MUTATION CONTROL): an incumbentComparison.byMetric with EVERY entry RESOLVER_BETTER (no EQUAL/N/A) is rejected as doctored', () => {
  const report = validReport();
  for (const key of Object.keys(report.incumbentComparison.byMetric)) {
    report.incumbentComparison.byMetric[key] = 'RESOLVER_BETTER';
  }
  const errors = independentSemanticChecks(report);
  assert.ok(errors.some((e) => /doctored/.test(e)));
});

test('VALIDATE REPORT (MUTATION CONTROL): an honest incumbentComparison mixing RESOLVER_BETTER/EQUAL/N/A is NOT flagged as doctored', () => {
  const report = validReport(); // has a mix already
  const errors = independentSemanticChecks(report);
  assert.ok(!errors.some((e) => /doctored/.test(e)));
});

test('VALIDATE REPORT: a stale resolverVersion claim is caught independently of what the report itself says', () => {
  const report = validReport({ resolverVersion: 'some-old-version' });
  const errors = independentSemanticChecks(report);
  assert.ok(errors.some((e) => /stale or mismatched resolver/.test(e)));
});
