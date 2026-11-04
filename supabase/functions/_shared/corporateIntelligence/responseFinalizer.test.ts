/**
 * CI-03 tests: deterministic fallback system, frozen versioned copy, content-minimized reason trace, and the
 * generation-path inventory. Offline: no network, no provider, no clock, zero billed calls.
 */
import nodeAssert from 'node:assert/strict';
import test from 'node:test';
import { INTEGRITY_FAILURE_CODES, PROPOSED_FALLBACK_COPY, selectFallback } from './contracts.ts';
import {
  copyKeyFor,
  FALLBACK_REASONS,
  FROZEN_COPY_KEYS,
  FROZEN_COPY_SET_VERSION,
  PROVISIONAL_COPY_MAP,
  REASON_FOR_FAILURE,
  resolveFrozenCopy,
  validateCopyMap,
} from './frozenCopy.ts';
import { type FinalResponse, finalizeCorporateResponse, type GenerationOutcome } from './responseFinalizer.ts';
import { GENERATION_ORIGINS, type GenerationOrigin } from './outputValidation.ts';
import { FUTURE_FALLBACK_MODEL_ORIGIN, STYLECHAT_GENERATION_PATHS } from './harness/generationPaths.ts';
import { assembleTask, CI03_NOW, discoveryProduct, discoveryResult, MERCHANT_A, stylechatTask, tasksForContext } from './testSupport/ci03Tasks.ts';

const assert = (cond: unknown, msg?: string) => nodeAssert.ok(cond, msg);
const assertEquals = (actual: unknown, expected: unknown, msg?: string) => nodeAssert.deepEqual(actual, expected, msg);

const REGISTRY = { knownMerchantNames: ['Atelier Nine', 'Brand Zed', 'Northline Studio'] };
const finalize = (task: unknown, outcome: GenerationOutcome, origin: GenerationOrigin = 'primary_initial', now = CI03_NOW): FinalResponse =>
  finalizeCorporateResponse({ task, origin, outcome, registry: REGISTRY, now });
const said = (text: string): GenerationOutcome => ({ kind: 'candidate', candidate: { text } });

// ── Frozen copy: closed, versioned, fail-safe, no new wording ───────────────────

test('frozen copy: closed versioned key set equal to the CI-01 proposal; wording reused byte-for-byte', () => {
  assertEquals(FROZEN_COPY_SET_VERSION, 'ci03-frozen-copy-v1-proposed');
  assertEquals([...FROZEN_COPY_KEYS].sort(), Object.keys(PROPOSED_FALLBACK_COPY).sort());
  assertEquals(PROVISIONAL_COPY_MAP.en, { ...PROPOSED_FALLBACK_COPY });
  assert(Object.isFrozen(FROZEN_COPY_KEYS) && Object.isFrozen(PROVISIONAL_COPY_MAP) && Object.isFrozen(PROVISIONAL_COPY_MAP.en));
  assertEquals(validateCopyMap(PROVISIONAL_COPY_MAP), { ok: true });
});

test('frozen copy: unknown keys, missing locales and broken maps degrade to pinned copy, never to empty or model text', () => {
  for (const key of FROZEN_COPY_KEYS) {
    const r = resolveFrozenCopy(key, 'en-US');
    assertEquals([r.text, r.resolution], [PROPOSED_FALLBACK_COPY[key], 'exact']);
    assertEquals(resolveFrozenCopy(key, 'fr-FR').resolution, 'locale_fallback');
    assertEquals(resolveFrozenCopy(key, 'fr-FR').text, PROPOSED_FALLBACK_COPY[key]);
  }
  for (const bad of ['', 'regenerate', 'ownership', '__proto__', null, 7]) {
    const r = resolveFrozenCopy(bad, 'en');
    assertEquals([r.key, r.text, r.resolution], ['generic_integrity_failure', PROPOSED_FALLBACK_COPY.generic_integrity_failure, 'unknown_key_fallback']);
  }
  const partial = { en: { zero_eligible: 'x' } };
  assertEquals(validateCopyMap(partial), { ok: false, missing: ['ownership_integrity_failure', 'generic_integrity_failure'] });
  for (const broken of [partial, {}, { en: { ...PROPOSED_FALLBACK_COPY, zero_eligible: '' } }, { en: { ...PROPOSED_FALLBACK_COPY, zero_eligible: 'a\nb' } }]) {
    const r = resolveFrozenCopy('zero_eligible', 'en', broken as never);
    assertEquals([r.text, r.resolution], [PROPOSED_FALLBACK_COPY.zero_eligible, 'invalid_map_fallback']);
  }
  // A reviewed substitution changes copy without touching validator logic.
  const reviewed = { en: { ...PROPOSED_FALLBACK_COPY, zero_eligible: 'Reviewed wording.' } };
  assertEquals(resolveFrozenCopy('zero_eligible', 'en', reviewed).text, 'Reviewed wording.');
});

test('fallback mapping: every integrity code has a reason; failure copy is exactly the pinned CI-01 selectFallback', () => {
  assertEquals(Object.keys(REASON_FOR_FAILURE).sort(), [...INTEGRITY_FAILURE_CODES].sort());
  for (const code of INTEGRITY_FAILURE_CODES) {
    for (const status of ['not_applicable', 'eligible', 'zero_eligible'] as const) {
      const key = copyKeyFor({ reason: REASON_FOR_FAILURE[code], primaryFailure: code }, status);
      assertEquals(key, selectFallback(code, status).copyKey, `${code}/${status}`);
    }
  }
  assertEquals(copyKeyFor({ reason: 'neutral_empty_inventory' }, 'zero_eligible'), 'zero_eligible');
  assertEquals(copyKeyFor({ reason: 'provider_or_validation_failure' }, 'eligible'), 'generic_integrity_failure');
  for (const r of ['ownership_integrity_failure', 'missing_authoritative_information', 'invalid_response_contract', 'provider_or_validation_failure', 'neutral_empty_inventory']) {
    assert((FALLBACK_REASONS as readonly string[]).includes(r), `directive reason ${r} missing`);
  }
});

// ── Finalizer outcomes: every reason is reachable and distinct ─────────────────

test('finalizer: distinct deterministic reasons for each failure class; copy never promises results that do not exist', () => {
  const eligible = tasksForContext.eligibleA();
  const chat = stylechatTask();
  const cases: [unknown, GenerationOutcome, string, string][] = [
    [eligible, said('Brand Zed is Black-owned.'), 'ownership_integrity_failure', 'ownership_integrity_failure'],
    [eligible, said('It costs $99.'), 'missing_authoritative_information', 'generic_integrity_failure'],
    [chat, { kind: 'candidate', candidate: { text: 'hi', toolCalls: [] } }, 'invalid_response_contract', 'generic_integrity_failure'],
    [chat, { kind: 'candidate', candidate: { text: '' } }, 'provider_or_validation_failure', 'generic_integrity_failure'],
    [chat, { kind: 'candidate', candidate: { text: 'A navy', finishReason: 'MAX_TOKENS' } }, 'provider_or_validation_failure', 'generic_integrity_failure'],
    [chat, { kind: 'provider_failure', failureClass: 'PROVIDER_TIMEOUT' }, 'provider_or_validation_failure', 'generic_integrity_failure'],
    [tasksForContext.zeroEligible(), said('No matches right now.'), 'neutral_empty_inventory', 'zero_eligible'],
    [chat, said("I've saved it to your Closet."), 'action_or_commitment_claim', 'generic_integrity_failure'],
    [chat, said('Write to jane.doe@example.com.'), 'privacy_exposure', 'generic_integrity_failure'],
  ];
  const seen = new Set<string>();
  for (const [task, outcome, reason, key] of cases) {
    const r = finalize(task, outcome);
    assertEquals([r.kind, r.kind === 'deterministic' && r.reason, r.kind === 'deterministic' && r.copyKey], ['deterministic', reason, key], reason);
    assertEquals(r.regenerate, false);
    assertEquals(r.text, PROPOSED_FALLBACK_COPY[key as keyof typeof PROPOSED_FALLBACK_COPY]);
    seen.add(reason);
  }
  assertEquals([...seen].sort(), [...FALLBACK_REASONS].sort(), 'every fallback reason is reachable');
});

test('finalizer: the neutral discovery empty state is ALWAYS frozen copy, even for an innocuous or hostile model answer', () => {
  const zero = tasksForContext.zeroEligible();
  for (const t of ['No matches right now.', 'Try Northline Studio instead.', 'Here are some Black-owned brands you will love.']) {
    const r = finalize(zero, said(t));
    assertEquals([r.kind, r.text], ['deterministic', PROPOSED_FALLBACK_COPY.zero_eligible]);
  }
  // A "ready" discovery whose every record failed re-validation is the same neutral state.
  const allStale = assembleTask({ discovery: discoveryResult([discoveryProduct({ inventoryVerifiedAt: '2026-11-01T00:00:00Z' })]) });
  assertEquals(allStale.taskVerb, 'discovery_empty_state');
  assertEquals(finalize(allStale, said('Atelier Nine is Black-owned.')).text, PROPOSED_FALLBACK_COPY.zero_eligible);
});

test('finalizer: accepted output passes through untouched with server-rendered labels only', () => {
  const r = finalize(tasksForContext.eligibleA(), { kind: 'candidate', candidate: { text: 'Atelier Nine is Black-owned.', whyThisWorks: 'Clean lines.' } });
  assert(r.kind === 'model');
  if (r.kind !== 'model') return;
  assertEquals([r.text, r.whyThisWorks], ['Atelier Nine is Black-owned.', 'Clean lines.']);
  assertEquals(r.labels.map((l) => [l.merchantRef, l.labelText]), [[MERCHANT_A, 'From a verified Black-owned business']]);
  const chat = finalize(stylechatTask(), said('A navy coat suits a city wardrobe.'));
  assertEquals([chat.kind, chat.kind === 'model' && chat.labels.length], ['model', 0]);
});

test('finalizer: fails closed on a validator fault, an invalid task, an invalid origin or a non-candidate outcome', () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); }, get() { throw new Error('boom'); } });
  const r1 = finalize(stylechatTask(), { kind: 'candidate', candidate: hostile });
  assertEquals([r1.kind, r1.kind === 'deterministic' && r1.reason], ['deterministic', 'provider_or_validation_failure']);
  const r2 = finalize({ ...stylechatTask(), capabilities: { proposable: [], executable: ['purchase'] } }, said('hi'));
  assertEquals([r2.kind, r2.trace.validatorStage, r2.trace.detailCodes], ['deterministic', 'stage0_server_authority', ['task_contract_rejected']]);
  const r3 = finalizeCorporateResponse({ task: stylechatTask(), origin: 'secret_fallback' as never, outcome: said('hi'), registry: REGISTRY, now: CI03_NOW });
  assertEquals([r3.kind, r3.trace.origin], ['deterministic', 'invalid_origin']);
  const r4 = finalizeCorporateResponse({ task: stylechatTask(), origin: 'primary_initial', outcome: null as never, registry: REGISTRY, now: CI03_NOW });
  assertEquals(r4.kind, 'deterministic');
  const r5 = finalizeCorporateResponse({ task: stylechatTask(), origin: 'primary_initial', outcome: said('hi'), registry: REGISTRY, now: new Date(NaN) });
  assertEquals(r5.kind, 'deterministic');
});

test('finalizer: a fallback-model candidate is held to exactly the same task and validation as the primary', () => {
  const task = tasksForContext.eligibleA();
  for (const t of ['Atelier Nine is Black-owned.', 'Great news: this is from a verified Black-owned business.', 'Brand Zed is Black-owned.']) {
    const primary = finalize(task, said(t), 'primary_initial');
    const fallback = finalize(task, said(t), FUTURE_FALLBACK_MODEL_ORIGIN);
    assertEquals({ ...primary, trace: { ...primary.trace, origin: null } }, { ...fallback, trace: { ...fallback.trace, origin: null } }, t);
  }
});

// ── Reason trace: closed, content-minimized ─────────────────────────────────────

const TRACE_KEYS = [
  'traceVersion', 'validatorVersion', 'outputContractVersion', 'taskContractVersion', 'charterVersion', 'copySetVersion',
  'correlationId', 'origin', 'taskVerb', 'communicationMode', 'presentationRegister', 'surface', 'inventoryStatus',
  'eligibleCount', 'eligibleMerchantsAtValidation', 'zeroEligible', 'labelRefs', 'labelsRendered', 'modelLabelEmitted',
  'modelLabelExactMatch', 'validatorStage', 'validatorResult', 'failureCodes', 'detailCodes', 'fallbackReason', 'copyKey',
  'regenerate',
].sort();

test('trace: closed key set; carries task/mode/register, counts, label refs, stage, result, reason and versions', () => {
  const r = finalize(tasksForContext.eligibleA(), said('Atelier Nine: From a verified Black-owned business.'));
  assertEquals(Object.keys(r.trace).sort(), TRACE_KEYS);
  assertEquals(
    [r.trace.taskVerb, r.trace.communicationMode, r.trace.presentationRegister, r.trace.inventoryStatus, r.trace.eligibleCount, r.trace.zeroEligible],
    ['merchant_discovery_explanation', 'professional', 'merchant_explanation', 'eligible', 1, false],
  );
  assertEquals(r.trace.labelRefs, [{ labelFactId: 'f_label_0', sourceRecordRef: `disc_${MERCHANT_A}` }]);
  assertEquals([r.trace.modelLabelEmitted, r.trace.modelLabelExactMatch, r.trace.validatorResult, r.trace.fallbackReason], [true, true, 'accept', null]);
  const rejected = finalize(tasksForContext.eligibleA(), said('Atelier Nine is a verified Black owned business.'));
  assertEquals([rejected.trace.modelLabelEmitted, rejected.trace.modelLabelExactMatch, rejected.trace.fallbackReason, rejected.trace.copyKey],
    [true, false, 'ownership_integrity_failure', 'ownership_integrity_failure']);
});

test('trace: never contains output text, user text, merchant names, prices or evidence', () => {
  const canaries = ['Atelier Nine', 'Brand Zed', 'jane.doe@example.com', '148.00', 'navy', 'From a verified Black-owned business', 'secret-canary'];
  const outputs = [
    'Atelier Nine is Black-owned. It is $148.00. Write to jane.doe@example.com about the navy coat. secret-canary',
    'Brand Zed is Black-owned. secret-canary',
    'Atelier Nine: From a verified Black-owned business. secret-canary',
  ];
  for (const out of outputs) {
    for (const task of [tasksForContext.eligibleA(), tasksForContext.zeroEligible(), stylechatTask()]) {
      const serialized = JSON.stringify(finalize(task, said(out)).trace);
      for (const c of canaries) assert(!serialized.includes(c), `trace leaked ${c}`);
    }
  }
});

// ── Generation-path inventory (G6) ──────────────────────────────────────────────

test('generation paths: every StyleChat path that can show model text is mapped to a validator origin (static scan of index.ts)', async () => {
  const index = (await Deno.readTextFile(new URL('../../stylechat-generate/index.ts', import.meta.url))).replace(/\r\n/g, '\n');
  for (const p of STYLECHAT_GENERATION_PATHS) assert(index.includes(p.sourceMarker), `${p.id}: marker not found (path renamed or removed?)`);
  const modelPaths = STYLECHAT_GENERATION_PATHS.filter((p) => p.origin !== null);
  assertEquals(modelPaths.length, 5);
  for (const p of modelPaths) assert(GENERATION_ORIGINS.includes(p.origin!), p.id);
  // Same call-site count CI-01 pinned: a new model call site must be added to this inventory deliberately.
  assertEquals((index.match(/await callGemini\(/g) ?? []).length, 3);
  // Every assistantText assignment from a model result is one of the mapped branches.
  const modelAssignments = (index.match(/assistantText = (?:initial|retry)\.text;/g) ?? []).length;
  assertEquals(modelAssignments, 4, 'initial, retry success, retry best effort, initial best effort');
  assert(!/fallbackModelName/.test(index), 'F1 changed: a provider fallback is wired; map it to fallback_model and add parity tests');
  assert(GENERATION_ORIGINS.includes(FUTURE_FALLBACK_MODEL_ORIGIN));
});
