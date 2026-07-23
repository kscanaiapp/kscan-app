import {
  corsHeaders,
  env,
  envOptional,
  json,
  logEvent,
  readAppConfigFlag,
  revokeAllSessions,
  rpc,
  shortUserId,
} from '../_shared/deletion/common.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  USER_DATA_RESOURCES,
  STORAGE_RESOURCES,
  SHARED_ROOM_TRANSFER_POLICY,
} from '../_shared/deletion/userDataResources.ts';

/**
 * Internal protected worker for automatic account purges.
 * Requires x-deletion-worker-secret (or Authorization: Bearer <worker secret>).
 * Kill switch + dry-run are server-config controlled (app_config), not request body.
 */

const BACKOFF_NOTE = 'Worker purge attempt';

function requireWorkerAuth(req: Request): void {
  const expected = envOptional('ACCOUNT_DELETION_WORKER_SECRET');
  if (!expected) {
    throw json({ error: 'Worker secret not configured' }, 503);
  }
  const headerSecret = req.headers.get('x-deletion-worker-secret')?.trim();
  const auth = req.headers.get('Authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice('bearer '.length).trim()
    : '';
  const provided = headerSecret || bearer;
  if (!provided) {
    logEvent('worker_auth_rejected', {});
    throw json({ error: 'Unauthorized' }, 401);
  }

  const anon = envOptional('SUPABASE_ANON_KEY');
  if (anon && provided === anon) {
    throw json({ error: 'Unauthorized' }, 401);
  }

  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.length !== b.length) {
    logEvent('worker_auth_rejected', {});
    throw json({ error: 'Unauthorized' }, 401);
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  if (mismatch !== 0) {
    logEvent('worker_auth_rejected', {});
    throw json({ error: 'Unauthorized' }, 401);
  }
}

function createAdmin() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isMissingResourceError(error: { code?: string; message?: string } | null) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('could not find the table') ||
    message.includes('schema cache') ||
    message.includes('bucket not found')
  );
}

async function countResourceRows(
  supabase: ReturnType<typeof createAdmin>,
  resource: (typeof USER_DATA_RESOURCES)[number],
  userId: string,
) {
  if (resource.count === false || !resource.column) {
    return {
      table: resource.table,
      column: resource.column,
      action: resource.action,
      count: null,
      covered: true,
    };
  }
  const result = await supabase
    .from(resource.table)
    .select('*', { count: 'exact', head: true })
    .eq(resource.column, userId);
  if (result.error) {
    if (resource.optional && isMissingResourceError(result.error)) {
      return {
        table: resource.table,
        column: resource.column,
        action: resource.action,
        count: null,
        covered: true,
        notes: 'optional_missing',
      };
    }
    throw new Error(`count ${resource.table}: ${result.error.message}`);
  }
  return {
    table: resource.table,
    column: resource.column,
    action: resource.action,
    count: result.count ?? 0,
    covered: true,
  };
}

async function deleteDirectUserRows(
  supabase: ReturnType<typeof createAdmin>,
  userId: string,
) {
  const direct = USER_DATA_RESOURCES.filter((r) => r.action === 'direct_delete_before_auth');
  const results = [];
  for (const resource of direct) {
    if (!resource.column) continue;
    const result = await supabase.from(resource.table).delete({ count: 'exact' }).eq(
      resource.column,
      userId,
    );
    if (result.error) {
      if (resource.optional && isMissingResourceError(result.error)) {
        results.push({ table: resource.table, status: 'skipped_missing' });
        continue;
      }
      throw new Error(`delete ${resource.table}: ${result.error.message}`);
    }
    results.push({ table: resource.table, status: 'deleted', count: result.count ?? null });
  }
  return results;
}

async function transferSharedRooms(
  supabase: ReturnType<typeof createAdmin>,
  userId: string,
) {
  const roomsResult = await supabase.from('dressing_rooms').select('id,title').eq('user_id', userId);
  if (roomsResult.error) throw new Error(roomsResult.error.message);
  const rooms = roomsResult.data ?? [];
  const results = [];
  for (const room of rooms) {
    const participantsResult = await supabase
      .from('dressing_room_participants')
      .select('user_id,created_at')
      .eq('dressing_room_id', room.id)
      .order('created_at', { ascending: true });
    if (participantsResult.error) throw new Error(participantsResult.error.message);
    let recipient: string | null = null;
    for (const p of participantsResult.data ?? []) {
      if (p.user_id === userId) continue;
      const profile = await supabase
        .from('profiles')
        .select('id,account_status')
        .eq('id', p.user_id)
        .maybeSingle();
      if (profile.data?.account_status === 'active') {
        const auth = await supabase.auth.admin.getUserById(p.user_id);
        if (auth.data?.user) {
          recipient = p.user_id;
          break;
        }
      }
    }
    if (!recipient) {
      results.push({ roomId: room.id, action: 'no_valid_recipient' });
      continue;
    }
    const update = await supabase
      .from('dressing_rooms')
      .update({ user_id: recipient, updated_at: new Date().toISOString() })
      .eq('id', room.id)
      .eq('user_id', userId)
      .select('id');
    if (update.error || !update.data?.length) {
      throw new Error(`transfer room ${room.id} failed`);
    }
    results.push({ roomId: room.id, action: 'transfer', newOwner: shortUserId(recipient) });
  }
  return results;
}

async function deleteOwnedStorage(
  supabase: ReturnType<typeof createAdmin>,
  userId: string,
) {
  const results = [];
  for (const resource of STORAGE_RESOURCES) {
    const bucket = supabase.storage.from(resource.bucket);
    for (const prefix of resource.prefixesForUser(userId)) {
      const paths: string[] = [];
      const limit = 1000;
      let offset = 0;
      while (true) {
        const { data, error } = await bucket.list(prefix, { limit, offset });
        if (error) {
          throw new Error(`storage list failed for ${resource.bucket}: ${error.message}`);
        }
        const page = data ?? [];
        for (const item of page) {
          if (item?.name) paths.push(`${prefix}/${item.name}`);
        }
        if (page.length < limit) break;
        offset += limit;
      }

      if (paths.length === 0) {
        results.push({ status: 'no_objects', count: 0 });
        continue;
      }

      // Skip objects still referenced by rooms transferred to another owner.
      const referenced = new Set<string>();
      const refQuery = await supabase
        .from('dressing_room_items')
        .select('storage_path')
        .like('storage_path', `${prefix}%`)
        .limit(1000);
      if (!refQuery.error) {
        for (const row of refQuery.data ?? []) {
          if (row.storage_path) referenced.add(String(row.storage_path));
        }
      }
      const removable = paths.filter((p) => !referenced.has(p));
      const retained = paths.length - removable.length;
      if (removable.length > 0) {
        const removed = await bucket.remove(removable);
        if (removed.error) throw new Error(removed.error.message);
      }
      results.push({
        status: 'removed',
        count: removable.length,
        retainedReferenced: retained,
      });
    }
  }
  return results;
}

async function enumerateOwnedStorage(
  supabase: ReturnType<typeof createAdmin>,
  userId: string,
) {
  const results = [];
  for (const resource of STORAGE_RESOURCES) {
    const bucket = supabase.storage.from(resource.bucket);
    for (const prefix of resource.prefixesForUser(userId)) {
      const { data, error } = await bucket.list(prefix, { limit: 1000 });
      if (error) {
        results.push({
          bucket: resource.bucket,
          prefixHash: shortUserId(userId),
          status: 'list_error',
          objectCount: null,
        });
        continue;
      }
      const objectCount = (data ?? []).filter((i) => i?.name).length;
      results.push({
        bucket: resource.bucket,
        prefixTemplate: prefix.includes(userId)
          ? prefix.replace(userId, '{userId}')
          : prefix,
        status: 'identified',
        objectCount,
        wouldDelete: objectCount > 0,
      });
    }
  }
  return results;
}

function classifyDryRunCandidate(row: Record<string, unknown>, now = new Date()) {
  if (row.purged_at) return 'skipped_already_purged';
  if (row.restored_at || row.status === 'restored') return 'skipped_restored';
  if (row.status === 'legal_hold') return 'skipped_legal_hold';
  if (row.legal_hold_until && new Date(String(row.legal_hold_until)) > now) {
    return 'skipped_legal_hold';
  }
  if (!row.user_id) return 'skipped_missing_user';
  if (row.grace_period_ends_at && new Date(String(row.grace_period_ends_at)) > now) {
    return 'skipped_future_grace';
  }
  if (row.status !== 'deactivated') return `skipped_status_${String(row.status)}`;
  return 'eligible';
}

async function buildDeletionPlan(
  supabase: ReturnType<typeof createAdmin>,
  row: Record<string, unknown>,
) {
  const userId = String(row.user_id);
  const eligibility = classifyDryRunCandidate(row);
  const coverage = [];
  for (const resource of USER_DATA_RESOURCES) {
    coverage.push(await countResourceRows(supabase, resource, userId));
  }
  const storage = await enumerateOwnedStorage(supabase, userId);
  return {
    requestId: row.id,
    subjectRef: row.subject_ref,
    status: row.status,
    gracePeriodEndsAt: row.grace_period_ends_at,
    attemptCount: row.attempt_count ?? 0,
    eligibility,
    wouldClaim: eligibility === 'eligible',
    tree: coverage.map((node) => ({
      table: node.table,
      column: node.column,
      action: node.action,
      rowCount: node.count,
      covered: node.covered,
      notes: node.notes ?? null,
      finalPurge: node.action === 'survive_auth_delete' ? 'retain_ledger' : 'delete',
    })),
    storage,
    policy: {
      sharedRooms: SHARED_ROOM_TRANSFER_POLICY,
      shareLinksDuringGrace: 'remain_active',
      authDelete: 'final_purge_only',
      sessions: 'revoked_at_request_and_again_at_purge',
    },
  };
}

async function heartbeat(
  requestId: string,
  workerId: string,
): Promise<boolean> {
  const response = await rpc('heartbeat_deletion_request_lease', {
    p_request_id: requestId,
    p_worker_id: workerId,
  });
  if (!response.ok) return false;
  const value = await response.json();
  return value === true;
}

async function processClaimedRequest(
  supabase: ReturnType<typeof createAdmin>,
  request: Record<string, unknown>,
  workerId: string,
) {
  const requestId = String(request.id);
  const userId = String(request.user_id);
  const subjectRef = String(request.subject_ref);

  const stillOwned = await heartbeat(requestId, workerId);
  if (!stillOwned) {
    logEvent('worker_lost_lease', { requestIdPrefix: requestId.slice(0, 8) });
    return { status: 'lost_lease' };
  }

  // Confirm grace + not restored (defense in depth; claim RPC already checked).
  if (request.restored_at || request.purged_at) {
    return { status: 'skipped_terminal' };
  }
  if (request.grace_period_ends_at && new Date(String(request.grace_period_ends_at)) > new Date()) {
    return { status: 'skipped_grace' };
  }

  await revokeAllSessions(userId, null);
  if (!(await heartbeat(requestId, workerId))) return { status: 'lost_lease' };

  // Ledger: AUTH_DELETE_STARTED will be written just before auth delete.
  const direct = await deleteDirectUserRows(supabase, userId);
  if (!(await heartbeat(requestId, workerId))) return { status: 'lost_lease' };

  const rooms = await transferSharedRooms(supabase, userId);
  if (!(await heartbeat(requestId, workerId))) return { status: 'lost_lease' };

  const storage = await deleteOwnedStorage(supabase, userId);
  if (!(await heartbeat(requestId, workerId))) return { status: 'lost_lease' };

  // Coverage check for seven added tables (verification visibility).
  const coverage = [];
  for (const resource of USER_DATA_RESOURCES) {
    coverage.push(await countResourceRows(supabase, resource, userId));
  }

  await rpc('append_deletion_state_transition', {
    p_request_id: requestId,
    p_subject_ref: subjectRef,
    p_from_state: 'purging',
    p_to_state: 'purging',
    p_actor_type: 'worker',
    p_actor_ref: workerId,
    p_reason_code: 'AUTH_DELETE_STARTED',
    p_sanitized_metadata: { note: BACKOFF_NOTE },
  });

  await revokeAllSessions(userId, null);
  const deleteResult = await supabase.auth.admin.deleteUser(userId);
  if (deleteResult.error) {
    const msg = deleteResult.error.message.toLowerCase();
    if (!msg.includes('not found') && !msg.includes('user not found')) {
      throw new Error(`delete auth user: ${deleteResult.error.message}`);
    }
    logEvent('auth_user_already_absent', { uid: shortUserId(userId) });
  }

  // Confirm surviving request row.
  const surviving = await supabase
    .from('deletion_requests')
    .select('id,user_id,subject_ref,status')
    .eq('id', requestId)
    .maybeSingle();
  if (surviving.error || !surviving.data) {
    throw new Error('deletion_requests row did not survive Auth deletion');
  }
  if (surviving.data.user_id !== null) {
    // SET NULL may be async-ish; force null if needed.
    await supabase
      .from('deletion_requests')
      .update({ user_id: null })
      .eq('id', requestId);
  }

  const marked = await rpc('mark_deletion_request_purged', {
    p_request_id: requestId,
    p_worker_id: workerId,
  });
  if (!marked.ok) {
    throw new Error('mark purged failed');
  }
  const markOk = await marked.json();
  if (markOk !== true) {
    throw new Error('mark purged returned false');
  }

  logEvent('purge_success', {
    requestIdPrefix: requestId.slice(0, 8),
    roomsTransferred: rooms.filter((r) => r.action === 'transfer').length,
    policy: SHARED_ROOM_TRANSFER_POLICY,
    coverageTables: coverage.length,
  });

  return {
    status: 'purged',
    direct,
    rooms,
    storage,
    coverageCount: coverage.length,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    requireWorkerAuth(req);
    const workerId = `worker_${crypto.randomUUID()}`;
    logEvent('worker_invocation', { workerIdPrefix: workerId.slice(0, 16) });

    const enabled = await readAppConfigFlag('account_deletion_worker_enabled');
    const dryRunFlag = await readAppConfigFlag('account_deletion_worker_dry_run');
    // Env override for emergency dry-run (server-controlled; not request body).
    const envDryRun = (Deno.env.get('DELETION_WORKER_DRY_RUN') ?? '').toLowerCase() === 'true';
    const dryRun = envDryRun || dryRunFlag || !enabled;

    if (!enabled) {
      logEvent('kill_switch_skip', { workerIdPrefix: workerId.slice(0, 16) });
    }

    const supabase = createAdmin();

    if (dryRun) {
      const candidatesResponse = await rpc('list_deletion_purge_candidates', { p_limit: 25 });
      const eligible = candidatesResponse.ok ? await candidatesResponse.json() : [];

      // Inventory deactivated lifecycle rows for plan coverage even when still in grace.
      const inventory = await supabase
        .from('deletion_requests')
        .select(
          'id,subject_ref,user_id,status,grace_period_ends_at,attempt_count,restored_at,purged_at,legal_hold_until',
        )
        .in('status', ['deactivated', 'restored', 'purged', 'failed', 'legal_hold', 'purging'])
        .order('grace_period_ends_at', { ascending: true })
        .limit(50);

      if (inventory.error) {
        throw new Error(`dry-run inventory failed: ${inventory.error.message}`);
      }

      const plans = [];
      for (const row of inventory.data ?? []) {
        if (!row.user_id) {
          plans.push({
            requestId: row.id,
            subjectRef: row.subject_ref,
            status: row.status,
            eligibility: classifyDryRunCandidate(row),
            wouldClaim: false,
            tree: [],
            storage: [],
          });
          continue;
        }
        plans.push(await buildDeletionPlan(supabase, row));
      }

      const summary = {
        eligibleCount: Array.isArray(eligible) ? eligible.length : 0,
        planCount: plans.length,
        byEligibility: plans.reduce((acc: Record<string, number>, plan) => {
          const key = String(plan.eligibility);
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      };

      logEvent('worker_dry_run', {
        ...summary,
        killSwitchEnabled: enabled,
        dryRunFlag,
        envDryRun,
      });
      return json({
        mode: 'dry_run',
        killSwitchEnabled: enabled,
        dryRun: true,
        summary,
        eligibleRequestIds: (Array.isArray(eligible) ? eligible : []).map((row: { id: string }) => row.id),
        plans,
        note: 'No claims, Auth deletions, or Storage deletions were performed.',
      });
    }

    // Crash recovery: close out any 'purging' rows whose auth user was already
    // deleted (user_id nulled by FK cascade) before the worker that claimed
    // them could call mark_deletion_request_purged. Pure ledger reconciliation
    // — there is no remaining user data to touch, since the auth.users cascade
    // already removed it. Safe to run every live invocation.
    const reconcileResponse = await rpc('reconcile_orphaned_purging_requests', { p_limit: 25 });
    if (reconcileResponse.ok) {
      const reconciled = await reconcileResponse.json();
      const reconciledCount = Array.isArray(reconciled) ? reconciled.length : 0;
      if (reconciledCount > 0) {
        logEvent('worker_reconciled_orphaned_purging', { count: reconciledCount });
      }
    } else {
      logEvent('worker_reconcile_failed', { status: reconcileResponse.status });
    }

    // Live claim path — only when kill switch enabled AND dry-run disabled.
    const claimResponse = await rpc('claim_deletion_requests_for_purge', {
      p_worker_id: workerId,
      p_limit: 5,
    });
    if (!claimResponse.ok) {
      logEvent('worker_claim_failed', { status: claimResponse.status });
      return json({ error: 'Claim failed' }, 500);
    }

    const claimed = await claimResponse.json();
    const claimedRows = Array.isArray(claimed) ? claimed : [];
    logEvent('worker_claim', { count: claimedRows.length, workerIdPrefix: workerId.slice(0, 16) });

    const results = [];
    for (const row of claimedRows) {
      try {
        const result = await processClaimedRequest(supabase, row, workerId);
        results.push({ requestId: row.id, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'purge_failed';
        logEvent('purge_failure', {
          requestIdPrefix: String(row.id).slice(0, 8),
          code: 'PURGE_ERROR',
        });
        await rpc('schedule_deletion_retry_or_fail', {
          p_request_id: row.id,
          p_worker_id: workerId,
          p_failure_code: 'PURGE_ERROR',
          p_failure_message: message.slice(0, 500),
        });
        results.push({ requestId: row.id, status: 'retry_or_failed', error: message.slice(0, 200) });
      }
    }

    return json({
      mode: 'live',
      workerIdPrefix: workerId.slice(0, 16),
      claimed: claimedRows.length,
      results,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('worker_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json({ error: 'Worker failed' }, 500);
  }
});
