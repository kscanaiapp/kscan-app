/**
 * K+ entitlement client. Server-authoritative -- this module only ever
 * reads the caller's own RLS-scoped user_entitlements row and invokes the
 * kplus-activate Edge Function. It never computes, extends, or invents an
 * entitlement locally.
 */
import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import {
  KPLUS_ENTITLEMENT_KEY,
  type KPlusEntitlementRow,
  type KPlusExternalSyncStatus,
} from '../../types/entitlements';

export type FetchKPlusStatusResult =
  | { ok: true; row: KPlusEntitlementRow | null }
  | { ok: false; reason: 'signed_out' | 'read_failed' };

export type ActivateKPlusResult =
  | { ok: true; row: KPlusEntitlementRow }
  | { ok: false; reason: 'signed_out' | 'session_expired' | 'request_failed' };

interface RawEntitlementRow {
  entitlement_key: string;
  status: string;
  grant_reason: string;
  campaign_key: string | null;
  granted_at: string;
  expires_at: string | null;
  external_sync_status: string;
}

function toEntitlementRow(raw: RawEntitlementRow): KPlusEntitlementRow {
  return {
    entitlementKey: raw.entitlement_key,
    status: raw.status as KPlusEntitlementRow['status'],
    grantReason: raw.grant_reason as KPlusEntitlementRow['grantReason'],
    campaignKey: raw.campaign_key,
    grantedAt: raw.granted_at,
    expiresAt: raw.expires_at,
    externalSyncStatus: raw.external_sync_status as KPlusExternalSyncStatus,
  };
}

/**
 * Reads the caller's own K+ row directly (RLS: `auth.uid() = user_id`).
 * Returns `row: null` when the user has never activated -- that is not an
 * error, it is the 'eligible' state.
 */
export async function fetchKPlusStatus(): Promise<FetchKPlusStatusResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user?.id) {
    return { ok: false, reason: 'signed_out' };
  }

  const { data, error } = await supabase
    .from('user_entitlements')
    .select('entitlement_key, status, grant_reason, campaign_key, granted_at, expires_at, external_sync_status')
    .eq('entitlement_key', KPLUS_ENTITLEMENT_KEY)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: 'read_failed' };
  }

  return { ok: true, row: data ? toEntitlementRow(data as RawEntitlementRow) : null };
}

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
      externalSyncStatus: data.externalSyncStatus ?? 'not_required',
    },
  };
}
