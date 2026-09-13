/**
 * Activation engineering gates run as tests (brief §30, §32, §37, §41).
 *
 * Deterministic and offline, so a future change that degrades fashion quality,
 * moves the cold path, or blows the local cost budget fails here rather than
 * in someone's terminal history.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const seamProbes = require(path.join(ROOT, 'tools/activation/seamProbes.js'));
const fmq = require(path.join(ROOT, 'tools/activation/fmqActivationGate.js'));
const perf = require(path.join(ROOT, 'tools/activation/activationPerf.js'));

// ── §4/§5 seam probes ──────────────────────────────────────────────────────

test('SEAM_PROBES_COMPLETE: every declared seam is probed and classified', () => {
  const report = seamProbes.run();
  const names = report.seams.map((s) => s.seam);
  for (const required of ['A_', 'B_', 'C_', 'D_', 'E_', 'FGH_', 'I_']) {
    assert.ok(names.some((n) => n.startsWith(required)), `seam ${required} missing`);
  }
  for (const seam of report.seams) {
    assert.ok(seam.classification, `${seam.seam} unclassified`);
    assert.equal(seam.probeError, undefined, `${seam.seam} probe threw: ${seam.probeError}`);
    assert.ok(seam.aSide?.file, `${seam.seam} has no A-side anchor`);
    assert.ok(seam.bSide?.file, `${seam.seam} has no B-side anchor`);
    assert.ok(seam.failureBehavior, `${seam.seam} records no failure behaviour`);
  }
});

test('no seam regressed to MISSING or INCOMPATIBLE', () => {
  const report = seamProbes.run();
  for (const seam of report.seams) {
    assert.equal(['MISSING', 'INCOMPATIBLE'].includes(seam.classification), false, `${seam.seam}: ${seam.classification}`);
  }
});

// ── §32 FMQ context-off / context-on ───────────────────────────────────────

test('FMQ: attaching live context causes no material fashion-match regression', () => {
  const report = fmq.run();
  assert.equal(report.verdict, 'NO_MATERIAL_REGRESSION', report.regressions.join('; '));
  assert.deepEqual(report.regressions, []);
});

test('FMQ: the context-on arm genuinely moved the ranking', () => {
  // A gate that silently no-ops proves nothing.
  const report = fmq.run();
  assert.ok(report.fixtures >= 10);
  assert.ok(report.perturbation.fixturesWithScoreChange >= 8, 'live context must actually reach the ranker');
  assert.ok(report.perturbation.maxAbsScoreShift > 0);
});

test('FMQ: the report claims no certainty the corpus cannot support', () => {
  const report = fmq.run();
  assert.equal(report.corpusTier, 'SYNTHETIC');
  assert.match(report.statisticalClaim, /NONE/);
  assert.equal(report.benchmarkStatus, 'INTERNAL ENGINEERING EVIDENCE ONLY');
});

// ── §37 performance ────────────────────────────────────────────────────────

test('PERF: local activation overhead stays small', () => {
  const p = perf.run();
  // Local assembly only; provider latency is explicitly excluded and labelled.
  assert.ok(p.LOCAL_ACTIVATION_OVERHEAD_MS < 50, `local overhead ${p.LOCAL_ACTIVATION_OVERHEAD_MS}ms`);
  assert.ok(p.ELISE_CONTEXT_ASSEMBLY_MS < 50);
  assert.equal(p.MAX_CLOSET_CONTEXT_ITEMS, 6);
});

test('PERF: the model and provider budgets are unchanged', () => {
  const p = perf.run();
  assert.equal(p.MODEL_TURNS_PER_COMMERCE_ELISE_TURN, p.MODEL_TURNS_PER_NORMAL_ELISE_TURN);
  assert.equal(p.TOOL_TURNS_ADDED, 0);
  assert.equal(p.COMMERCE_SIDE_LLM_CALLS_ADDED, 0);
  assert.equal(p.COMMERCE_PROVIDER_CALLS_PER_JOURNEY, 1);
});

test('PERF: latency claims that need a device are not made', () => {
  const p = perf.run();
  assert.match(String(p.LATENCY_TO_SHELF_MS), /NOT MEASURED/);
  assert.match(String(p.FIRST_TEXT_MS_COMMERCE_TURN), /UNCHANGED/);
});
