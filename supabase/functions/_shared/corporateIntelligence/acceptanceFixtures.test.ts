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
import { validateCorporateTaskV1 } from './contracts.ts';
import {
  checkActionAndPrivacyClaimsReference,
  checkOwnershipClaimsReference,
  selectModeReference,
} from './testSupport/referenceOracle.ts';
import { applyMutations, baseValidProposal, baseValidTask, FIXTURE_NOW, type MutateOp } from './testSupport/baseTask.ts';

const assert = (cond: unknown, msg?: string) => nodeAssert.ok(cond, msg);
const assertEquals = (actual: unknown, expected: unknown, msg?: string) =>
  nodeAssert.deepEqual(actual, expected, msg);

type Fixture = Record<string, any> & { id: string; category: string; assess: string };
const corpus = JSON.parse(
  await Deno.readTextFile(new URL('./fixtures/ci01-acceptance-fixtures.json', import.meta.url)),
) as { clock: string; ownershipContexts: Record<string, any>; fixtures: Fixture[] };

const ASSESSORS = new Set([
  'contract_validator', 'reference_selector', 'reference_ownership', 'reference_claims',
  'proposal_parser', 'transition_table', 'real_aisecurity_assembly',
]);
const REQUIRED_CATEGORIES: Record<string, number> = {
  task_contract: 15, mode_selection: 8, ownership_integrity: 14, action_and_commitment: 5,
  sensitive_data: 3, option_c_proposal: 6, prompt_isolation: 4,
};

test('corpus hygiene: 50-75 cases, unique ids, explicit expectation + known assessor on every case', () => {
  const { fixtures } = corpus;
  assert(fixtures.length >= 50 && fixtures.length <= 75, `fixture count ${fixtures.length} outside 50-75`);
  assertEquals(new Set(fixtures.map((f) => f.id)).size, fixtures.length, 'duplicate fixture ids');
  assertEquals(new Date(corpus.clock).getTime(), FIXTURE_NOW.getTime());
  for (const f of fixtures) {
    assert(ASSESSORS.has(f.assess), `${f.id}: unknown assessor ${f.assess}`);
    if (f.assess === 'real_aisecurity_assembly') continue; // property-based; no scalar expectation
    const hasExpectation = ['expectOk', 'expectErrors', 'expect', 'expectVerdict', 'expectLegal'].some((k) => k in f);
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
        const result = selectModeReference(f.state);
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
      default:
        throw new Error(`unhandled assessor ${f.assess}`);
    }
  });
}
