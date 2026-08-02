'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const build4Funnel = require('../lib/build4Funnel');
const pairedStatistics = require('../lib/pairedStatistics');
const preflight = require('../lib/preflightReservation');
const runnerState = require('../lib/runnerState');
const suppressionMetrics = require('../lib/suppressionMetrics');

const pricing = require('../../../evals/scanner-accuracy/pricing/gemini-pricing.2026-08-02.json');

test('thinking-inclusive Gemini billing refuses an unobservable output count', () => {
  assert.deepEqual(preflight.deriveBillableOutputUsage({
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 30,
    totalTokenCount: 155,
  }), {
    ok: true,
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 30,
    totalTokenCount: 155,
    billableOutputTokens: 55,
    basis: 'max_candidates_plus_thoughts_or_total_minus_prompt',
  });
  assert.equal(preflight.deriveBillableOutputUsage({ promptTokenCount: 100, totalTokenCount: 130 }).billableOutputTokens, 30);
  assert.equal(preflight.deriveBillableOutputUsage({ promptTokenCount: 100, candidatesTokenCount: 20 }).ok, false);
  assert.equal(preflight.deriveBillableOutputUsage({ promptTokenCount: 100, totalTokenCount: 90 }).ok, false);
});

test('historical aggregate cost is recomputed with total minus prompt and candidate exceeds the run ceiling', () => {
  const cost = (prompt, total) =>
    prompt / 1e6 * pricing.models['gemini-3.6-flash'].inputPerMillionUsd
    + (total - prompt) / 1e6 * pricing.models['gemini-3.6-flash'].outputPerMillionUsd;
  const control = cost(56028, 106365);
  const candidate = cost(89094, 147250);
  assert.equal(control, 0.4615695);
  assert.ok(Math.abs(candidate - 0.569811) < 1e-12);
  assert.ok(candidate > 0.5);
});

test('reservation replay is deterministic and missing thinking metadata remains conservatively reserved', () => {
  const run = (attempts) => {
    const ledger = new preflight.ReservationLedger({ pricing, spendCeilingUsd: 1, attemptCeiling: 2 });
    assert.equal(ledger.reserveCase({
      caseId: 'case-1', primaryModel: 'gemini-3.6-flash', fallbackModel: 'gemini-3.5-flash-lite',
      primaryInputTokens: 100, fallbackInputTokens: 90,
    }).authorized, true);
    build4Funnel.reconcileReservations(ledger, 'case-1', attempts);
    return ledger.totals();
  };
  const attempts = [{ promptTokenCount: 100, candidatesTokenCount: 4, thoughtsTokenCount: 6, totalTokenCount: 110 }];
  assert.deepEqual(run(attempts), run(attempts));
  const unresolved = run([{ promptTokenCount: 100, candidatesTokenCount: 4 }]);
  assert.equal(unresolved.primaryReservationsRetainedUnknown, 1);
  assert.ok(unresolved.conservativeUnresolvedUsd > 0);
});

test('raw model text is append-only, private, and stripped from normalized reports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-raw-'));
  try {
    const rawModelText = 'PRIVATE_RAW_MARKER';
    const report = {
      observed: { resultType: 'non_fashion' },
      privateRawProviderOutputs: [{
        role: 'primary', rawModelText,
        rawModelTextSha256: crypto.createHash('sha256').update(rawModelText).digest('hex'),
      }],
    };
    const sanitized = build4Funnel.persistPrivateRawOutputs({
      outputRoot: root, caseId: 'case-1', runIdentityRecord: { runId: 'run-1', candidateVersion: 'certified-v140' }, report,
    });
    assert.equal(JSON.stringify(sanitized).includes(rawModelText), false);
    assert.equal(runnerState.readRawProviderOutput(root, 'case-1').attempts[0].rawModelText, rawModelText);
    assert.throws(() => build4Funnel.persistPrivateRawOutputs({
      outputRoot: root, caseId: 'case-1', runIdentityRecord: { runId: 'run-1', candidateVersion: 'certified-v140' }, report,
    }), /already exists/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('suppression cannot hide a candidate regression behind answered-only accuracy', () => {
  const labels = new Map([['case-1', Object.fromEntries(suppressionMetrics.FIELDS.map((field) => [field, 'known']))]]);
  const fieldScores = suppressionMetrics.FIELDS.map((field) => ({ field, disposition: 'correct' }));
  const control = [{ caseId: 'case-1', projection: Object.fromEntries(suppressionMetrics.FIELDS.map((field) => [field, 'known'])), profiles: { trust_weighted: { fields: fieldScores } } }];
  const candidateProjection = Object.fromEntries(suppressionMetrics.FIELDS.map((field) => [field, null]));
  candidateProjection.category = 'known';
  const candidate = [{ caseId: 'case-1', projection: candidateProjection, profiles: { trust_weighted: { fields: fieldScores } } }];
  const a = suppressionMetrics.summarizeSuppression(control, labels);
  const b = suppressionMetrics.summarizeSuppression(candidate, labels);
  assert.equal(a.accuracyAcrossAllClassifiable, 1);
  assert.equal(b.accuracyAmongAnsweredClassifiable, 1);
  assert.equal(b.accuracyAcrossAllClassifiable, 1 / 7);
  assert.equal(b.suppressionRateOnClassifiable, 6 / 7);
});

test('paired statistics are exact or fixed-seed and explicitly pilot-labelled', () => {
  const control = [true, true, true, false, false];
  const candidate = [true, false, false, true, false];
  const report = pairedStatistics.pairedBinaryReport(control, candidate);
  assert.match(report.evidenceLabel, /^PILOT EVIDENCE/);
  assert.deepEqual(report.mcnemar, {
    bothCorrect: 1, bothWrong: 1, controlOnly: 2, candidateOnly: 1, discordant: 3, twoSidedExactPValue: 1,
  });
  const first = pairedStatistics.pairedBootstrapMeanDelta([1, 2, 3], [2, 2, 5], { seed: 7, iterations: 200 });
  assert.deepEqual(first, pairedStatistics.pairedBootstrapMeanDelta([1, 2, 3], [2, 2, 5], { seed: 7, iterations: 200 }));
});

test('scoring and statistics dependency surface contains no network or LLM client', () => {
  for (const relative of ['scoreFields.js', 'suppressionMetrics.js', 'pairedStatistics.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', relative), 'utf8');
    assert.doesNotMatch(source, /\b(?:fetch|https?|net|child_process)\s*(?:\(|=)|OpenAI|Anthropic|Gemini|generativelanguage/i);
  }
});
