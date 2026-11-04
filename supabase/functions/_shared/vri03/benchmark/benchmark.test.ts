import { assert, assertAlmostEquals, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  BudgetExceededError,
  costFromUsage,
  createBudgetGuard,
  VRI03_GEMINI_CEILING_USD,
  VRI03_PRICING,
} from './budgetGuard.ts';
import { evaluateManifestGate, VRI03_MIN_ITEMS } from './manifestGate.ts';
import { auditFabrication, computeArmMetrics, decideKeep, type ItemRun, p95 } from './metrics.ts';
import { preflight, type PreflightInput } from './preflight.ts';

const MODEL = 'gemini-3.6-flash';
const ctx = { itemId: 'vri03-0001', arm: 'baseline' };

// ── Budget guard ─────────────────────────────────────────────────────────────

Deno.test('budget: ceiling cannot be raised above the approved $20', () => {
  assertThrows(() => createBudgetGuard({ ceilingUsd: 20.01 }));
  assertThrows(() => createBudgetGuard({ ceilingUsd: 0 }));
  assertEquals(createBudgetGuard().ceilingUsd, VRI03_GEMINI_CEILING_USD);
});

Deno.test('budget: settles actual cost from usageMetadata, thinking billed as output', () => {
  const g = createBudgetGuard();
  const r = g.reserveGeminiAttempt(MODEL, ctx);
  const e = g.settleGeminiAttempt(r, { promptTokenCount: 2500, candidatesTokenCount: 400, thoughtsTokenCount: 100 });
  assertEquals(e.costSource, 'usage_metadata');
  assertEquals(e.outputTokens, 500);
  assertAlmostEquals(e.costUsd, (2500 * 1.5 + 500 * 7.5) / 1e6, 1e-12);
  assertAlmostEquals(g.summary().spentUsd, e.costUsd, 1e-12);
});

Deno.test('budget: missing or malformed usage is charged worst case, never free', () => {
  const g = createBudgetGuard();
  for (const usage of [null, undefined, {}, { promptTokenCount: -1, candidatesTokenCount: 3 }, { promptTokenCount: '10', candidatesTokenCount: 3 }]) {
    const r = g.reserveGeminiAttempt(MODEL, ctx);
    const e = g.settleGeminiAttempt(r, usage as never);
    assertEquals(e.costSource, 'worst_case_no_usage');
    assertAlmostEquals(e.costUsd, r.worstCaseUsd, 1e-12);
  }
  assertEquals(g.summary().geminiCallsChargedWorstCase, 5);
});

Deno.test('budget: aborts BEFORE a reservation that would cross the ceiling', () => {
  const g = createBudgetGuard({ ceilingUsd: 0.05 });
  const worst = g.worstCaseCallUsd(MODEL);
  const fits = Math.floor(0.05 / worst);
  const held = [];
  for (let i = 0; i < fits; i++) held.push(g.reserveGeminiAttempt(MODEL, ctx));
  assertThrows(() => g.reserveGeminiAttempt(MODEL, ctx), BudgetExceededError);
  // Releasing an unsent reservation frees its bound.
  g.releaseReservation(held.pop()!);
  g.reserveGeminiAttempt(MODEL, ctx);
});

Deno.test('budget: prior ledger carries spend across runs (ceiling is global)', () => {
  const first = createBudgetGuard();
  for (let i = 0; i < 3; i++) first.settleGeminiAttempt(first.reserveGeminiAttempt(MODEL, ctx), { promptTokenCount: 1e6, candidatesTokenCount: 0 });
  const second = createBudgetGuard({ priorLedger: first.ledger() });
  assertAlmostEquals(second.summary().spentUsd, 4.5, 1e-9);
  assertAlmostEquals(second.remainingUsd(), 15.5, 1e-9);
});

Deno.test('budget: counted input tokens tighten the bound; unknown model refused', () => {
  const g = createBudgetGuard();
  assert(g.worstCaseCallUsd(MODEL, 2600) < g.worstCaseCallUsd(MODEL));
  assertThrows(() => g.reserveGeminiAttempt('gemini-unpriced', ctx));
});

Deno.test('budget: provider calls are counted exactly; cost stays INSUFFICIENT_EVIDENCE', () => {
  const g = createBudgetGuard();
  g.recordProviderCall('serper', ctx);
  g.recordProviderCall('serper', ctx);
  g.recordProviderCall('poshmark', ctx);
  const s = g.summary();
  assertEquals(s.providerCalls, { serper: 2, poshmark: 1 });
  assertEquals(s.providerCostStatus, 'INSUFFICIENT_EVIDENCE');
  assertEquals(s.spentUsd, 0);
  assert(s.pricingProvenance.includes('2026-07-29'));
});

Deno.test('budget: pricing record matches the dated source figures', () => {
  assertEquals(VRI03_PRICING.models[MODEL], { inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 });
  assertAlmostEquals(costFromUsage(VRI03_PRICING.models[MODEL], 1e6, 1e6), 9, 1e-12);
});

// ── Manifest gate ────────────────────────────────────────────────────────────

function item(n: number, over: Record<string, unknown> = {}) {
  const scene = n % 2 ? 'single_object' : 'multi_object';
  return {
    itemId: `vri03-${String(n).padStart(4, '0')}`,
    imageDigest: `sha256:${n.toString(16).padStart(64, '0')}`,
    consent: { policyId: 'image-consent-v1', evidenceId: `consent-${n}`, consentedAt: '2026-11-01' },
    strata: { scene, type: n % 3 ? 'garment' : 'accessory', brandVisible: false, blackOwnedRelevance: 'unknown' },
    ...(scene === 'multi_object' ? { targetDescription: 'the jacket, upper half' } : {}),
    googleEvidence: { retailerDomain: 'retailer.example', productTitle: 'Synthetic Product', capturedAt: '2026-11-01', market: 'US', purchasable: true },
    groundTruth: { category: 'outerwear', subtype: 'moto jacket', reviewers: 2 },
    ...over,
  };
}
const manifestOf = (items: unknown[]) => ({ setId: 'vri-03-failure-set', version: '0.1.0', items });

Deno.test('gate: empty manifest (the committed template state) fails with an explicit count', () => {
  const r = evaluateManifestGate(manifestOf([]));
  assertEquals(r.pass, false);
  assert(r.issues.some((i) => i.problem.includes(`need ≥${VRI03_MIN_ITEMS} valid items, have 0`)));
});

Deno.test('gate: 16 consented, double-labeled items pass and report underpowered strata', () => {
  const r = evaluateManifestGate(manifestOf(Array.from({ length: 16 }, (_, i) => item(i + 1))));
  assertEquals(r.issues, []);
  assertEquals(r.pass, true);
  assertEquals(r.strata.scene, { single_object: 8, multi_object: 8 });
  assert(r.strata.underpowered.includes('accessory'));
});

Deno.test('gate: ground truth is never inferred — missing Google evidence or one reviewer rejects the item', () => {
  const items = Array.from({ length: 16 }, (_, i) => item(i + 1));
  items[0] = item(1, { googleEvidence: undefined });
  items[1] = item(2, { groundTruth: { category: 'top', subtype: 'tee', reviewers: 1 } });
  items[2] = item(3, { googleEvidence: { ...item(3).googleEvidence, purchasable: false } });
  const r = evaluateManifestGate(manifestOf(items));
  assertEquals(r.validItemCount, 13);
  assertEquals(r.pass, false);
});

Deno.test('gate: identifiers anywhere fail the gate', () => {
  const base = Array.from({ length: 16 }, (_, i) => item(i + 1));
  const cases: Record<string, unknown>[] = [
    { userId: 'abc' },
    { exif: { gps: 1 } },
    { notes: 'contact jane@example.com' },
    { notes: 'C:\\Users\\someone\\scan.jpg' },
    { notes: 'https://x.example/img?X-Amz-Signature=abc' },
  ];
  for (const extra of cases) {
    const items = [...base];
    items[4] = { ...item(5), ...extra };
    assertEquals(evaluateManifestGate(manifestOf(items)).pass, false, JSON.stringify(extra));
  }
});

Deno.test('gate: multi-object items must name the target; duplicates rejected', () => {
  const items = Array.from({ length: 16 }, (_, i) => item(i + 1));
  const { targetDescription: _drop, ...noTarget } = item(2) as Record<string, unknown>;
  items[1] = noTarget as never;
  items[15] = { ...item(16), imageDigest: item(1).imageDigest };
  const r = evaluateManifestGate(manifestOf(items));
  assert(r.issues.some((i) => i.path.endsWith('targetDescription')));
  assert(r.issues.some((i) => i.problem === 'duplicate image'));
});

Deno.test('gate: the committed manifest template is identifier-free and fails only on count', async () => {
  const raw = await Deno.readTextFile(new URL('../../../../../docs/vri-03/collection-kit/failure-set.manifest.template.json', import.meta.url));
  const r = evaluateManifestGate({ ...JSON.parse(raw), items: [] });
  assert(r.issues.every((i) => i.path === '$.items' || i.path.startsWith('$.strata')), JSON.stringify(r.issues));
});

// ── Metrics ──────────────────────────────────────────────────────────────────

function run(id: number, o: Partial<ItemRun> = {}): ItemRun {
  return {
    itemId: `vri03-${String(id).padStart(4, '0')}`,
    strata: { scene: id % 2 ? 'single_object' : 'multi_object', type: id % 3 ? 'garment' : 'accessory' },
    identification: { categoryCorrect: true, itemCorrect: true, targetSelectedCorrect: id % 2 ? null : true },
    candidates: [], shown: [], recordedPoolUrls: [], eligibleOwnershipRowIds: [],
    scanToResultsMs: 1000 + id * 10, geminiCostUsd: 0.008, costFromWorstCase: false, providerCalls: 2,
    ...o,
  };
}
const hit = (url: string, label: ItemRun['shown'][number]['label']) => ({ canonicalUrl: url, merchant: 'm', label });

Deno.test('metrics: p95 nearest-rank', () => {
  assertEquals(p95([]), null);
  assertEquals(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
  assertEquals(p95([5]), 5);
});

Deno.test('metrics: recall separates acceptable from exact, candidates from shown', () => {
  const items = [
    run(1, { candidates: [hit('u1', 'exact_match')], shown: [hit('u1', 'exact_match')], recordedPoolUrls: ['u1'] }),
    run(2, { candidates: [hit('u2', 'visually_similar_acceptable')], shown: [], recordedPoolUrls: ['u2'] }),
    run(3, { candidates: [hit('u3', 'wrong_category')], shown: [hit('u3', 'wrong_category')], recordedPoolUrls: ['u3'] }),
    run(4),
  ];
  const m = computeArmMetrics('baseline', items);
  assertEquals(m.recall.candidateAcceptable, 0.5);
  assertEquals(m.recall.candidateExact, 0.25);
  assertEquals(m.recall.shownAcceptable, 0.25);
  assertEquals(m.recall.shownExact, 0.25);
  assertEquals(m.latency.status, 'MEASURED');
  assertEquals(m.cost.status, 'MEASURED');
  assertEquals(m.cost.providerCostStatus, 'INSUFFICIENT_EVIDENCE');
});

Deno.test('metrics: fabrication audit catches unsourced results and ineligible ownership labels', () => {
  const a = auditFabrication([
    run(1, { shown: [hit('u1', 'exact_match'), hit('ghost', 'exact_match')], recordedPoolUrls: ['u1'] }),
    run(2, { shown: [{ ...hit('u2', 'visually_similar_acceptable'), ownershipRowId: 'row-x' }], recordedPoolUrls: ['u2'], eligibleOwnershipRowIds: ['row-y'] }),
  ]);
  assertEquals(a.unsourcedShown, 1);
  assertEquals(a.ineligibleOwnershipLabels, 1);
  assertEquals(a.pass, false);
});

Deno.test('metrics: worst-case-charged cost is not MEASURED', () => {
  const m = computeArmMetrics('x', [run(1, { costFromWorstCase: true })]);
  assertEquals(m.cost.status, 'INSUFFICIENT_EVIDENCE');
});

Deno.test('decision: keep only a recall win with no exact, fabrication, latency or cost regression', () => {
  const pool = ['a', 'b', 'c', 'd'];
  const before = computeArmMetrics('baseline', [1, 2, 3, 4].map((i) => run(i, { recordedPoolUrls: pool, shown: i === 1 ? [hit('a', 'exact_match')] : [] })));
  const better = computeArmMetrics('h3', [1, 2, 3, 4].map((i) => run(i, { recordedPoolUrls: pool, shown: i === 1 ? [hit('a', 'exact_match')] : i === 2 ? [hit('b', 'visually_similar_acceptable')] : [] })));
  assertEquals(decideKeep(before, better).decision, 'KEPT');

  // Similar gain that loses the exact match is reverted.
  const tradeoff = computeArmMetrics('h1', [1, 2, 3, 4].map((i) => run(i, { recordedPoolUrls: pool, shown: i <= 2 ? [hit('b', 'visually_similar_acceptable')] : [] })));
  const d = decideKeep(before, tradeoff);
  assertEquals(d.decision, 'REVERTED');
  assert(d.reasons.includes('exact-match recall regressed'));

  // Latency +10% is reverted.
  const slow = computeArmMetrics('h2', [1, 2, 3, 4].map((i) => run(i, { recordedPoolUrls: pool, scanToResultsMs: 2000, shown: i <= 2 ? [hit('a', 'exact_match')] : [] })));
  assert(decideKeep(before, slow).reasons.some((r) => r.startsWith('latency p95')));

  // Unmeasured cost cannot be kept.
  const unmeasured = computeArmMetrics('h4', [1, 2, 3, 4].map((i) => run(i, { recordedPoolUrls: pool, geminiCostUsd: null, shown: i <= 2 ? [hit('a', 'exact_match')] : [] })));
  assert(decideKeep(before, unmeasured).reasons.includes('Gemini cost unmeasured'));
});

// ── Preflight ────────────────────────────────────────────────────────────────

function pre(over: Partial<PreflightInput['env']> = {}, items = 24, repeats = 3): PreflightInput {
  const gate = evaluateManifestGate(manifestOf(Array.from({ length: items }, (_, i) => item(i + 1))));
  return {
    gate, budget: createBudgetGuard(), model: MODEL, callsPerItem: 2, geminiArms: ['baseline', 'h1', 'h2'], repeats,
    maxAttemptsPerCall: 1, providerQueriesPerItem: 2, providerArms: ['baseline', 'h1', 'h2', 'h3'],
    env: {
      target: 'staging', targetProjectRef: 'staging-ref', forbiddenProjectRefs: ['prod-ref'], geminiKeyPresent: true,
      geminiKeyScope: 'staging', testActorConsentEvidenceId: 'actor-consent-1', imageRootPresent: true,
      spendConfirmedByOwnerInSession: true, ...over,
    },
  };
}

Deno.test('preflight: the current session state is NO-GO with every missing input named', () => {
  const r = preflight(pre({ geminiKeyPresent: false, geminiKeyScope: '', testActorConsentEvidenceId: '', imageRootPresent: false, spendConfirmedByOwnerInSession: false, targetProjectRef: '', forbiddenProjectRefs: [] }, 0));
  assertEquals(r.go, false);
  for (const s of ['failure-set gate', 'Staging-scoped Gemini key', 'test actor', 'image root', 'spend not confirmed', 'forbidden (Production)']) {
    assert(r.blockers.some((b) => b.includes(s)), s);
  }
});

Deno.test('preflight: production ref is refused even with everything else present', () => {
  const r = preflight(pre({ targetProjectRef: 'prod-ref' }));
  assertEquals(r.go, false);
  assert(r.blockers.some((b) => b.includes('forbidden (Production) ref')));
});

Deno.test('preflight: the planned 24-item × 3-arm × 3-repeat run fits the $20 worst case', () => {
  const r = preflight(pre());
  assertEquals(r.plannedGeminiCalls, 24 * 2 * 3 * 3);
  assertEquals(r.plannedProviderCalls, 24 * 2 * 4 * 3);
  assert(r.worstCaseUsd <= 20, String(r.worstCaseUsd));
  assertEquals(r.go, true);
  assertEquals(r.providerCostStatus, 'INSUFFICIENT_EVIDENCE');
});

Deno.test('preflight: a plan whose worst case exceeds the remaining budget is NO-GO', () => {
  const r = preflight({ ...pre(), repeats: 20 });
  assertEquals(r.go, false);
  assert(r.blockers.some((b) => b.startsWith('worst case $')));
  assert(r.maxAffordableRepeats >= 1 && r.maxAffordableRepeats < 20);
});

Deno.test('benchmark harness is not imported by any deployed function', async () => {
  for (const file of ['../../../scan-identify/index.ts', '../../../scan-identify/scanCommerceRouter.ts', '../../../black-owned-discovery/index.ts']) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(!src.includes('vri03/benchmark'), file);
  }
});
