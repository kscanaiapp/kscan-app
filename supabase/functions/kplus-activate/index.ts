/**
 * K+ Early Access activation authority.
 *
 * POST only. JWT identity only -- the request body is never trusted for
 * user_id, tier, grant_reason, granted_at, expires_at, or any entitlement
 * field. The caller's identity is derived exclusively from the verified
 * Authorization bearer token (see requireUser), then handed to the
 * SECURITY DEFINER RPC grant_kplus_early_access, which is itself only
 * executable by service_role -- so even a compromised client can never
 * reach the mutation path directly, with any identity.
 *
 * Sequence (spec section 14):
 *   1. authenticate (JWT)
 *   2. atomically grant K+ in K Scan (grant_kplus_early_access RPC)
 *   3. commit entitlement (already durable once the RPC returns)
 *   4. attempt RevenueCat synchronization (best-effort, bounded)
 *   5. record sync status (set_kplus_revenuecat_sync_status RPC)
 *
 * A RevenueCat outage never rolls back or blocks a valid complimentary
 * grant -- external_sync_status is simply left pending/failed_retryable for
 * the reconciliation function (kplus-reconcile-revenuecat) to retry later.
 */
import {
  assertAccountActive,
  corsHeaders,
  isEligibleAccountActor,
  json,
  logEvent,
  requireUser,
  rpc,
  shortUserId,
} from '../_shared/deletion/common.ts';
import { syncPromotionalEntitlement } from '../_shared/revenuecat/revenueCatClient.ts';

interface GrantRow {
  entitlement_key: string;
  status: string;
  grant_reason: string;
  campaign_key: string | null;
  granted_at: string;
  expires_at: string | null;
  newly_granted: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let authUser;
  try {
    authUser = await requireUser(req);
  } catch (response) {
    if (response instanceof Response) return response;
    return json({ error: 'Authentication required' }, 401);
  }

  // SEC-KPLUS-005 — a verified JWT is not an eligible account.
  //
  // requireUser succeeds for an ANONYMOUS Supabase identity: it holds a valid
  // token and its own auth.uid(), so it could previously self-grant K+ and
  // thereby defeat K+ as the boundary that limits paid-provider work. K+ is an
  // account entitlement; an anonymous session is not an account.
  if (!isEligibleAccountActor(authUser)) {
    logEvent('kplus_activation_denied_ineligible_actor', {
      uid: shortUserId(authUser.id),
      reason: 'anonymous_identity',
    });
    return json({ error: 'K+ requires a K Scan AI account.', code: 'ACCOUNT_REQUIRED' }, 403);
  }

  // A deactivated / mid-deletion account must not receive new entitlements.
  // Throws a 403 ACCOUNT_DEACTIVATED Response, and fails closed if the lookup
  // itself fails.
  try {
    await assertAccountActive(authUser.id);
  } catch (response) {
    if (response instanceof Response) return response;
    return json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
  }

  const grantResponse = await rpc('grant_kplus_early_access', { p_user_id: authUser.id });
  if (!grantResponse.ok) {
    const detail = await grantResponse.text().catch(() => '');
    logEvent('kplus_activation_rpc_failed', {
      uid: shortUserId(authUser.id),
      status: grantResponse.status,
      detail: detail.slice(0, 200),
    });
    return json({ error: 'Activation failed. Please try again.' }, 502);
  }

  const rows = (await grantResponse.json()) as GrantRow[];
  const grant = Array.isArray(rows) ? rows[0] : undefined;
  if (!grant) {
    logEvent('kplus_activation_rpc_empty_result', { uid: shortUserId(authUser.id) });
    return json({ error: 'Activation failed. Please try again.' }, 502);
  }

  const campaignStatus = grant.newly_granted
    ? 'granted'
    : grant.expires_at && new Date(grant.expires_at) > new Date()
      ? 'already_active'
      : 'campaign_already_consumed';

  logEvent('kplus_activation_completed', {
    uid: shortUserId(authUser.id),
    campaignStatus,
  });

  // Best-effort RevenueCat mirror. Bounded (single attempt, 8s internal
  // timeout inside syncPromotionalEntitlement) -- never retried synchronously
  // and never allowed to change the HTTP response's success/failure.
  let syncStatus: string = 'not_required';
  if (grant.expires_at) {
    const outcome = await syncPromotionalEntitlement({
      appUserId: authUser.id,
      expiresAt: grant.expires_at,
    });
    syncStatus = outcome.status;
    const syncRpcResponse = await rpc('set_kplus_revenuecat_sync_status', {
      p_user_id: authUser.id,
      p_entitlement_key: grant.entitlement_key,
      p_status: syncStatus,
      p_external_customer_id: outcome.ok ? outcome.externalCustomerId : null,
    });
    if (!syncRpcResponse.ok) {
      logEvent('kplus_sync_status_write_failed', { uid: shortUserId(authUser.id) });
    }
  }

  return json({
    entitlementKey: grant.entitlement_key,
    status: grant.status,
    grantReason: grant.grant_reason,
    campaignKey: grant.campaign_key,
    campaignStatus,
    grantedAt: grant.granted_at,
    expiresAt: grant.expires_at,
    externalSyncStatus: syncStatus,
  });
});
