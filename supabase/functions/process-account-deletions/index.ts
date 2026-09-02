import {
  alertEvent,
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

// True when a Dressing Room block exists between the two accounts in EITHER
// direction. Reads public.dressing_room_user_blocks with the service role
// rather than calling internal.is_dressing_room_pair_blocked(): that helper
// deliberately lives in the unexposed `internal` schema and holds no EXECUTE
// grant for service_role, so this worker cannot invoke it.
//
// Fails CLOSED -- an unreadable block relation returns `true`. Handing a
// blocked account somebody else's room is unrecoverable; declining to transfer
// only falls back to the owner cascade the deleting owner already chose.
// A genuinely absent table (pre-blocking environments) is not a read failure.
async function isTransferPairBlocked(
  supabase: ReturnType<typeof createAdmin>,
  ownerUserId: string,
  candidateUserId: string,
): Promise<boolean> {
  const result = await supabase
    .from('dressing_room_user_blocks')
    .select('blocker_user_id,blocked_user_id')
    .or(
      `and(blocker_user_id.eq.${ownerUserId},blocked_user_id.eq.${candidateUserId}),` +
        `and(blocker_user_id.eq.${candidateUserId},blocked_user_id.eq.${ownerUserId})`,
    )
    .limit(1);
  if (result.error) {
    const code = String((result.error as { code?: string }).code ?? '').toUpperCase();
    const message = String(result.error.message ?? '').toLowerCase();
    const missing =
      code === '42P01' ||
      code === 'PGRST205' ||
      message.includes('does not exist') ||
      message.includes('could not find the table') ||
      message.includes('schema cache');
    if (missing) return false;
    return true;
  }
  return Array.isArray(result.data) && result.data.length > 0;
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
      // left_at is what "active participant" means in this schema, so the
      // transfer policy (transfer_to_earliest_active_participant) has to read
      // it. A row with left_at set was marked departed by
      // block_dressing_room_user(); inheriting the room would hand it to
      // exactly the account the departure was created to separate.
      .select('user_id,created_at,left_at')
      .eq('dressing_room_id', room.id)
      .order('created_at', { ascending: true });
    if (participantsResult.error) throw new Error(participantsResult.error.message);
    let recipient: string | null = null;
    for (const p of participantsResult.data ?? []) {
      if (p.user_id === userId) continue;
      if (p.left_at) continue;
      const profile = await supabase
        .from('profiles')
        .select('id,account_status')
        .eq('id', p.user_id)
        .maybeSingle();
      if (profile.data?.account_status === 'active') {
        if (await isTransferPairBlocked(supabase, userId, p.user_id)) continue;
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

// Paginated listing of every object path under a prefix. limit=1000 is
// Supabase Storage's per-call ceiling, so a user with more than 1000 objects
// requires multiple pages -- a single unpaginated list() would silently leave
// objects 1001+ un-purged (Finding P2-4).
async function listPrefixPaths(
  bucket: ReturnType<ReturnType<typeof createAdmin>['storage']['from']>,
  prefix: string,
): Promise<string[]> {
  const paths: string[] = [];
  const limit = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await bucket.list(prefix, { limit, offset });
    if (error) {
      throw new Error(`storage list failed for ${prefix}: ${error.message}`);
    }
    const page = data ?? [];
    for (const item of page) {
      if (item?.name) paths.push(`${prefix}/${item.name}`);
    }
    if (page.length < limit) break;
    offset += limit;
  }
  return paths;
}

// Storage objects still pointed at by a dressing_room_items row that will
// SURVIVE this purge (rows cascade with their room, not with the deleting
// user, so a room transferred to another owner keeps them). Those objects
// must be preserved. Paginated (P2-4) and fail-CLOSED: if the reference set
// can't be determined, the caller must not delete under this prefix, so an
// error here throws rather than silently returning an empty set (which would
// have deleted everything -- the prior code's fail-OPEN bug).
async function collectReferencedStoragePaths(
  supabase: ReturnType<typeof createAdmin>,
  prefix: string,
): Promise<Set<string>> {
  const referenced = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const q = await supabase
      .from('dressing_room_items')
      .select('storage_path')
      .like('storage_path', `${prefix}%`)
      .range(from, from + pageSize - 1);
    if (q.error) {
      throw new Error(`reference check failed for ${prefix}: ${q.error.message}`);
    }
    const rows = q.data ?? [];
    for (const row of rows) {
      if (row.storage_path) referenced.add(String(row.storage_path));
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return referenced;
}

/**
 * INT-KPLUS-010 -- scheduled orphan sweep for a purged owner's retained media.
 *
 * Account purge deliberately retains storage objects that a surviving
 * dressing_room_items row still points at (rows cascade with their ROOM, not
 * with the deleting user, so a transferred room keeps its images). Nothing ever
 * revisited those objects once the last reference disappeared, so a deleted
 * owner's media outlived every reference to it, permanently.
 *
 * Room/item teardown is a direct CLIENT-side table delete, and a client is not
 * a trustworthy deletion authority for another user's media -- so the closure
 * lives here, in the already-scheduled, secret-gated, kill-switched worker,
 * rather than in a new function or a client hook.
 *
 * APPROVED POLICY: retain while referenced; eligible for deletion the moment the
 * final reference is gone; no additional retention window. The reference check is
 * collectReferencedStoragePaths -- the SAME function the purge path uses, reused
 * unchanged, including its fail-CLOSED behaviour: if the reference set cannot be
 * determined it throws, and this prefix is skipped rather than swept blind.
 */
async function sweepOrphanedOwnerMedia(
  supabase: ReturnType<typeof createAdmin>,
  options: { dryRun: boolean; limit?: number },
): Promise<{
  claimed: number;
  removed: number;
  stillReferenced: number;
  cleared: number;
  skipped: number;
}> {
  const summary = { claimed: 0, removed: 0, stillReferenced: 0, cleared: 0, skipped: 0 };

  const claimResponse = await rpc('claim_retained_owner_media_for_sweep', {
    p_limit: options.limit ?? 25,
  });
  if (!claimResponse.ok) {
    logEvent('orphan_sweep_claim_failed', { status: claimResponse.status });
    return summary;
  }
  const rows = (await claimResponse.json()) as Array<{
    storage_bucket: string;
    storage_prefix: string;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) return summary;
  summary.claimed = rows.length;

  for (const row of rows) {
    const bucketName = row.storage_bucket;
    const prefix = row.storage_prefix;
    try {
      const bucket = supabase.storage.from(bucketName);
      const paths = await listPrefixPaths(bucket, prefix);

      if (paths.length === 0) {
        // Nothing left under the prefix at all: the work item is done.
        if (!options.dryRun) {
          await rpc('settle_retained_owner_media', {
            p_bucket: bucketName,
            p_prefix: prefix,
            p_remaining: 0,
          });
        }
        summary.cleared += 1;
        continue;
      }

      // The SAME reference check the purge path uses. Throws (fail-closed) if
      // the reference set cannot be determined -- caught below, prefix skipped.
      const referenced = await collectReferencedStoragePaths(supabase, prefix);
      const orphaned = paths.filter((path) => !referenced.has(path));
      const remaining = paths.length - orphaned.length;

      if (orphaned.length > 0 && !options.dryRun) {
        const removed = await bucket.remove(orphaned);
        if (removed.error) throw new Error(removed.error.message);
      }
      summary.removed += orphaned.length;
      summary.stillReferenced += remaining;

      if (!options.dryRun) {
        await rpc('settle_retained_owner_media', {
          p_bucket: bucketName,
          p_prefix: prefix,
          p_remaining: remaining,
        });
      }
      if (remaining === 0) summary.cleared += 1;

      logEvent('orphan_sweep_prefix', {
        bucket: bucketName,
        // Never the raw prefix: it embeds the purged account's id.
        prefixHash: prefix.length,
        orphanedRemoved: options.dryRun ? 0 : orphaned.length,
        stillReferenced: remaining,
        dryRun: options.dryRun,
      });
    } catch (error) {
      // Fail closed: leave the objects and the work item alone. The prefix is
      // retried on a later sweep; nothing is deleted on uncertain information.
      summary.skipped += 1;
      logEvent('orphan_sweep_prefix_skipped', {
        bucket: bucketName,
        reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
      });
    }
  }

  return summary;
}

async function deleteOwnedStorage(
  supabase: ReturnType<typeof createAdmin>,
  userId: string,
) {
  const results = [];
  for (const resource of STORAGE_RESOURCES) {
    const bucket = supabase.storage.from(resource.bucket);
    for (const prefix of resource.prefixesForUser(userId)) {
      const paths = await listPrefixPaths(bucket, prefix);

      if (paths.length === 0) {
        results.push({
          status: 'no_objects',
          count: 0,
          retainedReferenced: 0,
          bucket: resource.bucket,
          prefix,
        });
        continue;
      }

      const referenced = await collectReferencedStoragePaths(supabase, prefix);
      const removable = paths.filter((p) => !referenced.has(p));
      const retained = paths.length - removable.length;
      if (removable.length > 0) {
        const removed = await bucket.remove(removable);
        if (removed.error) throw new Error(removed.error.message);
        // P2-5: a 200 with fewer returned objects than requested means a
        // silent partial removal. Re-list and fail closed if any requested
        // object is genuinely still present (already-absent objects are fine
        // -- retries are idempotent and converge as remaining objects clear).
        const removedCount = Array.isArray(removed.data) ? removed.data.length : removable.length;
        if (removedCount < removable.length) {
          const afterPaths = new Set(await listPrefixPaths(bucket, prefix));
          const stillPresent = removable.filter((p) => afterPaths.has(p));
          if (stillPresent.length > 0) {
            alertEvent('storage_partial_removal', {
              uid: shortUserId(userId),
              prefixTemplate: prefix.replace(userId, '{userId}'),
              requested: removable.length,
              stillPresent: stillPresent.length,
            });
            throw new Error(
              `storage partial removal: ${stillPresent.length} objects still present under prefix`,
            );
          }
        }
      }
      results.push({
        status: 'removed',
        count: removable.length,
        retainedReferenced: retained,
        // INT-KPLUS-010: the orphan sweep needs to know WHERE objects were
        // retained, not merely how many. Without the address there is nothing
        // to revisit once the last reference disappears.
        bucket: resource.bucket,
        prefix,
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
      let objectCount: number | null;
      try {
        // Paginated (P2-4): the prior single list({limit:1000}) undercounted
        // the dry-run plan for users with >1000 objects.
        objectCount = (await listPrefixPaths(bucket, prefix)).length;
      } catch (_err) {
        results.push({
          bucket: resource.bucket,
          prefixHash: shortUserId(userId),
          status: 'list_error',
          objectCount: null,
        });
        continue;
      }
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

  // INT-KPLUS-010 -- register any prefix that finished the purge with objects
  // still retained, so the scheduled orphan sweep can revisit it once the last
  // surviving dressing-room reference is gone. A retained object with nothing
  // pointing at it and no account to own it must not survive indefinitely.
  //
  // Best-effort: a bookkeeping failure must never fail a purge that already
  // succeeded. A missed registration is picked up the next time this prefix is
  // observed, and the objects stay retained (the safe direction) until then.
  for (const entry of storage) {
    const bucket = (entry as { bucket?: string }).bucket;
    const prefix = (entry as { prefix?: string }).prefix;
    const retainedCount = (entry as { retainedReferenced?: number }).retainedReferenced ?? 0;
    if (!bucket || !prefix) continue;
    try {
      await rpc('record_retained_owner_media', {
        p_request_id: requestId,
        p_bucket: bucket,
        p_prefix: prefix,
        p_retained: retainedCount,
      });
    } catch {
      logEvent('retained_media_registration_failed', {
        requestIdPrefix: requestId.slice(0, 8),
        prefixTemplate: prefix.replace(userId, '{userId}'),
      });
    }
  }
  if (!(await heartbeat(requestId, workerId))) return { status: 'lost_lease' };

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

  // B3 fix: verify AFTER the auth user is gone, not before. The prior
  // "coverage check" ran ahead of auth.admin.deleteUser() -- i.e. it was a
  // pre-delete inventory, not a post-delete verification -- and its actual
  // per-table counts were discarded (only coverage.length was logged). A
  // cascade FK that silently didn't fire (wrong table, missing constraint,
  // a future migration that adds a user-data table without one) would
  // never be caught. Now: any resource whose FK is supposed to have
  // removed every row tied to this user (everything except the
  // survive_auth_delete-tagged ledger) that still shows a nonzero count
  // fails the request instead of marking it purged, so it durably retries
  // (via schedule_deletion_retry_or_fail, same as any other thrown error
  // here) rather than silently reporting success over residual user data.
  //
  // Renew the lease before this loop specifically: it issues one query per
  // registry resource (currently ~44), and unlike every other step in this
  // function it previously had no heartbeat guarding it.
  if (!(await heartbeat(requestId, workerId))) return { status: 'lost_lease' };
  const coverage = [];
  const residual = [];
  for (const resource of USER_DATA_RESOURCES) {
    const row = await countResourceRows(supabase, resource, userId);
    coverage.push(row);
    if (
      resource.action !== 'survive_auth_delete' &&
      typeof row.count === 'number' &&
      row.count > 0
    ) {
      residual.push(row);
    }
  }
  if (residual.length > 0) {
    alertEvent('purge_verification_failed', {
      requestIdPrefix: requestId.slice(0, 8),
      uid: shortUserId(userId),
      residual: residual.map((r) => ({ table: r.table, action: r.action, count: r.count })),
    });
    throw new Error(
      `post-purge verification found residual rows in: ${residual.map((r) => r.table).join(', ')}`,
    );
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
          'id,subject_ref,user_id,status,grace_period_ends_at,attempt_count,restored_at,purged_at,legal_hold_until,worker_lease_expires_at',
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

      // P1-4: surface conditions an operator must act on, straight from the
      // read-only health-check path. A request dead-lettered to 'failed', or
      // stuck in 'purging' past its lease, will not resolve on its own.
      const now = Date.now();
      for (const row of inventory.data ?? []) {
        if (row.status === 'failed') {
          alertEvent('deletion_request_failed_seen_in_dry_run', {
            requestIdPrefix: String(row.id).slice(0, 8),
            attemptCount: (row as { attempt_count?: number }).attempt_count ?? null,
          });
        } else if (row.status === 'purging') {
          const lease = (row as { worker_lease_expires_at?: string }).worker_lease_expires_at;
          if (!lease || new Date(lease).getTime() < now) {
            alertEvent('deletion_request_stuck_purging', {
              requestIdPrefix: String(row.id).slice(0, 8),
              hasUser: Boolean(row.user_id),
            });
          }
        }
      }

      // INT-KPLUS-010: report what the orphan sweep WOULD remove. dryRun: true
      // means it lists and reference-checks but deletes nothing and settles
      // nothing, so a dry run stays genuinely read-only.
      const orphanSweepPlan = await sweepOrphanedOwnerMedia(supabase, { dryRun: true });

      logEvent('worker_dry_run', {
        ...summary,
        orphanSweepPlan,
        killSwitchEnabled: enabled,
        dryRunFlag,
        envDryRun,
      });
      return json({
        mode: 'dry_run',
        killSwitchEnabled: enabled,
        dryRun: true,
        summary,
        orphanSweepPlan,
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
        // P1-4: if that transition dead-lettered the request (attempts
        // exhausted -> terminal 'failed'), raise an operator alert. A
        // partially-purged user stuck in 'failed' needs manual attention.
        const after = await supabase
          .from('deletion_requests')
          .select('status,attempt_count')
          .eq('id', row.id)
          .maybeSingle();
        if (after.data?.status === 'failed') {
          alertEvent('deletion_request_dead_lettered', {
            requestIdPrefix: String(row.id).slice(0, 8),
            attemptCount: after.data.attempt_count ?? null,
            code: 'PURGE_ERROR',
          });
        }
        results.push({ requestId: row.id, status: 'retry_or_failed', error: message.slice(0, 200) });
      }
    }

    // INT-KPLUS-010 -- scheduled orphan sweep. Runs on the LIVE path only
    // (kill switch on, dry-run off), after the purge loop, so a purge that just
    // registered a retained prefix is picked up on the next invocation rather
    // than being swept in the same breath it was written.
    //
    // Isolated from the purge outcome on purpose: a sweep failure must never
    // turn a successful purge run into a failed one, and vice versa.
    let orphanSweep = null;
    try {
      orphanSweep = await sweepOrphanedOwnerMedia(supabase, { dryRun: false });
      if (orphanSweep.removed > 0 || orphanSweep.skipped > 0) {
        logEvent('orphan_sweep_completed', orphanSweep);
      }
    } catch (error) {
      logEvent('orphan_sweep_failed', {
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }

    return json({
      mode: 'live',
      workerIdPrefix: workerId.slice(0, 16),
      claimed: claimedRows.length,
      results,
      orphanSweep,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('worker_unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json({ error: 'Worker failed' }, 500);
  }
});
