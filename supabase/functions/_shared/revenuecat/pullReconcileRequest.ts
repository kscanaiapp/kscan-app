/**
 * kplus-revenuecat-pull-reconcile request contract (pure; no I/O).
 *
 * The function is called by the signed-in member's app with the member's own
 * JWT. The body may carry only a trigger. Two rules matter for security:
 *
 *   - Actor injection: any field other than `trigger` / `force` is REFUSED,
 *     never silently ignored. The actor comes from the JWT alone.
 *   - Cooldown authority (B41 audit K-14): the per-user cooldown is a SERVER
 *     rule. A member's request can never bypass it, so `force: true` from this
 *     caller is refused (403) instead of being passed to the claim. `force`
 *     absent or `false` remains valid for compatibility.
 */

export const PULL_RECONCILE_TRIGGERS = ['post_purchase_unresolved', 'restore_unresolved', 'check_again'] as const;
export type PullReconcileTrigger = (typeof PULL_RECONCILE_TRIGGERS)[number];

export type PullReconcileRequest =
  | { ok: true; trigger: PullReconcileTrigger }
  | { ok: false; httpStatus: 400; status: 'malformed_request' }
  | { ok: false; httpStatus: 403; status: 'force_not_permitted' };

const MALFORMED: PullReconcileRequest = { ok: false, httpStatus: 400, status: 'malformed_request' };

export function parsePullReconcileRequest(body: unknown): PullReconcileRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return MALFORMED;
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'trigger' && key !== 'force')) return MALFORMED;
  const trigger = input.trigger === undefined ? 'check_again' : input.trigger;
  if (typeof trigger !== 'string' || !(PULL_RECONCILE_TRIGGERS as readonly string[]).includes(trigger)) return MALFORMED;
  if (input.force !== undefined && typeof input.force !== 'boolean') return MALFORMED;
  if (input.force === true) return { ok: false, httpStatus: 403, status: 'force_not_permitted' };
  return { ok: true, trigger: trigger as PullReconcileTrigger };
}
