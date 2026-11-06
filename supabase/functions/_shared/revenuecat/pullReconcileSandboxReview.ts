/**
 * kplus-revenuecat-pull-reconcile: B41 sandbox REVIEW recovery pass (pure; all
 * I/O injected).
 *
 * Problem it closes: on a deployment whose reconciler serves PRODUCTION
 * provider state, an authorized App Review / Play review purchase is SANDBOX.
 * If its webhook is delayed or lost, nothing could ever recover it.
 *
 * Contract (security):
 *   - The account is the JWT subject the Edge Function already resolved; this
 *     module never sees request input. The provider environment is fixed to
 *     'sandbox' here and is never client-selected.
 *   - The pass runs only after the deployment's normal pass completed
 *     successfully, and only under the shared review switch on a
 *     production-configured deployment (see sandboxReviewReconcileApplies).
 *   - The database decides authorization AND opens the claim in one
 *     transaction (claim_kplus_sandbox_review_reconciliation). Its claim is the
 *     existing per-(user, environment) lease + cooldown with force disabled.
 *   - Recovery reuses the existing canonical reconciliation (ownership,
 *     idempotency, ordering) unchanged; nothing here grants access. The client
 *     still rereads the canonical summary, and the canonical resolver itself
 *     denies sandbox access once the authorization is inactive.
 *   - Any unexpected answer fails closed (retryable 503), never "success".
 */
import type { ReconciliationOutcome } from './revenueCatProviderReconciliation.ts';
import { sandboxReviewApplies } from './revenueCatSandboxReview.ts';

export type FinishOutcome =
  | 'resolved'
  | 'no_drift'
  | 'unresolved_drift'
  | 'provider_unavailable'
  | 'provider_throttled'
  | 'rejected'
  | 'transition_failed';

export interface PullReconcileHttpResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

export type SandboxReviewPass =
  | { kind: 'not_authorized' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' }
  | { kind: 'reconciled'; outcome: ReconciliationOutcome };

export interface SandboxReviewPassDeps {
  /** claim_kplus_sandbox_review_reconciliation for the JWT subject. */
  claim: () => Promise<{ ok: boolean; body: unknown }>;
  /** The existing canonical reconciliation, pinned to environment 'sandbox'. */
  reconcile: () => Promise<ReconciliationOutcome>;
  /** finish_kplus_provider_reconciliation for the sandbox claim. */
  finish: (claimToken: string, outcome: FinishOutcome) => Promise<unknown>;
}

/** Only a production-configured reconciler, and only with the switch on. */
export function sandboxReviewReconcileApplies(
  configuredEnvironment: 'production' | 'sandbox',
  switchValue: string | null | undefined,
): boolean {
  return configuredEnvironment === 'production' && sandboxReviewApplies(false, switchValue);
}

/** The existing outcome -> finish-row mapping, unchanged. */
export function finishOutcomeFor(result: ReconciliationOutcome): FinishOutcome {
  if (result.status === 'provider_unavailable' || result.status === 'provider_malformed') return 'provider_unavailable';
  if (result.status === 'provider_throttled') return 'provider_throttled';
  if (result.status === 'canonical_transition_failed') return 'transition_failed';
  if (result.status === 'ownership_conflict') return 'rejected';
  if (result.unresolvedDrift > 0) return 'unresolved_drift';
  return result.transitions.applied > 0 ? 'resolved' : 'no_drift';
}

/** The existing outcome -> HTTP mapping, unchanged. */
export function reconciliationHttpResponse(result: ReconciliationOutcome): PullReconcileHttpResponse {
  const body = result as unknown as Record<string, unknown>;
  if (result.status === 'provider_throttled') return { httpStatus: 429, body };
  if (result.status === 'provider_unavailable' || result.status === 'canonical_transition_failed') return { httpStatus: 503, body };
  if (result.status === 'provider_malformed') return { httpStatus: 502, body };
  if (result.status === 'ownership_conflict') return { httpStatus: 409, body };
  return { httpStatus: 200, body };
}

const UNAVAILABLE: SandboxReviewPass = { kind: 'unavailable' };

export async function runSandboxReviewReconcilePass(deps: SandboxReviewPassDeps): Promise<SandboxReviewPass> {
  let response: { ok: boolean; body: unknown };
  try {
    response = await deps.claim();
  } catch {
    return UNAVAILABLE;
  }
  const claim = response?.body as { classification?: unknown; claimToken?: unknown; retryAfterSeconds?: unknown } | null;
  if (!response?.ok || !claim || typeof claim !== 'object' || typeof claim.classification !== 'string') return UNAVAILABLE;

  switch (claim.classification) {
    case 'not_authorized':
    // The existing claim's own refusals (unknown / anonymous identity): there is
    // nothing to recover for this actor; the normal pass already answered.
    case 'rejected':
      return { kind: 'not_authorized' };
    case 'in_flight':
    case 'cooldown': {
      const retry = claim.retryAfterSeconds;
      return {
        kind: 'rate_limited',
        retryAfterSeconds: typeof retry === 'number' && Number.isInteger(retry) && retry >= 1 ? retry : 30,
      };
    }
    case 'claimed':
      break;
    default:
      return UNAVAILABLE;
  }
  if (typeof claim.claimToken !== 'string' || !claim.claimToken) return UNAVAILABLE;

  const claimToken = claim.claimToken;
  let finish: FinishOutcome = 'transition_failed';
  try {
    const outcome = await deps.reconcile();
    finish = finishOutcomeFor(outcome);
    return { kind: 'reconciled', outcome };
  } catch {
    return UNAVAILABLE;
  } finally {
    try { await deps.finish(claimToken, finish); } catch { /* lease expires on its own */ }
  }
}

/**
 * Final answer after the normal pass `primary` succeeded ('reconciled') and the
 * review pass ran. Shapes stay within the existing response contract.
 */
export function finalizeWithSandboxReviewPass(
  primary: ReconciliationOutcome,
  pass: SandboxReviewPass,
): PullReconcileHttpResponse {
  if (pass.kind === 'not_authorized') return reconciliationHttpResponse(primary);
  if (pass.kind === 'rate_limited') {
    return { httpStatus: 429, body: { status: 'rate_limited', retryAfterSeconds: pass.retryAfterSeconds } };
  }
  if (pass.kind === 'unavailable') {
    return { httpStatus: 503, body: { status: 'canonical_transition_failed', retryable: true } };
  }
  const review = pass.outcome;
  if (primary.status !== 'reconciled' || review.status !== 'reconciled') return reconciliationHttpResponse(review.status !== 'reconciled' ? review : primary);
  const merged: ReconciliationOutcome = {
    status: 'reconciled',
    transitions: {
      applied: primary.transitions.applied + review.transitions.applied,
      duplicate: primary.transitions.duplicate + review.transitions.duplicate,
      stale: primary.transitions.stale + review.transitions.stale,
      rejected: primary.transitions.rejected + review.transitions.rejected,
    },
    unresolvedDrift: primary.unresolvedDrift + review.unresolvedDrift,
    canonicalRefreshRequired: true,
  };
  return reconciliationHttpResponse(merged);
}
