/**
 * B41 restricted sandbox REVIEW access -- the one shared definition of the
 * switch and the database entry points used by BOTH the webhook (admission of
 * a delivered event) and the pull reconciler (missed-webhook recovery).
 *
 * The switch is a kill switch, not an authorization: even when on, nothing is
 * admitted unless the database holds an active, operator-created authorization
 * for the exact K Scan account, and the canonical resolver independently
 * denies sandbox access the instant that authorization is inactive.
 *
 * Pure constants and predicates; no I/O, no imports.
 */

/** Only the exact value 'true' enables review handling. Default: off. */
export const KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED_ENV = 'KPLUS_REVENUECAT_SANDBOX_REVIEW_ENABLED' as const;

/** Webhook: is this exact account admitted for one verified sandbox event right now? */
export const KPLUS_SANDBOX_REVIEW_ADMIT_RPC = 'kplus_sandbox_review_admit_event' as const;

/** Pull reconciler: open a SANDBOX provider claim only for an active authorization. */
export const KPLUS_SANDBOX_REVIEW_RECONCILE_CLAIM_RPC = 'claim_kplus_sandbox_review_reconciliation' as const;

export function sandboxReviewSwitchOn(value: string | null | undefined): boolean {
  return value === 'true';
}

/**
 * Review handling only ever applies where sandbox is NOT the deployment's own
 * environment. A deployment that natively serves sandbox (Staging) already
 * processes sandbox normally and must never route through review admission.
 */
export function sandboxReviewApplies(
  nativeEnvironmentIncludesSandbox: boolean,
  switchValue: string | null | undefined,
): boolean {
  return !nativeEnvironmentIncludesSandbox && sandboxReviewSwitchOn(switchValue);
}
