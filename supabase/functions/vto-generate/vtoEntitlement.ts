/**
 * Server-side K+ authority for VTO.
 *
 * Delegates the entire decision to the canonical K+ predicate. VTO does not
 * inspect grant rows or care whether access came from complimentary, trial,
 * subscription, lifetime, promotional, employee, or manual-support access.
 * There is no VTO-specific premium state and no second entitlement resolver.
 *
 * The user id comes from requireUser()'s verified JWT. A body-supplied
 * user_id never reaches this function.
 *
 * FAILS CLOSED, and distinguishes two closures that must not be conflated:
 *   - `denied`  -- we read the row and the user genuinely has no active K+.
 *   - `unknown` -- we could not read it. The user is still denied, but they
 *                  are told the check failed rather than being told to buy
 *                  something they may already own.
 */

import { rpc } from '../_shared/deletion/common.ts';

export const KPLUS_ENTITLEMENT_KEY = 'k_plus';

export type VtoEntitlementOutcome =
  | { state: 'active' }
  | { state: 'denied' }
  | { state: 'unknown' };

type Rpc = (fnName: string, body: Record<string, unknown>) => Promise<Response>;

/**
 * Resolve K+ for VTO by DELEGATING to the canonical authority.
 *
 * public.kplus_has_active_entitlement resolves the union of every recognized
 * grant family. Asking it directly means VTO inherits new canonical grant
 * families without teaching this module about their storage or lifecycle.
 * It also preserves the distinction between:
 *   - `denied`  -- read successfully, the user genuinely has no active K+.
 *   - `unknown` -- could not read. Still denied, but the user is told the check
 *                  failed rather than told to buy something they may own.
 */
export async function resolveVtoEntitlement(
  userId: string,
  deps?: { rpc?: Rpc },
): Promise<VtoEntitlementOutcome> {
  const call = deps?.rpc ?? rpc;

  try {
    const response = await call('kplus_has_active_entitlement', {
      p_user_id: userId,
      p_entitlement_key: KPLUS_ENTITLEMENT_KEY,
    });
    if (!response.ok) return { state: 'unknown' };
    const value = await response.json();
    if (value === true) return { state: 'active' };
    if (value === false) return { state: 'denied' };
    return { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}
