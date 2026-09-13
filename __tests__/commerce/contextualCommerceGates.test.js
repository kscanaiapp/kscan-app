/**
 * Contextual Commerce — the two engineering gates, run as tests (§17, §21).
 *
 * Both harnesses are deterministic and offline, so they belong in the suite
 * rather than in someone's terminal history: a future change that degrades
 * fashion match or blows the latency budget fails here.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fmq = require('../../tools/contextual-commerce/fmqGate');
const measure = require('../../tools/contextual-commerce/measure');

// ── §17 FMQ control / challenger ───────────────────────────────────────────

test('FMQ gate: contextual ranking causes no material fashion-match regression', () => {
  const report = fmq.run();
  assert.equal(report.verdict, 'NO_MATERIAL_REGRESSION', report.regressions.join('; '));
  assert.deepEqual(report.regressions, []);
});

test('FMQ gate: the challenger arms genuinely perturbed the ranking', () => {
  // A gate that silently no-ops proves nothing. Each arm must be shown to have
  // actually moved scores before its "no regression" verdict means anything.
  const report = fmq.run();
  assert.ok(report.fixtures >= 10, 'the authoritative corpus must be non-trivial');
  assert.equal(report.fixturesWhereContextApplied, report.fixtures, 'context must have been live on every fixture');
  assert.ok(report.reorderingArm.perturbation.maxAbsScoreShift >= 20, 'the reordering arm must push hard');
  assert.equal(
    report.reorderingArm.perturbation.fixturesWithScoreChange,
    report.reorderingArm.fixtures,
    'every fixture in the reordering arm must have moved',
  );
});

test('FMQ gate: identity and substitute quality are measured on the same universes', () => {
  const report = fmq.run();
  const total = (dist) => Object.values(dist).reduce((a, b) => a + b, 0);
  assert.equal(total(report.control.identityQuality), report.fixtures);
  assert.equal(total(report.challenger.identityQuality), report.fixtures);
  assert.equal(total(report.control.substituteQuality), report.fixtures);
  assert.equal(total(report.challenger.substituteQuality), report.fixtures);
});

test('FMQ gate: the report claims no statistical certainty the corpus cannot support', () => {
  const report = fmq.run();
  assert.equal(report.corpusTier, 'SYNTHETIC');
  assert.match(report.statisticalClaim, /NONE/);
  assert.equal(report.benchmarkStatus, 'INTERNAL ENGINEERING EVIDENCE ONLY');
  assert.ok(report.corpusLimitations.length >= 2, 'the corpus limits must be stated, not hidden');
});

// ── §21 performance ────────────────────────────────────────────────────────

test('performance: added local processing stays within the 50ms build target', () => {
  const { performance } = measure.run();
  assert.ok(
    performance.TOTAL_INCREMENTAL_MS <= performance.TARGET_MS,
    `incremental ${performance.TOTAL_INCREMENTAL_MS}ms exceeds the ${performance.TARGET_MS}ms target`,
  );
  assert.equal(performance.WITHIN_TARGET, true);
});

test('performance: the zero-context path pays essentially nothing', () => {
  const { performance } = measure.run();
  // The gate is a bound, not an equality: this is wall-clock on a shared
  // runner, so a small positive or negative delta is measurement noise. What
  // must not happen is a cold request paying a contextual cost.
  assert.ok(
    performance.ZERO_CONTEXT_OVERHEAD_MS < 5,
    `zero-context overhead ${performance.ZERO_CONTEXT_OVERHEAD_MS}ms must stay near zero`,
  );
});

// ── §9 retailer neutrality, measured ───────────────────────────────────────

test('retailer distribution does not concentrate after contextual ranking', () => {
  const { retailerDistribution } = measure.run();
  assert.equal(
    retailerDistribution.AFTER_RETAILER_COUNT >= retailerDistribution.BEFORE_RETAILER_COUNT,
    true,
    'contextual ranking must not collapse the shelf onto fewer retailers',
  );

  // No single retailer may take a materially larger share of the surviving
  // shelf than it had before.
  const before = retailerDistribution.BEFORE_CONTEXTUAL_RANKING;
  const after = retailerDistribution.AFTER_CONTEXTUAL_RANKING;
  const share = (dist) => {
    const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, v / total]));
  };
  const beforeShare = share(before);
  const afterShare = share(after);
  for (const retailer of Object.keys(afterShare)) {
    const shift = afterShare[retailer] - (beforeShare[retailer] ?? 0);
    assert.ok(shift <= 0.25, `${retailer} gained ${(shift * 100).toFixed(1)}% share — investigate before shipping`);
  }
});

test('the FMQ gate report is reproducible', () => {
  const a = fmq.run();
  const b = fmq.run();
  assert.deepEqual(a.control, b.control);
  assert.deepEqual(a.challenger, b.challenger);
  assert.equal(a.verdict, b.verdict);
});
