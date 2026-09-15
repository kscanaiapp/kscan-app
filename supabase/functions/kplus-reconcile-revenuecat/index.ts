/**
 * Bounded RevenueCat reconciliation sweep for K+ entitlements whose sync
 * status is pending/failed_retryable (e.g. RevenueCat was down when the
 * user activated). Not user-facing -- invoked by the owner or a scheduled
 * job with the deletion-worker-style internal secret, never by a client.
 *
 * No unbounded loop: processes at most one bounded batch
 * (list_kplus_pending_revenuecat_sync's own internal cap of 200) per
 * invocation and returns. Re-invoke on whatever cadence the owner wants
 * (manual, or a future scheduled trigger) -- this function itself never
 * self-schedules or retries beyond a single pass per row.
 *
 * SEC-KPLUS-008 (reconcile path): list_kplus_pending_revenuecat_sync selects
 * on external_sync_status alone -- it never looks at status, revoked_at or
 * expires_at. A K Scan AI K+ Early Access row revoked by an operator keeps its
 * future expires_at, so while its sync status was still pending this sweep
 * mirrored it into RevenueCat as a LIVE promotional entitlement. Every row is
 * now confirmed live by the row-scoped predicate before it is mirrored.
 */
import { corsHeaders, env, json, logEvent } from '../_shared/deletion/common.ts';
import { syncPromotionalEntitlement } from '../_shared/revenuecat/revenueCatClient.ts';

interface PendingRow {
  user_id: string;
  entitlement_key: string;
  expires_at: string | null;
}

async function rpcServiceRole(fnName: string, body: Record<string, unknown>): Promise<Response> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
}

// Is THIS row live? The question is row-scoped, exactly as in kplus-activate.
// public.kplus_has_active_entitlement answers for the USER across every grant
// (K+ entitlement authority, Phase 1), so a revoked Early Access row reads
// true there whenever any other grant is live, and mirroring on that answer
// would put the revoked row's expiry back into RevenueCat.
// public.kplus_user_entitlement_row_is_active applies the Build 34 canonical
// predicate (status = 'active' AND revoked_at IS NULL AND expires_at IS NOT
// NULL AND expires_at > now()) to this row alone.
//
// Fails CLOSED: a non-ok response, a thrown request or any answer other than a
// literal `true` reads as not live.
async function isRowActive(row: PendingRow): Promise<boolean> {
  try {
    const activeResponse = await rpcServiceRole('kplus_user_entitlement_row_is_active', {
      p_user_id: row.user_id,
      p_entitlement_key: row.entitlement_key,
    });
    if (!activeResponse.ok) {
      logEvent('kplus_reconcile_active_check_failed', { status: activeResponse.status });
      return false;
    }
    return (await activeResponse.json()) === true;
  } catch {
    logEvent('kplus_reconcile_active_check_failed', { status: 0 });
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('KPLUS_RECONCILE_INTERNAL_SECRET')?.trim();
  const providedSecret = req.headers.get('x-kplus-reconcile-secret')?.trim();
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return json({ error: 'Not authorized' }, 401);
  }

  const limitParam = Number(new URL(req.url).searchParams.get('limit') ?? '25');
  const limit = Number.isFinite(limitParam) ? limitParam : 25;

  const listResponse = await rpcServiceRole('list_kplus_pending_revenuecat_sync', { p_limit: limit });
  if (!listResponse.ok) {
    logEvent('kplus_reconcile_list_failed', { status: listResponse.status });
    return json({ error: 'Failed to list pending rows' }, 502);
  }

  const rows = (await listResponse.json()) as PendingRow[];
  let synced = 0;
  let stillPending = 0;
  let skippedNotActive = 0;

  for (const row of rows) {
    if (!row.expires_at) {
      stillPending += 1;
      continue;
    }
    // SEC-KPLUS-008: the authority is read BEFORE the mirror. A row that is not
    // confirmed live (revoked, expired or unreadable) makes no RevenueCat
    // request and writes no sync status -- it is left exactly as the
    // revocation left it. One row's answer never ends the pass.
    if (!(await isRowActive(row))) {
      skippedNotActive += 1;
      continue;
    }
    const outcome = await syncPromotionalEntitlement({
      appUserId: row.user_id,
      expiresAt: row.expires_at,
    });
    const statusResponse = await rpcServiceRole('set_kplus_revenuecat_sync_status', {
      p_user_id: row.user_id,
      p_entitlement_key: row.entitlement_key,
      p_status: outcome.status,
      p_external_customer_id: outcome.ok ? outcome.externalCustomerId : null,
    });
    if (!statusResponse.ok) {
      logEvent('kplus_reconcile_status_write_failed', { status: statusResponse.status });
    }
    if (outcome.ok) synced += 1;
    else stillPending += 1;
  }

  logEvent('kplus_reconcile_completed', { scanned: rows.length, synced, stillPending, skippedNotActive });
  return json({ scanned: rows.length, synced, stillPending, skippedNotActive });
});
