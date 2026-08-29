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

  for (const row of rows) {
    if (!row.expires_at) {
      stillPending += 1;
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

  logEvent('kplus_reconcile_completed', { scanned: rows.length, synced, stillPending });
  return json({ scanned: rows.length, synced, stillPending });
});
