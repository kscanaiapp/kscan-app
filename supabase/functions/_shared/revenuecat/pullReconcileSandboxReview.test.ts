// B41 Repair C -- sandbox REVIEW missed-webhook recovery in
// kplus-revenuecat-pull-reconcile. Pure-orchestration negative matrix plus
// static wiring checks on the Edge entry point.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  finalizeWithSandboxReviewPass,
  finishOutcomeFor,
  reconciliationHttpResponse,
  runSandboxReviewReconcilePass,
  sandboxReviewReconcileApplies,
  type FinishOutcome,
} from './pullReconcileSandboxReview.ts';
import type { ReconciliationOutcome } from './revenueCatProviderReconciliation.ts';
import { sandboxReviewApplies, sandboxReviewSwitchOn } from './revenueCatSandboxReview.ts';

Deno.test('shared switch: review handling never applies where sandbox is the native environment', () => {
  assertEquals(sandboxReviewApplies(false, 'true'), true);
  assertEquals(sandboxReviewApplies(true, 'true'), false, 'Staging: sandbox-native deployments never route through review');
  assertEquals(sandboxReviewApplies(false, 'True'), false);
  assertEquals(sandboxReviewSwitchOn('true'), true);
  for (const v of [null, undefined, '', 'TRUE', ' true', 'true ', '1', 'yes']) assertEquals(sandboxReviewSwitchOn(v), false, String(v));
});

const reconciled = (applied = 0, unresolvedDrift = 0): ReconciliationOutcome => ({
  status: 'reconciled',
  transitions: { applied, duplicate: 0, stale: 0, rejected: 0 },
  unresolvedDrift,
  canonicalRefreshRequired: true,
});
const TOKEN = '0b0c4e7e-8a8e-4c55-9a51-0f6f2f1c9a10';

async function pass(opts: {
  claim?: () => Promise<{ ok: boolean; body: unknown }>;
  reconcile?: () => Promise<ReconciliationOutcome>;
}) {
  const calls = { claim: 0, reconcile: 0, finish: [] as [string, FinishOutcome][] };
  const result = await runSandboxReviewReconcilePass({
    claim: async () => {
      calls.claim += 1;
      return opts.claim ? opts.claim() : { ok: true, body: { classification: 'claimed', claimToken: TOKEN } };
    },
    reconcile: async () => {
      calls.reconcile += 1;
      return opts.reconcile ? opts.reconcile() : reconciled(1);
    },
    finish: async (token, outcome) => { calls.finish.push([token, outcome]); },
  });
  return { result, calls };
}

Deno.test('C: applies only to a production-configured reconciler with the switch exactly "true"', () => {
  assertEquals(sandboxReviewReconcileApplies('production', 'true'), true);
  for (const v of [null, undefined, '', 'false', 'TRUE', '1', ' true']) {
    assertEquals(sandboxReviewReconcileApplies('production', v), false, String(v));
  }
  assertEquals(sandboxReviewReconcileApplies('sandbox', 'true'), false, 'Staging (sandbox-native) never runs a review pass');
});

Deno.test('C: an account without an active authorization keeps the exact normal answer; nothing else runs', async () => {
  for (const classification of ['not_authorized', 'rejected']) {
    const { result, calls } = await pass({ claim: async () => ({ ok: true, body: { classification } }) });
    assertEquals(result, { kind: 'not_authorized' });
    assertEquals([calls.reconcile, calls.finish.length], [0, 0]);
    const primary = reconciled(0);
    assertEquals(finalizeWithSandboxReviewPass(primary, result), reconciliationHttpResponse(primary));
  }
});

Deno.test('C: an authorized account recovers through the canonical reconciliation and releases its own lease', async () => {
  const { result, calls } = await pass({ reconcile: async () => reconciled(1) });
  assertEquals(result.kind, 'reconciled');
  assertEquals(calls.reconcile, 1);
  assertEquals(calls.finish, [[TOKEN, 'resolved']]);
  const final = finalizeWithSandboxReviewPass(reconciled(0), result);
  assertEquals(final.httpStatus, 200);
  assertEquals(final.body, reconciled(1) as unknown as Record<string, unknown>, 'counts merge into the existing response shape');
});

Deno.test('C: merged counts add both passes and never hide unresolved drift', async () => {
  const { result } = await pass({ reconcile: async () => reconciled(2, 1) });
  const final = finalizeWithSandboxReviewPass(reconciled(1, 0), result);
  assertEquals((final.body.transitions as { applied: number }).applied, 3);
  assertEquals(final.body.unresolvedDrift, 1);
});

Deno.test('C: cooldown / in-flight is a 429 with the server retry hint -- there is no way to force past it', async () => {
  for (const classification of ['cooldown', 'in_flight']) {
    const { result, calls } = await pass({ claim: async () => ({ ok: true, body: { classification, retryAfterSeconds: 217 } }) });
    assertEquals(result, { kind: 'rate_limited', retryAfterSeconds: 217 });
    assertEquals([calls.reconcile, calls.finish.length], [0, 0]);
    assertEquals(finalizeWithSandboxReviewPass(reconciled(), result), {
      httpStatus: 429, body: { status: 'rate_limited', retryAfterSeconds: 217 },
    });
  }
  for (const bad of [0, -5, 1.5, '60', null]) {
    const { result } = await pass({ claim: async () => ({ ok: true, body: { classification: 'cooldown', retryAfterSeconds: bad } }) });
    assertEquals(result, { kind: 'rate_limited', retryAfterSeconds: 30 }, String(bad));
  }
});

Deno.test('C: any unexpected claim answer fails closed (503 retryable), never success and never a provider call', async () => {
  const answers: (() => Promise<{ ok: boolean; body: unknown }>)[] = [
    async () => { throw new Error('db down'); },
    async () => ({ ok: false, body: { classification: 'claimed', claimToken: TOKEN } }),
    async () => ({ ok: true, body: null }),
    async () => ({ ok: true, body: 'claimed' }),
    async () => ({ ok: true, body: { classification: 'granted' } }),
    async () => ({ ok: true, body: { classification: 'claimed' } }),
    async () => ({ ok: true, body: { classification: 'claimed', claimToken: 42 } }),
    async () => ({ ok: true, body: { classification: 'claimed', claimToken: '' } }),
  ];
  for (const claim of answers) {
    const { result, calls } = await pass({ claim });
    assertEquals(result, { kind: 'unavailable' });
    assertEquals(calls.reconcile, 0);
    assertEquals(finalizeWithSandboxReviewPass(reconciled(), result), {
      httpStatus: 503, body: { status: 'canonical_transition_failed', retryable: true },
    });
  }
});

Deno.test('C: a failed recovery surfaces its real status and records the failure on the lease', async () => {
  const cases: [ReconciliationOutcome, number, FinishOutcome][] = [
    [{ status: 'provider_throttled', retryAfterSeconds: 9 }, 429, 'provider_throttled'],
    [{ status: 'provider_unavailable', retryable: true }, 503, 'provider_unavailable'],
    [{ status: 'provider_malformed', retryable: false }, 502, 'provider_unavailable'],
    [{ status: 'canonical_transition_failed', retryable: true }, 503, 'transition_failed'],
    [{ status: 'ownership_conflict', canonicalRefreshRequired: true }, 409, 'rejected'],
  ];
  for (const [outcome, http, finish] of cases) {
    const { result, calls } = await pass({ reconcile: async () => outcome });
    assertEquals(calls.finish, [[TOKEN, finish]]);
    assertEquals(finalizeWithSandboxReviewPass(reconciled(), result).httpStatus, http, outcome.status);
  }
  const thrown = await pass({ reconcile: async () => { throw new Error('boom'); } });
  assertEquals(thrown.result, { kind: 'unavailable' });
  assertEquals(thrown.calls.finish, [[TOKEN, 'transition_failed']]);
});

Deno.test('C: the extracted HTTP / finish mappings are the pre-B41 mappings', () => {
  assertEquals(reconciliationHttpResponse(reconciled()).httpStatus, 200);
  assertEquals(reconciliationHttpResponse({ status: 'provider_throttled', retryAfterSeconds: 1 }).httpStatus, 429);
  assertEquals(reconciliationHttpResponse({ status: 'provider_unavailable', retryable: true }).httpStatus, 503);
  assertEquals(reconciliationHttpResponse({ status: 'canonical_transition_failed', retryable: true }).httpStatus, 503);
  assertEquals(reconciliationHttpResponse({ status: 'provider_malformed', retryable: false }).httpStatus, 502);
  assertEquals(reconciliationHttpResponse({ status: 'ownership_conflict', canonicalRefreshRequired: true }).httpStatus, 409);
  assertEquals(finishOutcomeFor(reconciled(0, 0)), 'no_drift');
  assertEquals(finishOutcomeFor(reconciled(1, 0)), 'resolved');
  assertEquals(finishOutcomeFor(reconciled(1, 1)), 'unresolved_drift');
});

// Static wiring checks on the Edge entry point (comments stripped first so an
// explanatory comment can never satisfy an assertion).
const ENTRY = new URL('../../kplus-revenuecat-pull-reconcile/index.ts', import.meta.url);
const code = (await Deno.readTextFile(ENTRY)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

Deno.test('C wiring: the review claim carries only the JWT subject and server config -- no environment, no force', () => {
  const m = code.match(/KPLUS_SANDBOX_REVIEW_RECONCILE_CLAIM_RPC,\s*\{([^}]*)\}/);
  assert(m, 'review claim call present');
  const keys = [...m[1].matchAll(/(p_[a-z_]+):/g)].map((x) => x[1]).sort();
  assertEquals(keys, ['p_cooldown_seconds', 'p_lease_seconds', 'p_user_id']);
  assert(/p_user_id:\s*user\.id/.test(m[1]), 'account is the authenticated user');
  assert(/p_force:\s*false/.test(code), 'the normal claim pins force off');
  assert(!/p_force:\s*(true|force|parsed|body|input)/.test(code), 'the normal claim never forwards a client force');
});

Deno.test('C wiring: the review pass is gated by a successful normal pass and the shared switch, and is pinned to sandbox', () => {
  const gate = code.indexOf("result.status !== 'reconciled'");
  const run = code.indexOf('runSandboxReviewReconcilePass(');
  assert(gate > 0 && run > gate, 'review pass only after the normal pass and its gate');
  assert(/sandboxReviewReconcileApplies\(environment,\s*env\(KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED_ENV\)\)/.test(code));
  assert(/reconcile:\s*\(\)\s*=>\s*reconcileIn\('sandbox'\)/.test(code), 'recovery environment is a server literal');
  assert(/p_environment:\s*'sandbox'/.test(code), 'the sandbox lease is released in the sandbox environment');
  assert(!/searchParams\.get|body\.environment|input\.environment/.test(code), 'no client-selected environment');
});
