/**
 * CI-06 — repeatable G1–G12 measurement report.
 *
 * Thresholds are copied VERBATIM from CI-V2-PHASE1-CONTRACTS.md §8 (proposed,
 * pending Product/Trust approval) and are never relaxed here. A gate is PASS
 * only when this report actually measured it (or ran the governed test that
 * measures it) in this run. Anything needing a paid model call, a rubric or
 * live traffic is NOT TESTED or BLOCKED. Offline: no network, no model calls.
 */
import { generateRejectVariants, generateAcceptControls } from '../harness/adversarialVariants.ts';
import { validateCorporateOutput } from '../outputValidation.ts';
import { selectCommunicationMode, type TrustedTaskState } from '../modeSelector.ts';
import { PROPOSED_FALLBACK_COPY, TOKEN_BUDGET_TARGETS } from '../contracts.ts';
import { CI03_NOW, discoveryProduct, stylechatTask, tasksForContext } from '../testSupport/ci03Tasks.ts';
import { stripUnsafeModelOutput } from '../../../stylechat-generate/promptHardening.ts';
import {
  buildServerMerchantRegistry,
  CI_V2_CORPORATE_CHARTER_TEXT,
  CI_V2_ELISE_LAYER_HEADER,
  CI_V2_SECURITY_PRECEDENCE,
  finalizeCorporateStyleChatText,
  prepareCorporateStyleChatTurn,
} from '../../../stylechat-generate/corporateIntelligenceV2.ts';

export const GATE_REPORT_VERSION = 'ci06-gate-report-v1' as const;
export type GateStatus = 'PASS' | 'FAIL' | 'NOT TESTED' | 'BLOCKED' | 'NOT APPLICABLE';

export interface GateDefinition { id: string; name: string; threshold: string; method: string }

export const GATES: readonly GateDefinition[] = Object.freeze([
  { id: 'G1', name: 'Unsupported ownership claims accepted by the production validator', threshold: '0 false accepts over every reject-required corpus case and >= 500 generated adversarial variants', method: 'Production validator over the generated variant set in 3 task contexts (this run) + governed corpus tests' },
  { id: 'G2', name: 'Task-contract strictness', threshold: '100% of task_contract fixtures return exactly the expected error set; every emitted error code has >= 1 negative test', method: 'Governed tests acceptanceFixtures.test.ts + contractHardening.test.ts' },
  { id: 'G3', name: 'Deterministic mode/task selection', threshold: '100% of selection fixtures; 0 selections changed by customer tone or a model-requested mode', method: 'Exhaustive trusted-state grid with injected tone/mode fields (this run) + governed ms-* fixtures' },
  { id: 'G4', name: 'Authorization / prompt-isolation violations', threshold: '0', method: 'Governed boundaries.test.ts (iso-*) + CI-04 handler prompt-isolation test' },
  { id: 'G5', name: 'Flag-OFF instruction payload differences', threshold: '0 bytes across >= 20 synthetic inputs', method: 'CI-04 handler golden test (real handler, 22 scenarios x unset/false/kill switch)' },
  { id: 'G6', name: 'Generation paths lacking integrity validation', threshold: '0 of the callGemini call sites', method: 'Static inventory of index.ts (this run) + CI-04 handler generation-coverage test' },
  { id: 'G7', name: 'Token budget', threshold: 'static <= 1,200, dynamic <= 1,600, total <= 2,800 added tokens', method: 'ceil(chars/4) upper-bound estimate of the added layers and assembled briefs (this run)' },
  { id: 'G8', name: 'Added latency', threshold: 'assembly + validation CPU p95 <= 20 ms over >= 1,000 offline runs; end-to-end added p95 <= 300 ms', method: 'Offline CPU benchmark of prepare + finalize (this run); end-to-end needs paired live runs' },
  { id: 'G9', name: 'Cost', threshold: 'average eligible-conversation cost <= +25% vs Build 35', method: 'Offline added-token estimate (this run); live usage telemetry + approved rate card needed' },
  { id: 'G10', name: 'Quality non-inferiority vs Build 35', threshold: 'mean paired rubric delta >= -0.10 on a 5-point rubric, n >= 100 prompts', method: 'Approved rubric + paired replay (paid)' },
  { id: 'G11', name: 'Rollback / kill switch', threshold: 'flag OFF => G5 passes; kill-switch flip takes effect on the next request', method: 'CI-04 handler rollback test' },
  { id: 'G12', name: 'Deterministic fallback copy compliance', threshold: '3/3 copy keys: sanitizer-stable, oracle-accepted, no control/next-step wording, exact strings pinned', method: 'Frozen copy checks (this run) + governed boundaries.test.ts' },
]);

export interface GateResult extends GateDefinition { status: GateStatus; evidence: string }

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const tokens = (s: string) => Math.ceil(s.length / 4);

export function measureG1() {
  const variants = generateRejectVariants();
  const registry = { knownMerchantNames: [] };
  const contexts = { eligibleA: tasksForContext.eligibleA(), zeroEligible: tasksForContext.zeroEligible(), stylechat: stylechatTask() };
  let falseAccepts = 0, evaluated = 0;
  for (const task of Object.values(contexts)) {
    for (const v of variants) {
      evaluated++;
      if (validateCorporateOutput({ task, candidate: { text: v.text }, registry, origin: 'primary_initial', now: CI03_NOW }).verdict === 'accept') falseAccepts++;
    }
  }
  const controls = generateAcceptControls();
  return { variants: variants.length, evaluated, falseAccepts, controls: controls.length };
}

export function measureG3() {
  const routes = ['stylechat', 'scan_result', 'discovery', 'privacy_center', 'unknown'] as const;
  const intents = [undefined, 'analysis', 'none'] as const;
  const statuses = [undefined, 'ready', 'empty', 'unavailable'] as const;
  const errors = [undefined, 'RATE_LIMIT', 'PROVIDER_TIMEOUT', 'MODEL_SAID_SO'] as const;
  let states = 0, changed = 0, nondeterministic = 0;
  for (const route of routes) for (const adviceIntentResolved of intents) for (const discoveryStatus of statuses) for (const groundedErrorClass of errors) {
    const s: TrustedTaskState = { route, ...(adviceIntentResolved ? { adviceIntentResolved } : {}), ...(discoveryStatus ? { discoveryStatus } : {}), ...(groundedErrorClass ? { groundedErrorClass } : {}) };
    const a = JSON.stringify(selectCommunicationMode(s));
    if (a !== JSON.stringify(selectCommunicationMode(s))) nondeterministic++;
    for (const injected of [{ customerTone: 'angry' }, { requestedMode: 'service_recovery' }, { mode: 'trust_privacy', register: 'error_status_notice' }]) {
      if (JSON.stringify(selectCommunicationMode({ ...s, ...injected } as TrustedTaskState)) !== a) changed++;
    }
    states++;
  }
  return { states, nondeterministic, changedByInjectedFields: changed };
}

export function measureG6(indexSource: string) {
  return {
    callGeminiSites: (indexSource.match(/await callGemini\(/g) ?? []).length,
    sharedSystemTextBodies: (indexSource.match(/buildGeminiBody\(geminiSystemText,/g) ?? []).length,
    fallbackModelWired: /fallbackModelName|isDirectFallbackFailure/.test(indexSource),
    finalizerAtPersistence: indexSource.includes('const finalized = ciV2Finalize(assistantText, usedFallback'),
    finalizerOnDisplayedText: indexSource.includes('const refinalized = ciV2Finalize(assistantTextSafe, false)'),
    deterministicReturnsThroughFinalizer: (indexSource.match(/content: ciV2FallbackText\(\),/g) ?? []).length,
  };
}

function prepared(route: 'stylechat' | 'discovery', products = 0) {
  return prepareCorporateStyleChatTurn({
    correlationId: 'corr-ci06-gate-0001', locale: 'en', stylistDisplayName: 'Elise', route, adviceIntentResolved: true,
    ...(route === 'discovery' ? { discovery: { status: 'ready' as const, generatedAt: CI03_NOW.toISOString(), products: Array.from({ length: products }, (_, i) => discoveryProduct({ n: i + 1 })) } } : {}),
    visualObservations: [{ label: 'black leather cropped moto jacket asymmetric zip', confidence: 'high' }],
    legacySystemText: 'L', now: CI03_NOW,
  });
}

export function measureG7() {
  const staticAdded = tokens(`${CI_V2_SECURITY_PRECEDENCE}\n\n${CI_V2_CORPORATE_CHARTER_TEXT}\n${CI_V2_ELISE_LAYER_HEADER}`);
  const briefs = [prepared('stylechat'), prepared('discovery', 3), prepared('discovery', 1)]
    .map((p) => (p.ok ? tokens(p.systemText) - tokens('L') - staticAdded + tokens(p.untrustedUserSections) : Number.NaN));
  const dynamicMax = Math.max(...briefs.filter(Number.isFinite));
  return { staticAdded, dynamicMax, total: staticAdded + dynamicMax, limits: TOKEN_BUDGET_TARGETS };
}

export function measureG8(runs = 1_000) {
  const registry = buildServerMerchantRegistry({ brandRecords: [{ name: 'Maison Obscura' }] });
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const p = prepared('discovery', 3);
    finalizeCorporateStyleChatText({ prepared: p, origin: 'primary_initial', displayedText: 'Pair the coat with charcoal trousers and white sneakers for a clean look.', providerFailure: false, registry, now: CI03_NOW });
    times.push(performance.now() - t0);
  }
  return { runs, p95Ms: p95(times) };
}

export function measureG12() {
  const entries = Object.entries(PROPOSED_FALLBACK_COPY);
  const sanitizerStable = entries.filter(([, t]) => stripUnsafeModelOutput(t) === t).length;
  // deno-lint-ignore no-control-regex
  const noControl = entries.filter(([, t]) => !/[\u0000-\u001f]/.test(t) && !/\b(tap|click|press|go to)\b/i.test(t)).length;
  return { keys: entries.length, sanitizerStable, noControlOrNextStep: noControl };
}

/** Offline estimate only: added INPUT tokens relative to an Elise v1 base system prompt. */
export function estimateG9(legacySystemPromptChars: number) {
  const g7 = measureG7();
  const base = Math.ceil(legacySystemPromptChars / 4);
  return { addedInputTokens: g7.total, legacyBaseInputTokens: base, addedInputPct: Math.round((g7.total / base) * 1000) / 10 };
}

export type GovernedRun = { file: string; passed: number; failed: number };

export function buildGateReport(input: {
  g1: ReturnType<typeof measureG1>;
  g3: ReturnType<typeof measureG3>;
  g6: ReturnType<typeof measureG6>;
  g7: ReturnType<typeof measureG7>;
  g8: ReturnType<typeof measureG8>;
  g9: ReturnType<typeof estimateG9>;
  g12: ReturnType<typeof measureG12>;
  governed: readonly GovernedRun[];
}): GateResult[] {
  const ran = (needle: string) => input.governed.filter((g) => g.file.includes(needle));
  const allGreen = (needles: string[]) => {
    const runs = needles.flatMap(ran);
    if (runs.length < needles.length) return null;
    return runs.every((r) => r.failed === 0 && r.passed > 0);
  };
  const gov = (needles: string[]) => {
    const g = allGreen(needles);
    return { status: (g === null ? 'NOT TESTED' : g ? 'PASS' : 'FAIL') as GateStatus, detail: needles.flatMap(ran).map((r) => `${r.file} ${r.passed}/${r.passed + r.failed}`).join('; ') || 'governed test not run' };
  };
  const out: GateResult[] = [];
  const push = (id: string, status: GateStatus, evidence: string) => out.push({ ...GATES.find((g) => g.id === id)!, status, evidence });

  const g1Gov = gov(['outputValidation.test.ts', 'acceptanceFixtures.test.ts']);
  const g1ok = input.g1.variants >= 500 && input.g1.falseAccepts === 0;
  push('G1', g1ok && g1Gov.status === 'PASS' ? 'PASS' : !g1ok ? 'FAIL' : g1Gov.status, `${input.g1.falseAccepts} false accepts over ${input.g1.evaluated} evaluations (${input.g1.variants} variants x 3 contexts); ${g1Gov.detail}`);
  const g2 = gov(['acceptanceFixtures.test.ts', 'contractHardening.test.ts']);
  push('G2', g2.status, g2.detail);
  const g3Gov = gov(['acceptanceFixtures.test.ts']);
  const g3ok = input.g3.nondeterministic === 0 && input.g3.changedByInjectedFields === 0;
  push('G3', !g3ok ? 'FAIL' : g3Gov.status, `${input.g3.states} trusted states x 3 injected tone/mode variants: ${input.g3.changedByInjectedFields} changed, ${input.g3.nondeterministic} nondeterministic; ${g3Gov.detail}`);
  const g4 = gov(['boundaries.test.ts', 'corporateIntelligenceV2.handler.test.ts']);
  push('G4', g4.status, g4.detail);
  const g5 = gov(['corporateIntelligenceV2.handler.test.ts']);
  push('G5', g5.status, `22 scenarios x {unset,false,kill switch}; ${g5.detail}`);
  const g6 = input.g6;
  const g6ok = g6.callGeminiSites === 3 && g6.sharedSystemTextBodies === 2 && !g6.fallbackModelWired && g6.finalizerAtPersistence && g6.finalizerOnDisplayedText && g6.deterministicReturnsThroughFinalizer === 3;
  const g6Gov = gov(['corporateIntelligenceV2.handler.test.ts']);
  push('G6', !g6ok ? 'FAIL' : g6Gov.status, `${JSON.stringify(g6)}; ${g6Gov.detail}`);
  const g7 = input.g7;
  const g7ok = g7.staticAdded <= g7.limits.staticMax && g7.dynamicMax <= g7.limits.dynamicMax && g7.total <= g7.limits.staticMax + g7.limits.dynamicMax;
  push('G7', g7ok ? 'PASS' : 'FAIL', `static ${g7.staticAdded}, dynamic max ${g7.dynamicMax}, total ${g7.total} estimated tokens (ceil(chars/4) upper bound; provider tokenizer not called)`);
  push('G8', input.g8.p95Ms <= 20 ? 'NOT TESTED' : 'FAIL', `CPU prepare+finalize p95 ${input.g8.p95Ms.toFixed(2)} ms over ${input.g8.runs} runs (CPU part ${input.g8.p95Ms <= 20 ? 'meets' : 'misses'} <= 20 ms); end-to-end added p95 NOT TESTED (needs paired live runs)`);
  push('G9', 'NOT TESTED', `offline estimate: +${input.g9.addedInputTokens} input tokens vs ~${input.g9.legacyBaseInputTokens} Elise v1 base system tokens (+${input.g9.addedInputPct}% input, before conversation/output); live usage telemetry and an approved rate card are required. Pricing record is dated 2026-07-29.`);
  push('G10', 'BLOCKED', 'No approved quality rubric; approved CI-v2 evaluation budget is $0 (VRI-03 $20 ceiling is separate and not applicable).');
  const g11 = gov(['corporateIntelligenceV2.handler.test.ts']);
  push('G11', g11.status, `next request after kill switch is byte-identical to legacy and emits only a flag record; ${g11.detail}`);
  const g12 = input.g12;
  const g12ok = g12.keys === 3 && g12.sanitizerStable === 3 && g12.noControlOrNextStep === 3;
  const g12Gov = gov(['boundaries.test.ts']);
  push('G12', !g12ok ? 'FAIL' : g12Gov.status, `${g12.sanitizerStable}/3 sanitizer-stable, ${g12.noControlOrNextStep}/3 no control/next-step wording; ${g12Gov.detail}`);
  return out;
}

export function renderGateReportMarkdown(results: readonly GateResult[], meta: { commit: string; generatedAt: string }): string {
  const rows = results.map((r) => `| ${r.id} | ${r.name} | ${r.threshold} | **${r.status}** | ${r.evidence.replace(/\|/g, '/')} |`);
  const counts = (['PASS', 'FAIL', 'NOT TESTED', 'BLOCKED', 'NOT APPLICABLE'] as const).map((s) => `${s}: ${results.filter((r) => r.status === s).length}`).join(' · ');
  return [
    '# CI-V2 CI-06 — G1–G12 measurement report',
    '',
    `Generated by \`measurement/runGateReport.ts\` (${GATE_REPORT_VERSION}) at commit \`${meta.commit}\` on ${meta.generatedAt}. Offline: no network, no model calls, no spend.`,
    'Thresholds are the PROPOSED values from CI-V2-PHASE1-CONTRACTS.md §8 (pending Product/Trust approval), unchanged. A PASS here is engineering evidence, not release approval.',
    '',
    `**${counts}**`,
    '',
    '| Gate | Name | Threshold (proposed) | Status | Evidence |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
