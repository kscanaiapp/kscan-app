'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { generateReport } = require('./generateReport');
const { validateReportShape } = require('../schema/reportSchema');
const { stripVolatile, canonicalHash } = require('../lib/canonicalJson');
const { isDenoAvailable } = require('../l1/runL1');

const NONEXISTENT_BASELINE = path.join(__dirname, '..', 'baseline', '__does_not_exist_for_determinism_test__.json');

test('REPORTING: a generated report validates against the report schema', () => {
  const report = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });
  const { valid, errors } = validateReportShape(report);
  assert.equal(valid, true, errors.join('; '));
});

test('DETERMINISM (spec section 24): two report runs over identical inputs produce the same canonical content hash, excluding the generation timestamp', () => {
  const r1 = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });
  const r2 = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });

  assert.notEqual(r1.generatedAt, undefined);
  // The two runs are not required to share a wall-clock timestamp, but
  // everything else must be byte-identical once timestamps are excluded.
  const h1 = canonicalHash(stripVolatile(r1, ['generatedAt', 'contentHash']));
  const h2 = canonicalHash(stripVolatile(r2, ['generatedAt', 'contentHash']));
  assert.equal(h1, h2);
  assert.equal(r1.contentHash, r2.contentHash, 'contentHash itself already excludes generatedAt and must match');
});

test('REPORTING: report always declares BENCHMARK STATUS as internal-only (spec section 7)', () => {
  const report = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });
  assert.equal(report.benchmarkStatus, 'INTERNAL ENGINEERING EVIDENCE ONLY');
});

test('REPORTING: report always declares LIVE MODE as not authorized for this build (spec section 22 L3)', () => {
  const report = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });
  assert.equal(report.liveMode, 'NOT AUTHORIZED');
});

test('REPORTING: offlinePipelineMode reflects real Deno availability rather than being hardcoded', () => {
  const report = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });
  if (isDenoAvailable()) {
    assert.notEqual(report.offlinePipelineMode, 'BLOCKED');
  } else {
    assert.equal(report.offlinePipelineMode, 'BLOCKED');
  }
});

test('REPORTING: report contractMode is PASS only when every contract control passed', () => {
  const report = generateReport({ baselinePath: NONEXISTENT_BASELINE, createBaselineIfMissing: false });
  const contractControls = report.controls.filter((c) => !['offline_pipeline_mode', 'replay_mode'].includes(c.name));
  const allPassed = contractControls.every((c) => c.verdict === 'PASS');
  assert.equal(report.contractMode, allPassed ? 'PASS' : 'FAIL');
});
