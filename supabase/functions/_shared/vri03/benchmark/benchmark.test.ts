import { assert, assertAlmostEquals, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  BudgetExceededError,
  BudgetHaltedError,
  costFromUsage,
  createBudgetGuard,
  inspectLedger,
  type LedgerEntry,
  LedgerIntegrityError,
  validatePricing,
  VRI03_GEMINI_CEILING_USD,
  VRI03_PRICING,
} from './budgetGuard.ts';
import { checkLedgerReadiness, createFileLedgerStore, createMemoryLedgerStore, parseLedgerJsonl } from './ledgerStore.ts';
import { evaluateManifestGate, VRI03_MIN_ITEMS } from './manifestGate.ts';
import { auditFabrication, CohortError, computeArmMetrics, decideKeep, type ItemRun, p95 } from './metrics.ts';
import { preflight, type PreflightInput } from './preflight.ts';
import { importResultLabels, intakeToManifest, labelKey, parseCsv } from './kitImport.ts';
import { resolveRoutePlan } from '../../llmModelRouting.ts';

const MODEL = 'gemini-3.6-flash';
const ctx = { itemId: 'vri03-0001', arm: 'baseline' };
const offline = (o: Record<string, unknown> = {}) => createBudgetGuard({ mode: 'offline', ...o });
const NOW = new Date('2026-11-04T00:00:00Z');

// ── Budget guard ─────────────────────────────────────────────────────────────

Deno.test('budget: $20 ceiling is immutable in paid mode and can only be lowered offline', () => {
  assertEquals(VRI03_GEMINI_CEILING_USD, 20);
  assertThrows(() => offline({ offlineCeilingUsd: 20.01 }));
  assertThrows(() => offline({ offlineCeilingUsd: 0 }));
  assertThrows(() => createBudgetGuard({ mode: 'paid', append: () => {}, offlineCeilingUsd: 5 }));
  assertEquals(createBudgetGuard({ mode: 'paid', append: () => {} }).ceilingUsd, 20);
});

Deno.test('budget: paid mode requires a durable store and counted input tokens', () => {
  assertThrows(() => createBudgetGuard({ mode: 'paid' }));
  const g = createBudgetGuard({ mode: 'paid', append: () => {} });
  assertThrows(() => g.reserveGeminiAttempt(MODEL, ctx), Error, 'counted input tokens');
  g.reserveGeminiAttempt(MODEL, { ...ctx, countedInputTokens: 2600 });
});

Deno.test('budget: settles actual cost from usageMetadata, thinking billed as output', () => {
  const g = offline();
  const r = g.reserveGeminiAttempt(MODEL, ctx);
  const e = g.settleGeminiAttempt(r, { promptTokenCount: 2500, candidatesTokenCount: 400, thoughtsTokenCount: 100 });
  assertEquals(e.costSource, 'usage_metadata');
  assertEquals(e.outputTokens, 500);
  assertAlmostEquals(e.costUsd, (2500 * 1.5 + 500 * 7.5) / 1e6, 1e-12);
  assertAlmostEquals(g.summary().spentUsd, e.costUsd, 1e-12);
});

Deno.test('budget: missing or malformed usage is charged worst case, never free', () => {
  const g = offline();
  for (const usage of [null, undefined, {}, { promptTokenCount: -1, candidatesTokenCount: 3 }, { promptTokenCount: '10', candidatesTokenCount: 3 }]) {
    const r = g.reserveGeminiAttempt(MODEL, ctx);
    const e = g.settleGeminiAttempt(r, usage as never);
    assertEquals(e.costSource, 'worst_case_no_usage');
    assertAlmostEquals(e.costUsd, r.worstCaseUsd, 1e-12);
  }
  assertEquals(g.summary().geminiAttemptsChargedWorstCase, 5);
});

Deno.test('budget: actual usage above the reservation HALTS the guard', () => {
  const g = offline();
  const r = g.reserveGeminiAttempt(MODEL, { ...ctx, countedInputTokens: 100 });
  const e = g.settleGeminiAttempt(r, { promptTokenCount: 50_000, candidatesTokenCount: 10 });
  assert(e.overrunUsd > 0);
  assert(g.summary().halted);
  assertThrows(() => g.reserveGeminiAttempt(MODEL, ctx), BudgetHaltedError);
  assertThrows(() => g.recordProviderCall('serper', ctx), BudgetHaltedError);
});

Deno.test('budget: interrupted or uncertain requests are charged worst case', () => {
  const g = offline();
  const r = g.reserveGeminiAttempt(MODEL, ctx);
  const u = g.markUncertain(r, 'timeout');
  assertAlmostEquals(u.costUsd, r.worstCaseUsd, 1e-12);
  // A crash after the intent was written: reload reconciles it as uncertain.
  const store = createMemoryLedgerStore();
  const a = createBudgetGuard({ mode: 'offline', append: store.appendDurable });
  a.reserveGeminiAttempt(MODEL, ctx); // process "dies" here, no settle
  const before = checkLedgerReadiness({ ...store, durable: true });
  assert(before.blockers.some((b) => b.includes('unreconciled open intent')));
  const b = createBudgetGuard({ mode: 'offline', priorLedger: store.readAll(), append: store.appendDurable });
  assertEquals(b.summary().uncertainAttempts, 1);
  assert(b.summary().spentUsd > 0);
  assertEquals(checkLedgerReadiness({ ...store, durable: true }).ready, true);
});

Deno.test('budget: aborts BEFORE a reservation that would cross the ceiling; release only when not sent', () => {
  const g = offline({ offlineCeilingUsd: 0.05 });
  const fits = Math.floor(0.05 / g.worstCaseCallUsd(MODEL));
  const held: ReturnType<typeof g.reserveGeminiAttempt>[] = [];
  for (let i = 0; i < fits; i++) held.push(g.reserveGeminiAttempt(MODEL, ctx));
  assertThrows(() => g.reserveGeminiAttempt(MODEL, ctx), BudgetExceededError);
  g.releaseNotSent(held.pop()!);
  g.reserveGeminiAttempt(MODEL, ctx);
  g.releaseNotSent(held[0]!);
  assertThrows(() => g.releaseNotSent(held[0]!), Error, 'unknown or closed');
});

Deno.test('budget: ledger is checksum-chained; tampering or truncation refuses to load', () => {
  const store = createMemoryLedgerStore();
  const g = createBudgetGuard({ mode: 'offline', append: store.appendDurable });
  g.settleGeminiAttempt(g.reserveGeminiAttempt(MODEL, ctx), { promptTokenCount: 1e6, candidatesTokenCount: 0 });
  const entries = store.readAll();
  assert(inspectLedger(entries).ok);
  const tampered = entries.map((e) => (e.kind === 'settled' ? { ...e, costUsd: 0 } : e)) as LedgerEntry[];
  assertThrows(() => offline({ priorLedger: tampered }), LedgerIntegrityError);
  assertThrows(() => offline({ priorLedger: entries.slice(1) }), LedgerIntegrityError);
  assertThrows(() => parseLedgerJsonl(`${store.lines[0]}\n{"seq":2,"kin`), LedgerIntegrityError);
  // Spend carries across runs.
  const next = offline({ priorLedger: entries });
  assertAlmostEquals(next.summary().spentUsd, 1.5, 1e-9);
  assertAlmostEquals(next.remainingUsd(), 18.5, 1e-9);
});

Deno.test({
  name: 'budget: file ledger store persists, fsyncs and reloads (when write permission is granted)',
  ignore: Deno.permissions.querySync({ name: 'write' }).state !== 'granted',
  fn() {
    const dir = Deno.makeTempDirSync();
    const path = `${dir}/ledger.jsonl`;
    const store = createFileLedgerStore(path);
    const g = createBudgetGuard({ mode: 'paid', append: store.appendDurable });
    g.settleGeminiAttempt(g.reserveGeminiAttempt(MODEL, { ...ctx, countedInputTokens: 2000 }), { promptTokenCount: 2000, candidatesTokenCount: 300 });
    assertEquals(checkLedgerReadiness(store).ready, true);
    assertEquals(store.readAll().length, 2);
    Deno.removeSync(dir, { recursive: true });
  },
});

Deno.test('budget: readiness rejects non-durable, halted or broken ledgers', () => {
  assert(checkLedgerReadiness(createMemoryLedgerStore()).blockers.includes('ledger store is not durable'));
  const store = createMemoryLedgerStore();
  const g = createBudgetGuard({ mode: 'offline', append: store.appendDurable });
  g.settleGeminiAttempt(g.reserveGeminiAttempt(MODEL, { ...ctx, countedInputTokens: 1 }), { promptTokenCount: 99_999, candidatesTokenCount: 1 });
  assert(checkLedgerReadiness({ ...store, durable: true }).blockers.some((b) => b.startsWith('ledger is halted')));
});

Deno.test('budget: provider calls are counted before sending; cost stays INSUFFICIENT_EVIDENCE', () => {
  const g = offline();
  g.recordProviderCall('serper', ctx);
  g.recordProviderCall('serper', ctx);
  g.recordProviderCall('poshmark', ctx);
  const s = g.summary();
  assertEquals(s.providerCalls, { serper: 2, poshmark: 1 });
  assertEquals(s.providerCostStatus, 'INSUFFICIENT_EVIDENCE');
  assertEquals(s.spentUsd, 0);
});

Deno.test('pricing: validated against the actually configured scanner route and its age', () => {
  const plan = resolveRoutePlan('scanner', () => undefined);
  assertEquals(validatePricing({ pricing: VRI03_PRICING, models: [plan.primaryModel, plan.fallbackModel!], now: new Date('2026-08-15T00:00:00Z') }), []);
  const stale = validatePricing({ pricing: VRI03_PRICING, models: [plan.primaryModel], now: NOW });
  assert(stale.some((i) => i.includes('days old')), JSON.stringify(stale));
  assert(validatePricing({ pricing: VRI03_PRICING, models: ['gemini-unpriced'], now: new Date('2026-08-01') }).some((i) => i.includes('no dated price')));
  assertAlmostEquals(costFromUsage(VRI03_PRICING.models[MODEL], 1e6, 1e6), 9, 1e-12);
});

// ── Manifest gate + kit import ───────────────────────────────────────────────

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
const KIT = '../../../../../docs/vri-03/collection-kit/';

Deno.test('gate: empty manifest fails with an explicit count; 16 valid items pass', () => {
  const r = evaluateManifestGate(manifestOf([]));
  assert(r.issues.some((i) => i.problem.includes(`need ≥${VRI03_MIN_ITEMS} valid items, have 0`)));
  const ok = evaluateManifestGate(manifestOf(Array.from({ length: 16 }, (_, i) => item(i + 1))));
  assertEquals(ok.issues, []);
  assert(ok.strata.underpowered.includes('accessory'));
});

Deno.test('gate: ground truth never inferred; identifiers and duplicates rejected', () => {
  const items = Array.from({ length: 16 }, (_, i) => item(i + 1));
  items[0] = item(1, { googleEvidence: undefined });
  items[1] = item(2, { groundTruth: { category: 'top', subtype: 'tee', reviewers: 1 } });
  items[2] = item(3, { notes: 'contact jane@example.com' });
  items[15] = { ...item(16), imageDigest: item(4).imageDigest };
  const r = evaluateManifestGate(manifestOf(items));
  assertEquals(r.pass, false);
  assert(r.issues.some((i) => i.problem === 'duplicate image'));
  assert(r.issues.some((i) => i.problem.includes('email')));
});

Deno.test('kit: committed template and intake sheet import against the real schema', async () => {
  const raw = await Deno.readTextFile(new URL(`${KIT}failure-set.manifest.template.json`, import.meta.url));
  const tpl = evaluateManifestGate({ ...JSON.parse(raw), items: [] });
  assert(tpl.issues.every((i) => i.path === '$.items' || i.path.startsWith('$.strata')), JSON.stringify(tpl.issues));
  const intake = await Deno.readTextFile(new URL(`${KIT}intake.csv.txt`, import.meta.url));
  const { manifest, issues } = intakeToManifest(intake);
  assertEquals(issues, []);
  assertEquals(manifest.items.length, 1);
  const gate = evaluateManifestGate(manifest);
  assertEquals(gate.pass, false); // blank template row: rejected item-by-item, not a parse failure
  assert(gate.issues.some((i) => i.path === 'items[0].imageDigest'));
});

Deno.test('kit: a filled 16-row intake sheet imports and passes the gate; initials never reach the manifest', async () => {
  const header = (await Deno.readTextFile(new URL(`${KIT}intake.csv.txt`, import.meta.url))).split(/\r?\n/)[0];
  const rows = Array.from({ length: 16 }, (_, i) => {
    const it = item(i + 1) as Record<string, any>;
    return [it.itemId, it.imageDigest, 'image-consent-v1', `consent-${i + 1}`, '2026-11-01', it.strata.scene, it.strata.type, 'false', 'unknown',
      it.targetDescription ? `"${it.targetDescription}"` : '', 'retailer.example', '"Moto Jacket, Black"', '2026-11-01', 'US', 'true', 'outerwear', 'moto jacket', 'AB', 'CD', 'false'].join(',');
  });
  const { manifest, issues } = intakeToManifest([header, ...rows].join('\r\n') + '\r\n');
  assertEquals(issues, []);
  const gate = evaluateManifestGate(manifest);
  assertEquals(gate.issues, []);
  assertEquals(manifest.items[0].googleEvidence.productTitle, 'Moto Jacket, Black');
  assert(!JSON.stringify(manifest).includes('"AB"'));
});

Deno.test('kit: result labels need agreement or adjudication', async () => {
  const header = (await Deno.readTextFile(new URL(`${KIT}results-labeling.csv.txt`, import.meta.url))).split(/\r?\n/)[0];
  const text = [header,
    'vri03-0001,baseline,shown,1,https://r.example/p/1,r,,exact_match,exact_match,',
    'vri03-0001,baseline,shown,2,https://r.example/p/2,r,,exact_match,wrong_category,',
    'vri03-0001,baseline,shown,3,https://r.example/p/3,r,,exact_match,wrong_category,visually_similar_acceptable',
    'vri03-0001,baseline,shown,4,https://r.example/p/4,r,,great,great,'].join('\n');
  const { labels, unresolved, issues } = importResultLabels(text);
  assertEquals(labels.get(labelKey('vri03-0001', 'baseline', 'shown', 'https://r.example/p/1'))!.label, 'exact_match');
  assertEquals(labels.get(labelKey('vri03-0001', 'baseline', 'shown', 'https://r.example/p/2'))!.label, 'unlabeled');
  assertEquals(labels.get(labelKey('vri03-0001', 'baseline', 'shown', 'https://r.example/p/3'))!.label, 'visually_similar_acceptable');
  assertEquals(unresolved, 2);
  assert(issues.some((i) => i.includes('"great"')));
  assertEquals(parseCsv('a,"b ""q"", c"\r\n'), [['a', 'b "q", c']]);
});

// ── Metrics / comparisons ────────────────────────────────────────────────────

function run(id: number, o: Partial<ItemRun> = {}): ItemRun {
  return {
    itemId: `vri03-${String(id).padStart(4, '0')}`,
    strata: { scene: id % 2 ? 'single_object' : 'multi_object', type: id % 3 ? 'garment' : 'accessory' },
    identification: { categoryCorrect: true, itemCorrect: true, targetSelectedCorrect: id % 2 ? null : true },
    candidates: [], shown: [], recordedPoolUrls: ['a', 'b', 'c', 'd'], eligibleOwnershipRowIds: [],
    scanToResultsMs: 1000 + id * 10, geminiCostUsd: 0.008, costFromWorstCase: false, providerCalls: 2,
    ...o,
  };
}
const hit = (url: string, label: ItemRun['shown'][number]['label']) => ({ canonicalUrl: url, merchant: 'm', label });
const ids = [1, 2, 3, 4].map((i) => `vri03-${String(i).padStart(4, '0')}`);

Deno.test('metrics: p95 nearest-rank; exact and similar-only are disjoint', () => {
  assertEquals(p95([]), null);
  assertEquals(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
  const m = computeArmMetrics('baseline', [
    run(1, { candidates: [hit('a', 'exact_match')], shown: [hit('a', 'exact_match')] }),
    run(2, { candidates: [hit('b', 'visually_similar_acceptable')], shown: [hit('b', 'visually_similar_acceptable')] }),
    run(3, { candidates: [hit('c', 'wrong_category')] }),
    run(4),
  ], ids);
  assertEquals(m.recall.shownExact, 0.25);
  assertEquals(m.recall.shownSimilarOnly, 0.25);
  assertEquals(m.recall.shownAcceptable, 0.5);
  assertEquals(m.recall.candidateSimilarOnly, 0.25);
});

Deno.test('cohort: duplicate, missing or extra per-item results are rejected', () => {
  assertThrows(() => computeArmMetrics('x', [run(1), run(1), run(2), run(3)], ids), CohortError, 'duplicate');
  assertThrows(() => computeArmMetrics('x', [run(1), run(2), run(3)], ids), CohortError, 'missing result for vri03-0004');
  assertThrows(() => computeArmMetrics('x', [run(1), run(2), run(3), run(4), run(5)], ids), CohortError, 'unexpected');
});

Deno.test('fabrication: unsourced results and ineligible ownership labels are violations', () => {
  const a = auditFabrication([
    run(1, { shown: [hit('a', 'exact_match'), hit('ghost', 'exact_match')] }),
    run(2, { shown: [{ ...hit('b', 'visually_similar_acceptable'), ownershipRowId: 'row-x' }], eligibleOwnershipRowIds: ['row-y'] }),
  ]);
  assertEquals([a.unsourcedShown, a.ineligibleOwnershipLabels, a.pass], [1, 1, false]);
});

Deno.test('decision: keep only a measured recall win with identical cohorts and no regression', () => {
  const arm = (name: string, f: (i: number) => Partial<ItemRun>) => computeArmMetrics(name, [1, 2, 3, 4].map((i) => run(i, f(i))), ids);
  const before = arm('baseline', (i) => ({ shown: i === 1 ? [hit('a', 'exact_match')] : [] }));
  const better = arm('h3', (i) => ({ shown: i === 1 ? [hit('a', 'exact_match')] : i === 2 ? [hit('b', 'visually_similar_acceptable')] : [] }));
  assertEquals(decideKeep(before, better).decision, 'KEPT');
  assert(decideKeep(before, arm('h1', (i) => ({ shown: i <= 2 ? [hit('b', 'visually_similar_acceptable')] : [] }))).reasons.includes('exact-match recall regressed'));
  assert(decideKeep(before, arm('h2', (i) => ({ scanToResultsMs: 2000, shown: i <= 2 ? [hit('a', 'exact_match')] : [] }))).reasons.some((r) => r.startsWith('latency p95')));
  assert(decideKeep(before, arm('h4', (i) => ({ geminiCostUsd: null, shown: i <= 2 ? [hit('a', 'exact_match')] : [] }))).reasons.includes('Gemini cost unmeasured'));
  assert(decideKeep(before, arm('h5', (i) => ({ scanToResultsMs: null, shown: i <= 2 ? [hit('a', 'exact_match')] : [] }))).reasons.includes('latency unmeasured'));
  assert(decideKeep(before, arm('h6', (i) => ({ shown: i <= 2 ? [hit('a', 'exact_match'), hit('ghost', 'exact_match')] : [] }))).reasons.includes('fabrication audit failed'));
  const other = computeArmMetrics('h7', [1, 2, 3, 5].map((i) => run(i, { shown: [hit('a', 'exact_match')] })));
  assert(decideKeep(before, other).reasons.includes('baseline and treatment item IDs differ'));
});

// ── Preflight ────────────────────────────────────────────────────────────────

function pre(over: Partial<PreflightInput['env']> = {}, items = 24, repeats = 2, now = new Date('2026-08-15T00:00:00Z')): PreflightInput {
  const store = createMemoryLedgerStore();
  return {
    gate: evaluateManifestGate(manifestOf(Array.from({ length: items }, (_, i) => item(i + 1)))),
    ledger: checkLedgerReadiness({ ...store, durable: true }),
    routePlan: resolveRoutePlan('scanner', () => undefined), now,
    callsPerItem: 2, geminiArms: ['baseline', 'h1', 'h2'], repeats, providerQueriesPerItem: 2, providerArms: ['baseline', 'h1', 'h2', 'h3'],
    env: {
      target: 'staging', targetProjectRef: 'staging-ref', forbiddenProjectRefs: ['prod-ref'], geminiKeyPresent: true,
      geminiKeyScope: 'staging', testActorConsentEvidenceId: 'actor-consent-1', imageRootPresent: true,
      spendConfirmedByOwnerInSession: true, ...over,
    },
  };
}

Deno.test('preflight: current session state is NO-GO with every missing input named (incl. stale pricing)', () => {
  const p = pre({ geminiKeyPresent: false, geminiKeyScope: '', testActorConsentEvidenceId: '', imageRootPresent: false, spendConfirmedByOwnerInSession: false, targetProjectRef: '', forbiddenProjectRefs: [] }, 0, 2, NOW);
  const r = preflight({ ...p, ledger: checkLedgerReadiness(createMemoryLedgerStore()) });
  assertEquals(r.go, false);
  for (const s of ['failure-set gate', 'Staging-scoped Gemini key', 'test actor', 'image root', 'spend not confirmed', 'forbidden (Production)', 'not durable', 'days old']) {
    assert(r.blockers.some((b) => b.includes(s)), s);
  }
});

Deno.test('preflight: production ref refused; with retries, 3 repeats exceed $20 but 2 fit', () => {
  assert(preflight(pre({ targetProjectRef: 'prod-ref' })).blockers.some((b) => b.includes('forbidden (Production) ref')));
  const two = preflight(pre());
  assertEquals(two.plannedGeminiAttempts, 24 * 2 * 3 * 2 * 2);
  assert(two.worstCaseUsd <= 20 && two.go, JSON.stringify(two.blockers));
  const three = preflight(pre({}, 24, 3));
  assertEquals(three.go, false);
  assertEquals(three.maxAffordableRepeats, 2);
});

// ── Offline mocked run: proves no billed or network call ─────────────────────

Deno.test('offline harness example: mocked transport, budget guard, metrics; zero network calls', async () => {
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => { networkCalls++; throw new Error('network forbidden in offline harness'); }) as typeof fetch;
  try {
    const store = createMemoryLedgerStore();
    const guard = createBudgetGuard({ mode: 'offline', append: store.appendDurable });
    const mock = { geminiSends: 0, providerSends: 0 };
    const transport = {
      countTokens: () => 2600, // stands in for the free countTokens preflight
      generate: () => { mock.geminiSends++; return { usageMetadata: { promptTokenCount: 2600, candidatesTokenCount: 420, thoughtsTokenCount: 80 } }; },
      search: (q: string) => { mock.providerSends++; return [{ canonicalUrl: `https://r.example/${q}`, merchant: 'r' }]; },
    };
    const runs: ItemRun[] = [];
    for (const [n, id] of ids.entries()) {
      for (const pass of ['detection', 'selected']) {
        const r = guard.reserveGeminiAttempt(MODEL, { itemId: id, arm: 'baseline', countedInputTokens: transport.countTokens() });
        guard.settleGeminiAttempt(r, transport.generate().usageMetadata);
        void pass;
      }
      guard.recordProviderCall('serper', { itemId: id, arm: 'baseline' });
      const pool = transport.search(`q${n}`);
      runs.push(run(n + 1, {
        recordedPoolUrls: pool.map((p) => p.canonicalUrl),
        shown: pool.map((p) => ({ ...p, label: n === 0 ? 'exact_match' as const : 'wrong_category' as const })),
        geminiCostUsd: 2 * costFromUsage(VRI03_PRICING.models[MODEL], 2600, 500),
      }));
    }
    const m = computeArmMetrics('baseline', runs, ids);
    const s = guard.summary();
    assertEquals(networkCalls, 0);
    assertEquals(s.geminiAttempts, 8);
    assertEquals(mock.geminiSends, 8);
    assertEquals(s.providerCalls, { serper: 4 });
    assert(m.fabrication.pass);
    assertEquals(m.recall.shownExact, 0.25);
    assertEquals(m.cost.status, 'MEASURED');
    assertAlmostEquals(s.spentUsd, 8 * costFromUsage(VRI03_PRICING.models[MODEL], 2600, 500), 1e-12);
    assertEquals(checkLedgerReadiness({ ...store, durable: true }).ready, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Isolation ────────────────────────────────────────────────────────────────

Deno.test('isolation: benchmark modules make no network/env calls and are in no deployed bundle', async () => {
  for (const f of ['budgetGuard.ts', 'ledgerStore.ts', 'manifestGate.ts', 'metrics.ts', 'preflight.ts', 'kitImport.ts']) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    for (const banned of [/\bfetch\(/, /Deno\.env\.get/, /generativelanguage/i, /serper\.dev/i, /poshmark\.com/i]) {
      assert(!banned.test(src), `${f} matches ${banned}`);
    }
  }
  const manifest = await Deno.readTextFile(new URL('../../../../../config/edge-function-manifest.json', import.meta.url));
  assert(!manifest.includes('vri03/benchmark'), 'benchmark module appears in the edge-function manifest');
});
