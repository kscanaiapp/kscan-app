import assert from 'node:assert/strict';
import { aggregateTelemetry, CI_V2_TELEMETRY_KEYS, estimateCostUsd, parseTelemetryLines, pricingStatus, validateTelemetryRecord } from './telemetry.ts';
import { buildGateReport, estimateG9, GATES, type GovernedRun, measureG1, measureG3, measureG6, measureG7, measureG8, measureG12, renderGateReportMarkdown } from './gateReport.ts';
import {
  buildServerMerchantRegistry,
  corporateFlagTelemetry,
  corporateTelemetry,
  finalizeCorporateStyleChatText,
  prepareCorporateStyleChatTurn,
} from '../../../stylechat-generate/corporateIntelligenceV2.ts';

const NOW = new Date('2026-11-04T00:00:00Z');

function realRecord(text = 'Pair the coat with charcoal trousers.') {
  const prepared = prepareCorporateStyleChatTurn({ correlationId: 'corr-ci06-0001', locale: 'en', stylistDisplayName: 'Elise', route: 'stylechat', adviceIntentResolved: false, legacySystemText: 'L', now: NOW });
  const finalized = finalizeCorporateStyleChatText({ prepared, origin: 'primary_initial', displayedText: text, providerFailure: false, registry: buildServerMerchantRegistry({}), now: NOW });
  return corporateTelemetry({
    flag: { enabled: true, reason: 'on' }, prepared, finalized, registrySource: 'store', passes: 1, elapsedMs: 4,
    usage: { attempts: 1, promptTokens: 2000, outputTokens: 150, thoughtsTokens: 50, unreported: 0 }, model: 'gemini-3.6-flash', providerRetries: 0,
  });
}

Deno.test('CI-06 schema: the real runtime record passes; it carries only closed metadata keys', () => {
  const rec = realRecord();
  assert.deepEqual(validateTelemetryRecord(rec), { ok: true });
  assert.deepEqual(Object.keys(rec).sort(), [...CI_V2_TELEMETRY_KEYS].sort());
  assert.deepEqual(validateTelemetryRecord(corporateFlagTelemetry({ enabled: false, reason: 'kill_switch' }), 'flag'), { ok: true });
});

Deno.test('CI-06 schema: free text, unknown keys, ids or negative numbers are rejected (privacy guard)', () => {
  const base = realRecord();
  for (const bad of [
    { ...base, message: 'hi' },
    { ...base, taskVerb: 'Pair the navy blazer with cream trousers' },
    { ...base, model: 'user 00000000-0000' },
    { ...base, elapsedMs: -1 },
    { ...base, prepared: { nested: true } },
  ]) assert.equal(validateTelemetryRecord(bad).ok, false, JSON.stringify(bad).slice(0, 80));
});

Deno.test('CI-06 aggregation: outcomes, failure categories, latency, tokens, cost and rollback evidence', () => {
  const ok = realRecord();
  const rejected = realRecord('Maison Obscura is a verified Black-owned business.');
  const lines = [
    `[stylechat-generate] ci_v2 %s ${JSON.stringify(ok)}`,
    `[stylechat-generate] ci_v2 %s ${JSON.stringify(rejected)}`,
    `[stylechat-generate] ci_v2 %s ${JSON.stringify({ ...ok, taskVerb: 'free text with spaces' })}`,
    `[stylechat-generate] ci_v2_flag %s ${JSON.stringify(corporateFlagTelemetry({ enabled: false, reason: 'kill_switch' }))}`,
    '[stylechat-generate] ok uid=abc unrelated line',
  ];
  const agg = aggregateTelemetry(parseTelemetryLines(lines), NOW);
  assert.equal(agg.records, 2);
  assert.equal(agg.rejectedRecords, 1, 'a record with free text is excluded, not aggregated');
  assert.deepEqual(agg.flagStates, { kill_switch: 1 });
  assert.equal(agg.validator.accept, 1);
  assert.equal(agg.validator.reject, 1);
  assert.ok(Object.keys(agg.failureCategories).length >= 1);
  assert.equal(agg.tokens.prompt, 4000);
  const each = estimateCostUsd('gemini-3.6-flash', 2000, 150, 50)!;
  assert.ok(Math.abs(agg.costUsd.mean! - each) < 1e-12);
  assert.equal(agg.costUsd.basis, 'estimate_from_dated_pricing');
  assert.equal(pricingStatus(NOW), 'stale', 'the 2026-07-29 record is older than 90 days on 2026-11-04 and is reported as such');
  assert.equal(estimateCostUsd('unpriced-model', 1, 1, 0), null);
});

const green = (files: string[]): GovernedRun[] => files.map((file) => ({ file, passed: 10, failed: 0 }));
const ALL = ['acceptanceFixtures.test.ts', 'contractHardening.test.ts', 'outputValidation.test.ts', 'boundaries.test.ts', 'corporateIntelligenceV2.handler.test.ts'];

Deno.test('CI-06 report: offline measurements meet their proposed thresholds; unmeasurable gates are never PASS', async () => {
  const index = await Deno.readTextFile(new URL('../../../stylechat-generate/index.ts', import.meta.url));
  const evidence = { g1: measureG1(), g3: measureG3(), g6: measureG6(index), g7: measureG7(), g8: measureG8(200), g9: estimateG9(4000), g12: measureG12(), governed: green(ALL) };
  assert.ok(evidence.g1.variants >= 500);
  assert.equal(evidence.g1.falseAccepts, 0);
  assert.equal(evidence.g3.changedByInjectedFields, 0);
  assert.deepEqual(evidence.g6, { callGeminiSites: 3, sharedSystemTextBodies: 2, fallbackModelWired: false, finalizerAtPersistence: true, finalizerOnDisplayedText: true, deterministicReturnsThroughFinalizer: 3 });
  const report = buildGateReport(evidence);
  const by = Object.fromEntries(report.map((r) => [r.id, r.status]));
  for (const id of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G11', 'G12']) assert.equal(by[id], 'PASS', id);
  assert.equal(by.G10, 'BLOCKED');
  assert.equal(by.G9, 'NOT TESTED');
  assert.ok(by.G8 === 'NOT TESTED' || by.G8 === 'FAIL', 'G8 end-to-end needs live runs, so it is never PASS offline');
  assert.ok(['PASS', 'FAIL'].includes(by.G7));
  // Governed-test evidence is required: without it, PASS degrades to NOT TESTED; a failing suite is FAIL.
  const none = Object.fromEntries(buildGateReport({ ...evidence, governed: [] }).map((r) => [r.id, r.status]));
  assert.equal(none.G2, 'NOT TESTED');
  assert.equal(none.G5, 'NOT TESTED');
  const failing = Object.fromEntries(buildGateReport({ ...evidence, governed: [...green(ALL.filter((f) => f !== 'boundaries.test.ts')), { file: 'boundaries.test.ts', passed: 9, failed: 1 }] }).map((r) => [r.id, r.status]));
  assert.equal(failing.G4, 'FAIL');
  assert.equal(failing.G12, 'FAIL');
  const md = renderGateReportMarkdown(report, { commit: 'test', generatedAt: '2026-11-04' });
  assert.ok(md.includes('| G10 |') && md.includes('**BLOCKED**'));
});

Deno.test('CI-06 thresholds: every number in a gate threshold appears in the contract document row (no silent relaxation)', async () => {
  const doc = await Deno.readTextFile(new URL('../../../../../docs/build36/corporate-intelligence-v2/CI-V2-PHASE1-CONTRACTS.md', import.meta.url));
  for (const g of GATES) {
    const row = doc.split(/\r?\n/).find((l) => l.startsWith(`| ${g.id} |`));
    assert.ok(row, `${g.id} row missing in the contract doc`);
    const cell = row!.split('|')[3];
    for (const n of g.threshold.match(/\d[\d,.]*/g) ?? []) {
      const plain = n.replace(/[.,]$/, '');
      assert.ok(cell.includes(plain), `${g.id}: threshold number ${plain} not in contract row`);
    }
  }
});
