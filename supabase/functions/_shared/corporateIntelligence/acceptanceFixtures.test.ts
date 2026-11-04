/**
 * CI-01 acceptance-fixture runner. Offline: no provider, no network, no Supabase, zero billed calls.
 *
 * Every fixture carries an explicit expected result and an `assess` method. The runner also enforces corpus
 * hygiene so a case cannot be silently dropped or left without an expectation.
 */
import nodeAssert from 'node:assert/strict';
import test from 'node:test';
import { assembleStyleChatPrompt } from '../aiSecurity/styleChatPromptAssembly.ts';
import { ACTION_TRANSITIONS, isLegalTransition, parseActionProposalOffline, type ActionState } from './actionProposal.ts';
import { selectCommunicationMode } from './modeSelector.ts';
import { PROPOSED_FALLBACK_COPY, selectFallback, validateCorporateTaskV1 } from './contracts.ts';
import {
  checkActionAndPrivacyClaimsReference,
  checkOwnershipClaimsReference,
} from './testSupport/referenceOracle.ts';
import { applyMutations, baseValidProposal, baseValidTask, FIXTURE_NOW, type MutateOp } from './testSupport/baseTask.ts';
import { validateCorporateOutput } from './outputValidation.ts';
import { finalizeCorporateResponse } from './responseFinalizer.ts';
import { CI03_FIXTURE_CONTEXTS, CI03_NOW, stylechatTask, tasksForContext } from './testSupport/ci03Tasks.ts';

const assert = (cond: unknown, msg?: string) => nodeAssert.ok(cond, msg);
const assertEquals = (actual: unknown, expected: unknown, msg?: string) =>
  nodeAssert.deepEqual(actual, expected, msg);

type Fixture = Record<string, any> & { id: string; category: string; assess: string };
const corpus = JSON.parse(
  await Deno.readTextFile(new URL('./fixtures/ci01-acceptance-fixtures.json', import.meta.url)),
) as { clock: string; ownershipContexts: Record<string, any>; fixtures: Fixture[] };

const ASSESSORS = new Set([
  'contract_validator', 'reference_selector', 'reference_ownership', 'reference_claims',
  'proposal_parser', 'transition_table', 'real_aisecurity_assembly', 'reference_ownership_limits', 'fallback_selector',
  'production_output',
]);
// Floors only ever rise. CI-03 adds output_validation and raises task_contract for the R2 regressions.
const REQUIRED_CATEGORIES: Record<string, number> = {
  task_contract: 107, mode_selection: 8, ownership_integrity: 28, action_and_commitment: 7,
  sensitive_data: 4, option_c_proposal: 6, prompt_isolation: 4, oracle_limits: 11, fallback_policy: 9,
  output_validation: 24,
};
/**
 * Full-corpus pin (CI-03). The original-74 digest above stays the protected baseline; this one pins the complete
 * corpus (every case, inputs and expectations) so any edit to ANY case -- not only the original 74 -- is a reviewed diff.
 */
const CORPUS_CASE_COUNT = 215;
const CORPUS_FULL_SHA256 = '84387f7ba0951004bb88389ae322b332bf4789bf73800e570935dff63ef67198';

// The corpus-size requirement was deliberately raised from 50-75 to 120-220 by the Management Checkpoint 1
// directive (task-contract hardening). The original 74 CI-01 cases are pinned below and may not be weakened.
const ORIGINAL_CASE_COUNT = 74;
const ORIGINAL_EXPECTATIONS_SHA256 = 'ddc5aaec1bc37dc2a0ace5c2b9596c8f31430e7c544a7318fd7e27f5de7d90dd';
const CORPUS_MIN = 120;
const CORPUS_MAX = 220;

test('original 74-case corpus expectations are unchanged (digest pinned; hardening cases are additive)', async () => {
  const original = corpus.fixtures.filter((f) => !f.hardening);
  assertEquals(original.length, ORIGINAL_CASE_COUNT);
  const rows = original.map((f) => [
    f.id, f.assess, f.expectOk ?? null, f.expectErrors ?? null, f.expect ?? null,
    f.expectVerdict ?? null, f.expectReasonsInclude ?? null, f.expectLegal ?? null,
  ]);
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  assertEquals(digest, ORIGINAL_EXPECTATIONS_SHA256, 'an original expectation was changed, removed or weakened');
});

test('full corpus (all cases, inputs and expectations) is pinned; additions require a reviewed digest update', async () => {
  assertEquals(corpus.fixtures.length, CORPUS_CASE_COUNT);
  const bytes = new TextEncoder().encode(JSON.stringify(corpus.fixtures));
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  assertEquals(digest, CORPUS_FULL_SHA256, 'a fixture was added, removed or edited');
});

// ── CI-03: the PRODUCTION validator must reach the established verdict on every oracle-covered case ─────────────
// eligibleA / zeroEligible are rebuilt as REAL assembled tasks; action/privacy cases run on a StyleChat task.
// Oracle-limit cases are held to `requiredVerdict` (what the record-bound control must produce), not the oracle's.
for (const f of corpus.fixtures) {
  if (!['reference_ownership', 'reference_claims', 'reference_ownership_limits'].includes(f.assess)) continue;
  test(`production validator :: ${f.id}`, () => {
    const task = f.context ? (tasksForContext as Record<string, () => unknown>)[f.context]() : stylechatTask();
    const registry = { knownMerchantNames: f.context ? corpus.ownershipContexts[f.context].knownBrands : [] };
    const r = validateCorporateOutput({ task, candidate: { text: f.output }, registry, origin: 'primary_initial', now: CI03_NOW });
    const expected = f.assess === 'reference_ownership_limits' ? f.requiredVerdict : f.expectVerdict;
    assertEquals(r.verdict, expected, `${f.id}: ${JSON.stringify(r.failures)}`);
    // Every rejection of an ownership case is classified as an ownership-integrity failure (never a generic one).
    if (expected === 'reject' && f.category !== 'action_and_commitment' && f.category !== 'sensitive_data') {
      assert(['unsupported_ownership_claim', 'fabricated_merchant_recommendation'].includes(String(r.primaryFailure)), `${f.id}: ${r.primaryFailure}`);
    }
  });
}

test(`corpus hygiene: ${CORPUS_MIN}-${CORPUS_MAX} cases, unique ids, explicit expectation + known assessor on every case`, () => {
  const { fixtures } = corpus;
  assert(fixtures.length >= CORPUS_MIN && fixtures.length <= CORPUS_MAX, `fixture count ${fixtures.length} outside ${CORPUS_MIN}-${CORPUS_MAX}`);
  assertEquals(new Set(fixtures.map((f) => f.id)).size, fixtures.length, 'duplicate fixture ids');
  assertEquals(new Date(corpus.clock).getTime(), FIXTURE_NOW.getTime());
  for (const f of fixtures) {
    assert(ASSESSORS.has(f.assess), `${f.id}: unknown assessor ${f.assess}`);
    if (f.assess === 'real_aisecurity_assembly') continue; // property-based; no scalar expectation
    const hasExpectation = ['expectOk', 'expectErrors', 'expect', 'expectVerdict', 'expectLegal', 'requiredVerdict'].some((k) => k in f);
    assert(hasExpectation, `${f.id}: no explicit expected result`);
  }
  const counts: Record<string, number> = {};
  for (const f of fixtures) counts[f.category] = (counts[f.category] ?? 0) + 1;
  for (const [category, floor] of Object.entries(REQUIRED_CATEGORIES)) {
    assert((counts[category] ?? 0) >= floor, `category ${category} has ${counts[category] ?? 0} < floor ${floor}`);
  }
});

test('the ten required ownership scenarios are each represented', () => {
  const ids = corpus.fixtures.filter((f) => f.category === 'ownership_integrity').map((f) => f.id).join(' ');
  for (const needle of [
    'verified-eligible', 'unverified-merchant', 'expired-verification', 'revoked-verification',
    'stale-product', 'zero-eligible', 'injected-merchant-copy', 'false-assertion', 'misattributed',
    'fallback-model',
  ]) {
    assert(ids.includes(needle), `missing required ownership scenario: ${needle}`);
  }
});

for (const f of corpus.fixtures) {
  test(`${f.category} :: ${f.id}`, () => {
    switch (f.assess) {
      case 'contract_validator': {
        const task = applyMutations(baseValidTask(), f.mutate as MutateOp[]);
        const result = validateCorporateTaskV1(task, FIXTURE_NOW);
        if (f.expectOk) assertEquals(result.ok, true, JSON.stringify(result));
        else assertEquals(result.ok ? [] : result.errors, [...f.expectErrors].sort());
        break;
      }
      case 'reference_selector': {
        const result = selectCommunicationMode(f.state);
        assertEquals(result, f.expect);
        break;
      }
      case 'reference_ownership': {
        const result = checkOwnershipClaimsReference(f.output, corpus.ownershipContexts[f.context]);
        assertEquals(result.verdict, f.expectVerdict, JSON.stringify(result));
        if (f.expectReasonsInclude && result.verdict === 'reject') {
          for (const r of f.expectReasonsInclude) assert(result.reasons.includes(r), `${f.id}: missing reason ${r}: ${result.reasons}`);
        }
        break;
      }
      case 'reference_ownership_limits': {
        // Documents where regex-only checking is WRONG. The pinned oracle verdict is asserted so any change to the
        // oracle is a reviewed diff; requiredVerdict is what the production (record-bound) control must produce.
        const result = checkOwnershipClaimsReference(f.output, corpus.ownershipContexts[f.context]);
        assertEquals(result.verdict, f.oracleVerdict, `${f.id}: oracle verdict changed -- review the limitation note`);
        assert(typeof f.limitation === 'string' && f.limitation.length > 10, `${f.id}: limitation must be documented`);
        assert(typeof f.productionControl === 'string' && f.productionControl.length > 10, `${f.id}: production control must be named`);
        break;
      }
      case 'fallback_selector': {
        const fb = selectFallback(f.code, f.inventoryStatus);
        assertEquals(fb, f.expect);
        assert(fb.copyKey in PROPOSED_FALLBACK_COPY);
        break;
      }
      case 'reference_claims': {
        const result = checkActionAndPrivacyClaimsReference(f.output);
        assertEquals(result.verdict, f.expectVerdict, JSON.stringify(result));
        if (f.expectReasonsInclude && result.verdict === 'reject') {
          for (const r of f.expectReasonsInclude) assert(result.reasons.includes(r), `${f.id}: missing reason ${r}: ${result.reasons}`);
        }
        break;
      }
      case 'proposal_parser': {
        const proposal = applyMutations(baseValidProposal(), f.mutate as MutateOp[]);
        const result = parseActionProposalOffline(proposal, FIXTURE_NOW);
        if (f.expectOk) {
          assertEquals(result.ok, true, JSON.stringify(result));
          // Parsing never mutates state or implies execution.
          assertEquals((result as any).value.status, 'proposed');
        } else assertEquals(result.ok ? [] : result.errors, [...f.expectErrors].sort());
        break;
      }
      case 'transition_table': {
        for (const [from, to] of f.transitions as [ActionState, ActionState][]) {
          assertEquals(isLegalTransition(from, to), f.expectLegal, `${from} -> ${to}`);
        }
        assertEquals(ACTION_TRANSITIONS.confirmed.length, 0, 'confirmed must be terminal');
        break;
      }
      case 'real_aisecurity_assembly': {
        // Reuses the EXISTING aiSecurity envelope (not a new implementation) to prove untrusted text stays data.
        const inputFor = (payload: string) =>
          f.section === 'commerce_context'
            ? assembleStyleChatPrompt({ systemRules: 'Test rules.', userMessage: 'hello', commerceContext: payload })
            : assembleStyleChatPrompt({ systemRules: 'Test rules.', userMessage: payload });
        const hostile = inputFor(f.payload);
        const control = inputFor('');
        // 1. The trusted system side is independent of untrusted input.
        assertEquals(hostile.systemText, control.systemText, 'untrusted text changed the system side');
        // 2. It cannot forge trusted section boundaries.
        assertEquals(/<\/?(?:kscan_system_rules|trusted_server_context)\b/i.test(hostile.userEnvelopeText), false);
        // 3. It cannot close its own section early (exactly one open/close pair for the target section).
        const open = hostile.userEnvelopeText.match(new RegExp(`<${f.section}\\b`, 'g')) ?? [];
        const close = hostile.userEnvelopeText.match(new RegExp(`</${f.section}>`, 'g')) ?? [];
        assertEquals([open.length, close.length], [1, 1]);
        // 4. Rendered under an untrusted trust attribute.
        assert(/trust="untrusted_/.test(hostile.userEnvelopeText));
        assertEquals(hostile.ok, true);
        break;
      }
      case 'production_output': {
        const task = CI03_FIXTURE_CONTEXTS[f.context]();
        const registry = { knownMerchantNames: ['Atelier Nine', 'Brand Zed', 'Northline Studio'] };
        const r = validateCorporateOutput({ task, candidate: f.candidate, registry, origin: 'primary_initial', now: CI03_NOW });
        assertEquals(r.verdict, f.expectVerdict, `${f.id}: ${JSON.stringify(r.failures)}`);
        for (const d of f.expectDetailsInclude ?? []) assert(r.failures.some((x) => x.detail === d), `${f.id}: missing detail ${d}`);
        if (f.expectLabels) assertEquals(r.labels.map((l) => l.merchantRef), f.expectLabels);
        if (f.expectFinal) {
          const final = finalizeCorporateResponse({ task, origin: 'primary_initial', outcome: { kind: 'candidate', candidate: f.candidate }, registry, now: CI03_NOW });
          assertEquals(final.kind === 'deterministic' ? { reason: final.reason, copyKey: final.copyKey } : null, f.expectFinal);
          assertEquals(final.regenerate, false);
        }
        break;
      }
      default:
        throw new Error(`unhandled assessor ${f.assess}`);
    }
  });
}
