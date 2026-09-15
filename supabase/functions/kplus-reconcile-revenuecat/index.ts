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
 *
 * TWO PASSES, one invocation:
 *
 *   Pass 1 (grant convergence, unchanged) drains
 *   list_kplus_pending_revenuecat_sync -- legacy user_entitlements rows whose
 *   mirror attempt has not yet succeeded.
 *
 *   Pass 2 (REVENUECAT_REVOCATION_RETIREMENT) drains
 *   list_kplus_revenuecat_mirror_retirements -- (user, entitlement) pairs a
 *   database trigger marked dirty because a complimentary grant contracted
 *   (revoked, shortened, closed off). Every mirror-CREATING path existed
 *   before this; no mirror-RETIRING path did, so a revoked complimentary
 *   grant left a live granted entitlement in RevenueCat until its original
 *   expiry.
 *
 * Pass 2 is desired-state, not replay. It never trusts what was queued: for
 * each dirty pair it asks public.kplus_promotional_mirror_state what
 * promotional state should exist RIGHT NOW and converges to that -- re-syncing
 * when a complimentary grant survives (or a new one was issued after the
 * retirement was queued), retiring only when none remains. A stale queue entry
 * can therefore never revoke a newly valid grant.
 *
 * Authority direction is unchanged: Supabase decides access, RevenueCat
 * mirrors it. Nothing in either pass can restore, extend or revoke local
 * access, and a RevenueCat outage only leaves a queue row retryable.
 */
import { corsHeaders, env, json, logEvent } from '../_shared/deletion/common.ts';
import {
  retireMirroredEntitlement,
  syncPromotionalEntitlement,
} from '../_shared/revenuecat/revenueCatClient.ts';

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

interface DirtyMirrorRow {
  user_id: string;
  entitlement_key: string;
}

interface PromotionalMirrorState {
  should_mirror: boolean;
  is_open_ended: boolean;
  mirror_expires_at: string | null;
}

/**
 * The desired promotional state for one pair, read at EXECUTION time.
 *
 * `null` means "could not be determined", which is never treated as "no
 * promotional state": fail-closed here means making no external call at all,
 * because the destructive branch below is the one that removes access in
 * RevenueCat. An unreadable authority must never be able to revoke a mirror.
 */
async function readPromotionalMirrorState(
  row: DirtyMirrorRow,
): Promise<PromotionalMirrorState | null> {
  try {
    const response = await rpcServiceRole('kplus_promotional_mirror_state', {
      p_user_id: row.user_id,
      p_entitlement_key: row.entitlement_key,
    });
    if (!response.ok) {
      logEvent('kplus_mirror_state_read_failed', { status: response.status });
      return null;
    }
    const body = await response.json();
    // set-returning RPCs come back as an array; exactly one row is expected.
    const state = Array.isArray(body) ? body[0] : body;
    if (!state || typeof state.should_mirror !== 'boolean') {
      logEvent('kplus_mirror_state_read_failed', { status: 0 });
      return null;
    }
    return state as PromotionalMirrorState;
  } catch {
    logEvent('kplus_mirror_state_read_failed', { status: 0 });
    return null;
  }
}

/**
 * Queue bookkeeping only -- never touches an entitlement or local access.
 *
 * Never throws. A failed bookkeeping write leaves the pair queued, which is
 * the safe direction (it is retried and re-converges); letting it propagate
 * would abandon every pair still waiting behind it in this batch.
 */
async function settleMirrorQueueRow(
  row: DirtyMirrorRow,
  status: string,
  reason: string | null,
): Promise<void> {
  try {
    const response = await rpcServiceRole('set_kplus_revenuecat_mirror_status', {
      p_user_id: row.user_id,
      p_entitlement_key: row.entitlement_key,
      p_status: status,
      p_reason: reason,
    });
    if (!response.ok) {
      logEvent('kplus_mirror_status_write_failed', { status: response.status });
    }
  } catch {
    logEvent('kplus_mirror_status_write_failed', { status: 0 });
  }
}

/** Client outcome word -> queue status. */
function queueStatusFor(outcomeStatus: string): string {
  switch (outcomeStatus) {
    // retired / already_retired / synced are all "RevenueCat now matches
    // authority" -- the goal state, however it was reached.
    case 'retired':
    case 'already_retired':
    case 'synced':
      return 'synced';
    case 'not_required':
      return 'not_required';
    case 'failed_terminal':
      return 'failed_terminal';
    default:
      return 'failed_retryable';
  }
}

/**
 * Pass 2. Converges RevenueCat to current promotional authority for each dirty
 * pair. One row's failure never ends the batch.
 */
async function reconcileMirrorRetirements(limit: number) {
  // A failure to read the queue is reported, never thrown: pass 1 has already
  // run and its results must still reach the caller.
  let rows: DirtyMirrorRow[];
  try {
    const listResponse = await rpcServiceRole('list_kplus_revenuecat_mirror_retirements', {
      p_limit: limit,
    });
    if (!listResponse.ok) {
      logEvent('kplus_mirror_retirement_list_failed', { status: listResponse.status });
      return { scanned: 0, retired: 0, resynced: 0, deferred: 0, listFailed: true };
    }
    const body = await listResponse.json();
    if (!Array.isArray(body)) {
      logEvent('kplus_mirror_retirement_list_failed', { status: 0 });
      return { scanned: 0, retired: 0, resynced: 0, deferred: 0, listFailed: true };
    }
    rows = body as DirtyMirrorRow[];
  } catch {
    logEvent('kplus_mirror_retirement_list_failed', { status: 0 });
    return { scanned: 0, retired: 0, resynced: 0, deferred: 0, listFailed: true };
  }

  let retired = 0;
  let resynced = 0;
  let deferred = 0;

  for (const row of rows) {
    const desired = await readPromotionalMirrorState(row);
    if (!desired) {
      // Authority unreadable: no RevenueCat call of any kind, retry later.
      await settleMirrorQueueRow(row, 'failed_retryable', 'desired_state_unreadable');
      deferred += 1;
      continue;
    }

    if (desired.should_mirror) {
      // A complimentary grant still survives (or a new one was issued after
      // this retirement was queued). Converge onto it -- never revoke.
      if (desired.is_open_ended || !desired.mirror_expires_at) {
        // An open-ended complimentary grant has no expiry to mirror, and this
        // project's grant path only knows how to assert a concrete expires_at.
        // Reporting that explicitly is the correct outcome; inventing an
        // expiry would silently shorten a valid grant, and revoking would
        // retire a mirror that should still be live.
        logEvent('kplus_mirror_open_ended_unsupported', { status: 0 });
        await settleMirrorQueueRow(row, 'failed_terminal', 'open_ended_mirror_unsupported');
        deferred += 1;
        continue;
      }
      const outcome = await syncPromotionalEntitlement({
        appUserId: row.user_id,
        expiresAt: desired.mirror_expires_at,
      });
      await settleMirrorQueueRow(row, queueStatusFor(outcome.status), outcome.ok ? null : outcome.reason);
      if (outcome.ok) resynced += 1;
      else deferred += 1;
      continue;
    }

    // No promotional state remains: retire the granted entitlement. This is
    // the only externally destructive action in this lane, and it touches the
    // granted/promotional entitlement only -- never a store subscription.
    const outcome = await retireMirroredEntitlement({ appUserId: row.user_id });
    await settleMirrorQueueRow(row, queueStatusFor(outcome.status), outcome.ok ? null : outcome.reason);
    if (outcome.ok) retired += 1;
    else deferred += 1;
  }

  return { scanned: rows.length, retired, resynced, deferred, listFailed: false };
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

  // Pass 2 runs even when pass 1 mirrored nothing: the two queues are
  // independent, and a retirement must not wait on grant convergence.
  const retirements = await reconcileMirrorRetirements(limit);

  logEvent('kplus_reconcile_completed', {
    scanned: rows.length,
    synced,
    stillPending,
    skippedNotActive,
    mirrorScanned: retirements.scanned,
    mirrorRetired: retirements.retired,
    mirrorResynced: retirements.resynced,
    mirrorDeferred: retirements.deferred,
  });
  return json({
    scanned: rows.length,
    synced,
    stillPending,
    skippedNotActive,
    mirrorScanned: retirements.scanned,
    mirrorRetired: retirements.retired,
    mirrorResynced: retirements.resynced,
    mirrorDeferred: retirements.deferred,
  });
});
