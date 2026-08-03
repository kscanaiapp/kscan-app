'use strict';

/**
 * Preregistered control-anomaly classification tests.
 *
 * The central property under test is a NEGATIVE one: the invalid-rate delta
 * must never decide the verdict. Everything else here exists to prove the
 * classifier still catches the failures a rate threshold was standing in for.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  VERDICTS,
  REQUIRED_IDENTITIES,
  EXPECTED_DOMINANT_CAUSE,
  classifyControlRun,
  assertRateDeltaIsNotAVerdictInput,
} = require('../lib/controlAnomaly');

const CEILING = 2048;

function matchingIdentities(overrides = {}) {
  const identities = {};
  for (const name of REQUIRED_IDENTITIES) identities[name] = { expected: `${name}-hash`, observed: `${name}-hash` };
  return { ...identities, ...overrides };
}

/** A healthy run with `invalid` truncated cases, all landing at the ceiling. */
function healthyRun(invalid, caseCount = 33) {
  return {
    caseCount,
    completedCount: caseCount,
    invalidCount: invalid,
    invalidOutputCauseCounts: invalid ? { [EXPECTED_DOMINANT_CAUSE]: invalid } : {},
    finishReasonCounts: invalid ? { MAX_TOKENS: invalid, STOP: caseCount - invalid } : { STOP: caseCount },
    truncatedCaseCeilingDistances: Array.from({ length: invalid }, () => 15),
    configuredOutputCeiling: CEILING,
    accountingConsistent: true,
  };
}

const HISTORICAL = { caseCount: 33, invalidCount: 6 };

test('a fresh control matching historical is lockable', () => {
  const result = classifyControlRun({
    identities: matchingIdentities(), fresh: healthyRun(6), historical: HISTORICAL,
  });
  assert.equal(result.verdict, VERDICTS.EXPECTED_STOCHASTIC_VARIATION);
  assert.equal(result.lockable, true);
});

test('a swing far beyond ten points is still lockable when the mechanism is unchanged', () => {
  // 16/33 = 48.5% against a historical 18.2% — a 30-point move. Under the old
  // rate threshold this stops the run. It is exactly the case the preregistered
  // clarification exists to allow, because nothing about the run is wrong.
  const result = classifyControlRun({
    identities: matchingIdentities(), fresh: healthyRun(16), historical: HISTORICAL,
  });
  assert.equal(result.verdict, VERDICTS.EXPECTED_STOCHASTIC_VARIATION);
  assert.equal(result.lockable, true);
  assert.equal(result.reportOnly.invalidRateDeltaPp, 30.3);
});

test('a swing far below historical is equally lockable', () => {
  const result = classifyControlRun({
    identities: matchingIdentities(), fresh: healthyRun(0), historical: HISTORICAL,
  });
  assert.equal(result.verdict, VERDICTS.EXPECTED_STOCHASTIC_VARIATION);
  assert.equal(result.reportOnly.invalidRateDeltaPp, -18.2);
});

test('the rate delta is reported but cannot be smuggled in as evidence', () => {
  assert.throws(
    () => classifyControlRun({
      identities: matchingIdentities(),
      fresh: healthyRun(16),
      historical: HISTORICAL,
      rateDeltaExceedsThreshold: true,
    }),
    /must not be an input to the anomaly verdict/,
  );
  assert.throws(() => assertRateDeltaIsNotAVerdictInput({ tenPointRule: true }), /must not be an input/);
});

test('the verdict is identical across every invalid count when the mechanism holds', () => {
  // Sweeping the whole range proves the rate is not a hidden term anywhere.
  for (let invalid = 0; invalid <= 33; invalid += 1) {
    const result = classifyControlRun({
      identities: matchingIdentities(), fresh: healthyRun(invalid), historical: HISTORICAL,
    });
    assert.equal(
      result.verdict, VERDICTS.EXPECTED_STOCHASTIC_VARIATION,
      `invalid=${invalid} must not change the verdict`,
    );
  }
});

test('a drifted execution identity is an anomaly', () => {
  for (const name of REQUIRED_IDENTITIES) {
    const identities = matchingIdentities({ [name]: { expected: 'a', observed: 'b' } });
    const result = classifyControlRun({ identities, fresh: healthyRun(6), historical: HISTORICAL });
    assert.equal(result.verdict, VERDICTS.CONTROL_BASELINE_ANOMALY, `${name} drift must be an anomaly`);
    assert.ok(result.failedChecks.includes('execution_identity'));
  }
});

test('an unreported identity is an anomaly, not an assumed match', () => {
  const identities = matchingIdentities();
  delete identities.prompt;
  const result = classifyControlRun({ identities, fresh: healthyRun(6), historical: HISTORICAL });
  assert.equal(result.verdict, VERDICTS.CONTROL_BASELINE_ANOMALY);
});

test('a new dominant failure class is an anomaly even at the historical rate', () => {
  const fresh = healthyRun(6);
  fresh.invalidOutputCauseCounts = { malformed_despite_complete_generation: 5, [EXPECTED_DOMINANT_CAUSE]: 1 };
  fresh.truncatedCaseCeilingDistances = [15];
  const result = classifyControlRun({ identities: matchingIdentities(), fresh, historical: HISTORICAL });
  assert.equal(result.verdict, VERDICTS.CONTROL_BASELINE_ANOMALY);
  assert.ok(result.failedChecks.includes('dominant_failure_class'));
});

test('truncation-labelled cases that did not reach the ceiling are an anomaly', () => {
  const fresh = healthyRun(6);
  // Well clear of the ceiling: the label no longer matches the mechanism.
  fresh.truncatedCaseCeilingDistances = [15, 15, 15, 15, 15, 900];
  const result = classifyControlRun({ identities: matchingIdentities(), fresh, historical: HISTORICAL });
  assert.equal(result.verdict, VERDICTS.CONTROL_BASELINE_ANOMALY);
  assert.ok(result.failedChecks.includes('ceiling_mechanism'));
});

test('wholly unattributable invalid output is an anomaly', () => {
  const fresh = healthyRun(0);
  fresh.invalidCount = 6;
  fresh.invalidOutputCauseCounts = { unclassified: 6 };
  const result = classifyControlRun({ identities: matchingIdentities(), fresh, historical: HISTORICAL });
  assert.equal(result.verdict, VERDICTS.CONTROL_BASELINE_ANOMALY);
  assert.ok(result.failedChecks.includes('provider_attribution'));
});

test('a zero-invalid run is clean, not unattributable', () => {
  const result = classifyControlRun({
    identities: matchingIdentities(), fresh: healthyRun(0), historical: HISTORICAL,
  });
  assert.equal(result.verdict, VERDICTS.EXPECTED_STOCHASTIC_VARIATION);
  assert.ok(!result.failedChecks.includes('provider_attribution'));
});

test('capture that disagrees with itself is an anomaly', () => {
  const short = healthyRun(6); short.completedCount = 31;
  assert.equal(
    classifyControlRun({ identities: matchingIdentities(), fresh: short, historical: HISTORICAL }).verdict,
    VERDICTS.CONTROL_BASELINE_ANOMALY,
  );

  const mismatched = healthyRun(6);
  mismatched.invalidOutputCauseCounts = { [EXPECTED_DOMINANT_CAUSE]: 4 };
  mismatched.truncatedCaseCeilingDistances = [15, 15, 15, 15];
  assert.equal(
    classifyControlRun({ identities: matchingIdentities(), fresh: mismatched, historical: HISTORICAL }).verdict,
    VERDICTS.CONTROL_BASELINE_ANOMALY,
  );

  const badLedger = healthyRun(6); badLedger.accountingConsistent = false;
  assert.equal(
    classifyControlRun({ identities: matchingIdentities(), fresh: badLedger, historical: HISTORICAL }).verdict,
    VERDICTS.CONTROL_BASELINE_ANOMALY,
  );
});

test('the classification runs without any historical comparison at all', () => {
  // The fresh run is the baseline. It must be classifiable on its own evidence.
  const result = classifyControlRun({ identities: matchingIdentities(), fresh: healthyRun(9) });
  assert.equal(result.verdict, VERDICTS.EXPECTED_STOCHASTIC_VARIATION);
  assert.equal(result.reportOnly.invalidRateDeltaPp, null);
});

test('anomaly detection was not removed: every named failure mode is still caught', () => {
  // Guards the clarification against being read as "stop flagging things".
  const modes = ['execution_identity', 'capture_consistency', 'provider_attribution',
    'dominant_failure_class', 'ceiling_mechanism'];
  const covered = new Set();
  const cases = [
    { identities: matchingIdentities({ model: { expected: 'a', observed: 'b' } }), fresh: healthyRun(6) },
    { identities: matchingIdentities(), fresh: { ...healthyRun(6), completedCount: 30 } },
    { identities: matchingIdentities(), fresh: { ...healthyRun(0), invalidCount: 3, invalidOutputCauseCounts: { unclassified: 3 } } },
    { identities: matchingIdentities(), fresh: { ...healthyRun(6), invalidOutputCauseCounts: { provider_safety_block: 6 }, truncatedCaseCeilingDistances: [] } },
    { identities: matchingIdentities(), fresh: { ...healthyRun(6), truncatedCaseCeilingDistances: [15, 15, 15, 15, 15, 999] } },
  ];
  for (const input of cases) {
    const result = classifyControlRun(input);
    assert.equal(result.verdict, VERDICTS.CONTROL_BASELINE_ANOMALY);
    result.failedChecks.forEach((c) => covered.add(c));
  }
  for (const mode of modes) assert.ok(covered.has(mode), `${mode} must still be detectable`);
});
