/**
 * Server-side K+ authority for VTO.
 *
 * Reads the SAME row the rest of K Scan treats as truth --
 * public.user_entitlements, entitlement_key 'k_plus', written only by the
 * SECURITY DEFINER grant RPCs (see the B34 K+ Foundation migration). This
 * module does not define a second notion of premium: there is no vto_paid,
 * no premium_vto, no VTO product, and no new table. Complimentary, staff,
 * admin, promo, trial and paid grants all resolve here identically, because
 * they are all just rows in that table.
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

import { rest } from '../_shared/deletion/common.ts';

export const KPLUS_ENTITLEMENT_KEY = 'k_plus';

export type VtoEntitlementOutcome =
  | { state: 'active' }
  | { state: 'denied' }
  | { state: 'unknown' };

interface EntitlementRow {
  status?: unknown;
  expires_at?: unknown;
}

/** Active means BOTH the stored status is active AND the grant has not
 *  expired. A row left 'active' past its expiry is not access -- the same
 *  local re-derivation the client performs, applied where it is enforceable. */
export function isEntitlementRowActive(row: EntitlementRow | null | undefined, nowMs: number): boolean {
  if (!row || row.status !== 'active') return false;
  if (typeof row.expires_at !== 'string' || !row.expires_at.trim()) {
    // A non-expiring active grant (staff/admin) is legitimate.
    return row.expires_at === null || row.expires_at === undefined;
  }
  const expiry = new Date(row.expires_at).getTime();
  return Number.isFinite(expiry) && expiry > nowMs;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export async function resolveVtoEntitlement(
  userId: string,
  deps?: { rest?: Fetcher; nowMs?: number },
): Promise<VtoEntitlementOutcome> {
  const read = deps?.rest ?? rest;
  const nowMs = deps?.nowMs ?? Date.now();
  try {
    const response = await read(
      `user_entitlements?user_id=eq.${encodeURIComponent(userId)}`
        + `&entitlement_key=eq.${KPLUS_ENTITLEMENT_KEY}`
        + '&select=status,expires_at&limit=1',
      { method: 'GET' },
    );
    if (!response.ok) return { state: 'unknown' };
    const rows = await response.json();
    if (!Array.isArray(rows)) return { state: 'unknown' };
    const row = rows[0] as EntitlementRow | undefined;
    return isEntitlementRowActive(row, nowMs) ? { state: 'active' } : { state: 'denied' };
  } catch {
    return { state: 'unknown' };
  }
}
