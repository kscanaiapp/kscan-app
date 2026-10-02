/**
 * K+ Early Access activation client. Server-authoritative -- this module only
 * invokes the kplus-activate Edge Function. It never computes, extends, or
 * invents an entitlement locally.
 *
 * It does NOT read entitlement state. Since Build 35 Phase A the one reader is
 * services/kplus/kplusEntitlementReader.ts (get_my_kplus_entitlement_summary),
 * which sees every grant the server holds; the Build 34 direct read of the
 * caller's user_entitlements row was removed because it could only see the
 * legacy complimentary row.
 */
import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import type { KPlusEntitlementRow } from '../../types/entitlements';

export type ActivateKPlusResult =
  | { ok: true; row: KPlusEntitlementRow }
  | { ok: false; reason: 'signed_out' | 'session_expired' | 'request_failed' };

/**
 * Calls the kplus-activate Edge Function. The server derives identity from
 * the caller's JWT and returns the resulting grant (new or pre-existing --
 * see the RPC's idempotency contract). Never sends any grant field.
 */
export async function activateKPlusEarlyAccess(): Promise<ActivateKPlusResult> {
  const session = await resolveAuthenticatedFunctionSession();
  if (session.ok === false) {
    return { ok: false, reason: session.reason };
  }

  const { data, error } = await supabase.functions.invoke('kplus-activate', {
    body: {},
  });

  if (error || !data?.entitlementKey) {
    return { ok: false, reason: 'request_failed' };
  }

  return {
    ok: true,
    row: {
      entitlementKey: data.entitlementKey,
      status: data.status,
      grantReason: data.grantReason,
      campaignKey: data.campaignKey ?? null,
      grantedAt: data.grantedAt,
      expiresAt: data.expiresAt ?? null,
      // The activation endpoint does not return revoked_at; a null here means
      // "not reported by this response", and the next status read supplies it.
      revokedAt: data.revokedAt ?? null,
      externalSyncStatus: data.externalSyncStatus ?? 'not_required',
    },
  };
}
