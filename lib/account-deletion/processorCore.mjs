// Runtime-neutral hard-delete pipeline core. Extracted from
// scripts/process-deletion-request.js so the same logic can be driven by the
// manual CLI, a future automated worker/scheduler, or tests, without
// depending on Node's fs/path/process. All sanitization (shortUserId in
// outputs, no email addresses) is preserved from the original CLI script.

import {
  ELIGIBLE_TRANSFER_STATUSES,
  INELIGIBLE_TRANSFER_STATUSES,
  failIfError,
  isMissingResourceError,
  shortUserId,
} from './helpers.mjs';
import {
  SHARED_ROOM_TRANSFER_POLICY,
  STORAGE_RESOURCES,
  USER_DATA_RESOURCES,
} from './userDataResources.mjs';
import { runAppleRevocationStep } from './appleRevocation.mjs';

const DIRECT_DELETE_RESOURCES = USER_DATA_RESOURCES.filter(
  (resource) => resource.action === 'direct_delete_before_auth',
);

function isUserNotFoundError(error) {
  if (!error) return false;
  const status = Number(error.status ?? error.code ?? NaN);
  const message = String(error.message ?? '').toLowerCase();
  return (
    status === 404 ||
    message.includes('user not found') ||
    message.includes('not_found') ||
    message.includes('no user found')
  );
}

export async function validateTransferCandidate(supabase, candidateUserId) {
  const profileResult = await supabase
    .from('profiles')
    .select('id,account_status')
    .eq('id', candidateUserId)
    .maybeSingle();
  if (profileResult.error) {
    return { valid: false, reason: 'profile_lookup_error' };
  }
  if (!profileResult.data) {
    return { valid: false, reason: 'profile_missing' };
  }
  if (INELIGIBLE_TRANSFER_STATUSES.includes(profileResult.data.account_status)) {
    return { valid: false, reason: `status_ineligible:${profileResult.data.account_status}` };
  }
  if (!ELIGIBLE_TRANSFER_STATUSES.includes(profileResult.data.account_status)) {
    return { valid: false, reason: `status_not_active:${profileResult.data.account_status}` };
  }
  const authResult = await supabase.auth.admin.getUserById(candidateUserId);
  if (authResult.error) {
    return { valid: false, reason: 'auth_lookup_error' };
  }
  if (!authResult.data?.user) {
    return { valid: false, reason: 'auth_user_missing' };
  }
  return { valid: true, reason: null };
}

async function maybeSingle(supabase, table, select, column, value) {
  const result = await supabase.from(table).select(select).eq(column, value).maybeSingle();
  return (await failIfError(result, `fetch ${table}`)).data ?? null;
}

export async function countResourceRows(supabase, resource, userId) {
  if (resource.count === false || !resource.column) {
    return {
      table: resource.table,
      column: resource.column,
      action: resource.action,
      count: null,
      covered: true,
      notes: 'Covered through parent-row cascade.',
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
        notes: 'Optional table not present in this project.',
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
    notes: resource.optional ? 'Optional feature table; covered when present.' : 'Covered.',
  };
}

export async function deleteDirectUserRows(supabase, userId) {
  const results = [];
  for (const resource of DIRECT_DELETE_RESOURCES) {
    const result = await supabase
      .from(resource.table)
      .delete({ count: 'exact' })
      .eq(resource.column, userId);

    if (result.error) {
      if (resource.optional && isMissingResourceError(result.error)) {
        results.push({
          table: resource.table,
          column: resource.column,
          status: 'skipped_missing_optional_table',
          count: null,
        });
        continue;
      }
      throw new Error(`delete ${resource.table}: ${result.error.message}`);
    }

    results.push({
      table: resource.table,
      column: resource.column,
      status: 'deleted',
      count: result.count ?? null,
    });
  }
  return results;
}

export async function listStoragePrefix(storageBucket, prefix) {
  const paths = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await storageBucket.list(prefix, { limit, offset });
    if (error) {
      if (isMissingResourceError(error)) {
        return { paths, skipped: true, reason: 'missing_storage_prefix_or_bucket' };
      }
      throw new Error(`list storage ${prefix}: ${error.message}`);
    }

    const page = Array.isArray(data) ? data : [];
    for (const item of page) {
      if (item?.name) paths.push(`${prefix}/${item.name}`);
    }

    if (page.length < limit) break;
    offset += limit;
  }

  return { paths, skipped: false, reason: null };
}

// Storage paths still referenced by a dressing_room_items row that survives
// this purge (rows cascade with their room, not the deleting user, so a room
// transferred to another owner keeps them). Paginated; fail-closed on error.
// This brings the manual CLI to parity with the automated worker's
// deleteOwnedStorage -- previously the CLI had NO reference check and would
// delete scan images still displayed in a just-transferred room owned by a
// surviving user (Finding P1-2, the genuine cross-user data-loss path).
export async function collectReferencedStoragePaths(supabase, prefix) {
  const referenced = new Set();
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

export async function deleteOwnedStorageObjects(supabase, userId) {
  const results = [];
  for (const resource of STORAGE_RESOURCES) {
    const bucket = supabase.storage.from(resource.bucket);
    for (const prefix of resource.prefixesForUser(userId)) {
      const sanitizedPrefix = prefix.replace(userId, shortUserId(userId));
      const listing = await listStoragePrefix(bucket, prefix);
      if (listing.skipped) {
        results.push({
          bucket: resource.bucket,
          prefix: sanitizedPrefix,
          status: listing.reason,
          pathsAttempted: 0,
        });
        continue;
      }

      if (listing.paths.length === 0) {
        results.push({
          bucket: resource.bucket,
          prefix: sanitizedPrefix,
          status: 'no_objects',
          pathsAttempted: 0,
        });
        continue;
      }

      const referenced = await collectReferencedStoragePaths(supabase, prefix);
      const removable = listing.paths.filter((p) => !referenced.has(p));
      const retained = listing.paths.length - removable.length;

      if (removable.length === 0) {
        results.push({
          bucket: resource.bucket,
          prefix: sanitizedPrefix,
          status: 'all_retained_referenced',
          pathsAttempted: 0,
          retainedReferenced: retained,
        });
        continue;
      }

      const { data: removedData, error } = await bucket.remove(removable);
      if (error) {
        throw new Error(`remove storage ${prefix}: ${error.message}`);
      }
      // P2-5: verify the removal actually happened. A 200 with fewer objects
      // than requested means a silent partial failure; re-list and fail
      // closed if any requested object genuinely survives.
      const removedCount = Array.isArray(removedData) ? removedData.length : removable.length;
      if (removedCount < removable.length) {
        const after = await listStoragePrefix(bucket, prefix);
        const afterSet = new Set(after.paths);
        const stillPresent = removable.filter((p) => afterSet.has(p));
        if (stillPresent.length > 0) {
          throw new Error(
            `remove storage ${prefix}: partial removal, ${stillPresent.length} objects still present`,
          );
        }
      }

      results.push({
        bucket: resource.bucket,
        prefix: sanitizedPrefix,
        status: 'removed',
        pathsAttempted: removable.length,
        retainedReferenced: retained,
      });
    }
  }
  return results;
}

export async function getOwnedRooms(supabase, userId) {
  const result = await supabase.from('dressing_rooms').select('id,title').eq('user_id', userId);
  return (await failIfError(result, 'list owned dressing rooms')).data ?? [];
}

export async function getSharedRoomsForUser(supabase, userId) {
  const rooms = await getOwnedRooms(supabase, userId);
  const shared = [];
  for (const room of rooms) {
    const participantsResult = await supabase
      .from('dressing_room_participants')
      .select('user_id,created_at')
      .eq('dressing_room_id', room.id)
      .order('created_at', { ascending: true });
    const participants = (await failIfError(participantsResult, `list participants for room ${room.id}`))
      .data ?? [];
    const candidates = [];
    let selectedRecipientId = null;
    let selectedJoinedAt = null;
    for (const participant of participants) {
      const validation = await validateTransferCandidate(supabase, participant.user_id);
      const candidate = {
        userId: participant.user_id,
        joinedAt: participant.created_at,
        status: validation.valid ? 'selected' : 'skipped',
        reason: validation.valid ? undefined : validation.reason,
      };
      candidates.push(candidate);
      if (validation.valid && selectedRecipientId === null) {
        selectedRecipientId = participant.user_id;
        selectedJoinedAt = participant.created_at;
      }
    }
    shared.push({
      roomId: room.id,
      roomTitle: room.title,
      candidateCount: participants.length,
      selectedRecipientId,
      selectedJoinedAt,
      noValidRecipient: selectedRecipientId === null,
      candidates,
    });
  }
  return shared;
}

export function sanitizeSharedRoomForOutput(room) {
  return {
    roomId: room.roomId,
    roomTitle: room.roomTitle,
    candidateCount: room.candidateCount,
    selectedRecipientId: room.selectedRecipientId ? shortUserId(room.selectedRecipientId) : null,
    noValidRecipient: room.noValidRecipient,
    candidates: room.candidates.map((c) => ({
      userId: shortUserId(c.userId),
      joinedAt: c.joinedAt,
      status: c.status,
      reason: c.reason,
    })),
  };
}

export async function transferSharedRoomOwnership(supabase, userId) {
  const sharedRooms = await getSharedRoomsForUser(supabase, userId);
  const transferredAt = new Date().toISOString();
  const results = [];
  for (const room of sharedRooms) {
    if (!room.selectedRecipientId) {
      results.push({
        roomId: room.roomId,
        roomTitle: room.roomTitle,
        action: 'no_valid_recipient',
        candidateCount: room.candidateCount,
        candidates: room.candidates.map((c) => ({
          userId: shortUserId(c.userId),
          reason: c.reason,
        })),
        note: 'No active remaining participant found; room will be removed by owner cascade.',
      });
      continue;
    }
    const updateResult = await supabase
      .from('dressing_rooms')
      .update({ user_id: room.selectedRecipientId, updated_at: transferredAt })
      .eq('id', room.roomId)
      .eq('user_id', userId)
      .select('id');
    await failIfError(updateResult, `transfer ownership of room ${room.roomId}`);
    if (!Array.isArray(updateResult.data) || updateResult.data.length !== 1) {
      throw new Error(`transfer ownership of room ${room.roomId} did not update exactly one row`);
    }
    results.push({
      roomId: room.roomId,
      roomTitle: room.roomTitle,
      action: 'transfer',
      newOwnerId: shortUserId(room.selectedRecipientId),
      newOwnerJoinedAt: room.selectedJoinedAt,
      candidateCount: room.candidateCount,
      candidates: room.candidates.map((c) => ({
        userId: shortUserId(c.userId),
        status: c.status,
        reason: c.reason,
      })),
      transferredAt,
    });
  }
  return results;
}

export async function buildDeletionSummary(supabase, request) {
  const userId = request.user_id;
  const [profile, authUserResult, coverage, sharedRoomCheck] = await Promise.all([
    maybeSingle(
      supabase,
      'profiles',
      'id,account_status,account_locked_at,deletion_requested_at',
      'id',
      userId,
    ),
    supabase.auth.admin.getUserById(userId),
    Promise.all(USER_DATA_RESOURCES.map((resource) => countResourceRows(supabase, resource, userId))),
    getSharedRoomsForUser(supabase, userId),
  ]);

  if (authUserResult.error && !isUserNotFoundError(authUserResult.error)) {
    throw new Error(`fetch auth user: ${authUserResult.error.message}`);
  }

  return {
    request: {
      id: request.id,
      partialUserId: shortUserId(request.user_id),
      status: request.status,
      requestedAt: request.requested_at,
      requestSource: request.request_source,
      notes: request.notes,
    },
    user: {
      partialUserId: shortUserId(userId),
      authUserExists: Boolean(authUserResult.data?.user),
      profile: profile
        ? {
            accountStatus: profile.account_status,
            accountLockedAt: profile.account_locked_at,
            deletionRequestedAt: profile.deletion_requested_at,
          }
        : null,
    },
    linkedRowCounts: Object.fromEntries(coverage.map((entry) => [entry.table, entry.count])),
    deletionCoverage: coverage,
    storageCoverage: STORAGE_RESOURCES.flatMap((resource) =>
      resource.prefixesForUser(userId).map((prefix) => ({
        bucket: resource.bucket,
        prefix: prefix.replace(userId, shortUserId(userId)),
        action: 'remove_owned_storage_objects_before_auth_delete',
      })),
    ),
    sharedRoomCheck: {
      policy: SHARED_ROOM_TRANSFER_POLICY,
      sharedRooms: sharedRoomCheck.map(sanitizeSharedRoomForOutput),
      note:
        'Shared rooms are transferred to the earliest remaining active participant before the original owner is deleted. Rooms with no valid active participant are removed with the owner.',
    },
    localDeviceDataNote:
      'Saved scan thumbnails in the app sandbox are removed by in-app delete or app uninstall; server-side deletion covers Supabase rows and owned storage objects.',
  };
}

export async function verifyDeletionCompleteness(supabase, userId) {
  const residuals = [];
  const notes = [];

  for (const resource of USER_DATA_RESOURCES) {
    // Parent-cascade tables are verified through their parent row lifecycle.
    if (!resource.column) continue;

    // deletion_requests is the operational request record. Its FK became
    // ON DELETE SET NULL (not CASCADE) so the row survives the Auth user
    // deletion by design - it is excluded from residual-by-user_id checks
    // for that reason, same as the legacy hardcoded exclusion this replaces.
    if (resource.action === 'survive_auth_delete') {
      notes.push(
        `${resource.table} intentionally excluded from residual checks: it is expected to survive with ${resource.column} = null after the Auth user is deleted.`,
      );
      continue;
    }

    const result = await supabase
      .from(resource.table)
      .select('*', { count: 'exact', head: true })
      .eq(resource.column, userId);

    if (result.error) {
      if (resource.optional && isMissingResourceError(result.error)) continue;
      throw new Error(`verify ${resource.table}: ${result.error.message}`);
    }

    const count = result.count ?? 0;
    if (count > 0) {
      residuals.push({ table: resource.table, column: resource.column, count });
    }
  }

  const authUserResult = await supabase.auth.admin.getUserById(userId);
  if (authUserResult.error) {
    // A "user not found" style error after we just deleted the Auth user is
    // success, not a failure to verify - the user is confirmed gone.
    if (!isUserNotFoundError(authUserResult.error)) {
      residuals.push({
        table: 'auth.users',
        column: 'id',
        count: 1,
        notes: `Unexpected error while confirming Auth user removal: ${authUserResult.error.message}`,
      });
    }
  } else if (authUserResult.data?.user) {
    residuals.push({ table: 'auth.users', column: 'id', count: 1 });
  }

  return { passed: residuals.length === 0, residuals, notes };
}

/**
 * Runs the full hard-delete pipeline for a single deletion request:
 *   1. Confirms the request has a user_id.
 *   2. Optionally revokes sessions via options.revokeSessions(supabase, request).
 *   3. Deletes direct (non-cascade) user rows.
 *   4. Transfers shared dressing-room ownership.
 *   5. Deletes owned storage objects.
 *   6. Calls options.beforeAuthDelete(supabase, request) if provided, so a
 *      caller can prepare a surviving record or write a ledger event before
 *      the Auth user (and its cascades) disappear.
 *   7. Deletes the Auth user.
 *   8. Treats "user not found" as a successful, idempotent delete.
 *   9. Calls options.afterAuthDelete(supabase, request) if provided.
 *  10. Returns a sanitized summary (no full user id, no email addresses).
 */
export async function runHardDeletePipeline(supabase, request, options = {}) {
  const userId = request?.user_id;
  if (!userId) {
    throw new Error('runHardDeletePipeline requires request.user_id');
  }

  if (typeof options.revokeSessions === 'function') {
    await options.revokeSessions(supabase, request);
  }

  const directDeletionResults = await deleteDirectUserRows(supabase, userId);
  const roomTransferResults = await transferSharedRoomOwnership(supabase, userId);
  const storageResults = await deleteOwnedStorageObjects(supabase, userId);

  if (typeof options.beforeAuthDelete === 'function') {
    await options.beforeAuthDelete(supabase, request);
  }

  // Apple authorization revocation (IOS29-NEW-003). Built into the pipeline
  // rather than passed in as a hook so every caller — the operator CLI, the
  // worker, and tests — gets it, and no future caller can omit an Apple
  // obligation by forgetting an option. It must run here: the auth delete below
  // cascades public.apple_auth_credentials away, after which the token needed
  // for revocation no longer exists. A still-retryable failure throws, leaving
  // the request open and nothing yet erased.
  const appleRevocation = await runAppleRevocationStep(supabase, request, {
    invoke: options.invokeAppleRevocation,
  });

  const deleteResult = await supabase.auth.admin.deleteUser(userId);
  if (deleteResult.error && !isUserNotFoundError(deleteResult.error)) {
    throw new Error(`delete auth user: ${deleteResult.error.message}`);
  }
  // Either the delete succeeded, or the user was already gone (idempotent).
  const authUserDeleted = true;

  if (typeof options.afterAuthDelete === 'function') {
    await options.afterAuthDelete(supabase, request);
  }

  const summary = {
    authUserDeleted,
    // Recorded in the deletion audit so an Apple revocation can be evidenced
    // after the fact. It is a status word, never a token.
    appleAuthorizationRevocation: appleRevocation.status,
    roomsTransferred: roomTransferResults.filter((entry) => entry.action === 'transfer').length,
    storagePrefixesProcessed: storageResults.length,
    storageObjectsRemoved: storageResults.reduce((sum, entry) => sum + (entry.pathsAttempted ?? 0), 0),
    directRowsDeleted: directDeletionResults.reduce(
      (sum, entry) => sum + (typeof entry.count === 'number' ? entry.count : 0),
      0,
    ),
  };

  return {
    authUserDeleted,
    appleRevocation,
    summary,
    directDeletionResults,
    roomTransferResults,
    storageResults,
  };
}

export { failIfError, isUserNotFoundError };
