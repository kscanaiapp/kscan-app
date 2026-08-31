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

import { rest, rpc } from '../_shared/deletion/common.ts';

export const KPLUS_ENTITLEMENT_KEY = 'k_plus';

export type VtoEntitlementOutcome =
  | { state: 'active' }
  | { state: 'denied' }
  | { state: 'unknown' };

interface EntitlementRow {
  status?: unknown;
  expires_at?: unknown;
  revoked_at?: unknown;
}

/**
 * CANONICAL K+ semantics (SEC-KPLUS-003).
 *
 * This must agree, field for field, with public.kplus_has_active_entitlement:
 *
 *     status = 'active'
 *     and revoked_at is null
 *     and expires_at is not null
 *     and expires_at > now()
 *
 * The previous implementation forked from that in TWO ways, both of which
 * granted access the canonical authority denies:
 *
 *   1. A null/absent expires_at was treated as a legitimate non-expiring grant.
 *      Canonical K+ has no such concept -- `expires_at is not null` is required.
 *   2. revoked_at was not consulted at all, so a REVOKED grant still read as
 *      active for VTO.
 *
 * Kept only as the local fallback for when the canonical RPC is unavailable;
 * resolveVtoEntitlement prefers the RPC itself so there is one authority, not a
 * copy that can drift again.
 */
export function isEntitlementRowActive(row: EntitlementRow | null | undefined, nowMs: number): boolean {
  if (!row || row.status !== 'active') return false;
  // A revoked grant is not access, whatever its status column says.
  if (row.revoked_at !== null && row.revoked_at !== undefined) return false;
  // No expiry is NOT a permanent grant -- it is an unusable row. Fail closed.
  if (typeof row.expires_at !== 'string' || !row.expires_at.trim()) return false;
  const expiry = new Date(row.expires_at).getTime();
  return Number.isFinite(expiry) && expiry > nowMs;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

type Rpc = (fnName: string, body: Record<string, unknown>) => Promise<Response>;

/**
 * Resolve K+ for VTO by DELEGATING to the canonical authority.
 *
 * public.kplus_has_active_entitlement is the same predicate every other K+
 * surface uses (Watchlist refresh, Closet RLS, Packing). Asking it directly
 * means VTO cannot drift from canonical semantics again, which is exactly how
 * SEC-KPLUS-003 happened.
 *
 * The REST read is retained only as a fallback for when the RPC is unavailable,
 * and it now applies the canonical rule too. Both paths still distinguish:
 *   - `denied`  -- read successfully, the user genuinely has no active K+.
 *   - `unknown` -- could not read. Still denied, but the user is told the check
 *                  failed rather than told to buy something they may own.
 */
export async function resolveVtoEntitlement(
  userId: string,
  deps?: { rest?: Fetcher; rpc?: Rpc; nowMs?: number },
): Promise<VtoEntitlementOutcome> {
  const read = deps?.rest ?? rest;
  const call = deps?.rpc ?? rpc;
  const nowMs = deps?.nowMs ?? Date.now();

  // 1 — canonical authority.
  try {
    const response = await call('kplus_has_active_entitlement', {
      p_user_id: userId,
      p_entitlement_key: KPLUS_ENTITLEMENT_KEY,
    });
    if (response.ok) {
      const value = await response.json();
      if (value === true) return { state: 'active' };
      if (value === false) return { state: 'denied' };
      return { state: 'unknown' };
    }
  } catch {
    // fall through to the direct read
  }

  // 2 — fallback read, using the SAME rule as the RPC.
  try {
    const response = await read(
      `user_entitlements?user_id=eq.${encodeURIComponent(userId)}`
        + `&entitlement_key=eq.${KPLUS_ENTITLEMENT_KEY}`
        + '&select=status,expires_at,revoked_at&limit=1',
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
