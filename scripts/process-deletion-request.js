#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs/promises');
const path = require('node:path');

const OPEN_STATUSES = ['pending', 'processing'];
const USER_DATA_RESOURCES = [
  { table: 'profiles', column: 'id', action: 'auth_delete_cascade' },
  { table: 'privacy_settings', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'user_stylist_preferences', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'privacy_export_requests', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'privacy_correction_requests', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'deletion_requests', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'legal_acceptances', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'saved_scans', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_rooms', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_items', column: null, action: 'parent_room_cascade', count: false },
  { table: 'dressing_room_inspiration_items', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_item_reactions', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_messages', column: 'sender_id', action: 'auth_delete_cascade' },
  { table: 'dressing_room_participants', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'room_shares', column: 'owner_id', action: 'auth_delete_cascade' },
  { table: 'looks', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'look_items', column: null, action: 'parent_look_cascade', count: false },
  // Outfit decisions (AI Stylist expansion): groups live under the dressing
  // room boundary; a deleted creator only nullifies created_by. Votes cast by
  // the deleted user in OTHER users' rooms are removed by the user_id cascade.
  { table: 'outfit_decision_groups', column: 'created_by', action: 'auth_delete_set_null', optional: true },
  { table: 'outfit_decision_options', column: null, action: 'parent_room_cascade', count: false, optional: true },
  { table: 'outfit_decision_option_items', column: null, action: 'parent_room_cascade', count: false, optional: true },
  { table: 'outfit_decision_votes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_outfit_daily_usage', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_outfit_burst_usage', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'inspiration_items', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_sessions', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_messages', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_memory_events', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_usage', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_daily_usage', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'scan_identify_usage_daily', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'content_reports', column: 'reporter_user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'content_reports', column: 'reported_user_id', action: 'auth_delete_set_null', optional: true },
  { table: 'wardrobe_utility_items', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_collections', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_collection_items', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_brand_sizing_notes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_outfit_feedback', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_care_notes', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_wishlist_intents', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_wear_events', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'wardrobe_activity_log', column: 'user_id', action: 'auth_delete_cascade', optional: true },
  { table: 'style_chat_burst_usage', column: 'user_id', action: 'direct_delete_before_auth', optional: true },
  { table: 'scan_intelligence_events', column: 'user_id', action: 'direct_delete_before_auth', optional: true },
];

const DIRECT_DELETE_RESOURCES = USER_DATA_RESOURCES.filter(
  (resource) => resource.action === 'direct_delete_before_auth',
);

// Rooms owned by the deleted user are transferred to the earliest remaining
// active participant (verified profile status and auth user existence) so that
// other users' data (items, messages, participants) is not removed by the
// auth.users cascade. Rooms with no valid active participant are left to cascade
// normally. See docs/account-deletion-operations.md.
const SHARED_ROOM_TRANSFER_POLICY = 'transfer_to_earliest_active_participant';

// Only the style-library-images bucket is known to hold user-owned objects.
// Prefixes are intentionally explicit to avoid accidentally listing/deleting
// non-user folders. If a new user-owned prefix is added, register it here.
const STORAGE_RESOURCES = [
  {
    bucket: 'style-library-images',
    // saved-scans: Phase 2 remote media backing for saved_scans rows
    // ({userId}/saved-scans/{savedScanId}.jpg).
    prefixesForUser: (userId) => [
      `${userId}/scans`,
      `${userId}/inspirations`,
      `${userId}/saved-scans`,
    ],
  },
];

function printHelp() {
  console.log(`K Scan account deletion processor

Usage:
  node scripts/process-deletion-request.js --list-pending
  node scripts/process-deletion-request.js --request-id <uuid> [--dry-run] [--output-dir <path>]
  node scripts/process-deletion-request.js --request-id <uuid> --confirm-delete [--output-dir <path>]
  node scripts/process-deletion-request.js --request-id <uuid> --confirm-delete --verify [--output-dir <path>]
  node scripts/process-deletion-request.js --user-id <uuid> [--dry-run] [--output-dir <path>]
  node scripts/process-deletion-request.js --user-id <uuid> --confirm-delete [--output-dir <path>]

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Safety:
  The command is dry-run by default. It only deletes the Supabase Auth user when
  --confirm-delete is present. Deleting the auth user cascades the local public
  rows that reference auth.users(id). Use --verify to run a read-only
  completeness check after a confirmed deletion.
`);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    confirmDelete: false,
    dryRun: true,
    help: false,
    json: false,
    listPending: false,
    limit: 20,
    outputDir: null,
    requestId: null,
    userId: null,
    verify: false,
  };

  const destructiveFlagOccurrences = argv.filter((arg) => arg === '--confirm-delete' || arg === '--dry-run').length;
  if (destructiveFlagOccurrences > 1) {
    throw new Error('--confirm-delete and --dry-run are mutually exclusive');
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--confirm-delete':
        options.confirmDelete = true;
        options.dryRun = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        options.confirmDelete = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--limit':
        options.limit = Number.parseInt(takeValue(argv, i, arg), 10);
        i += 1;
        break;
      case '--list-pending':
        options.listPending = true;
        break;
      case '--output-dir':
        options.outputDir = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--request-id':
        options.requestId = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--user-id':
        options.userId = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--verify':
        options.verify = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error('--limit must be an integer between 1 and 100');
  }

  const selectors = [options.listPending, Boolean(options.requestId), Boolean(options.userId)].filter(Boolean);
  if (!options.help && selectors.length !== 1) {
    throw new Error('Choose exactly one selector: --list-pending, --request-id, or --user-id');
  }

  return options;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// The service-role key is required for all deletion operations. The anon key
// must never be used here because it cannot delete storage objects or auth users.
function createSupabaseAdminClient() {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function appendNote(existing, note) {
  const trimmed = typeof existing === 'string' ? existing.trim() : '';
  return trimmed ? `${trimmed}\n${note}` : note;
}

function shortUserId(userId) {
  return typeof userId === 'string' && userId.length > 8 ? `${userId.slice(0, 8)}...` : 'unknown';
}

function isMissingResourceError(error) {
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

async function failIfError(result, label) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  return result;
}

const ELIGIBLE_TRANSFER_STATUSES = ['active'];
const INELIGIBLE_TRANSFER_STATUSES = ['pending_deletion', 'locked', 'suspended', 'deleted'];

async function validateTransferCandidate(supabase, candidateUserId) {
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

async function listPendingRequests(supabase, limit) {
  const result = await supabase
    .from('deletion_requests')
    .select('id,user_id,status,requested_at,request_source')
    .in('status', OPEN_STATUSES)
    .order('requested_at', { ascending: true })
    .limit(limit);
  return (await failIfError(result, 'list pending deletion requests')).data ?? [];
}

async function getOpenRequest(supabase, options) {
  let query = supabase
    .from('deletion_requests')
    .select('id,user_id,status,requested_at,request_source,notes')
    .in('status', OPEN_STATUSES)
    .order('requested_at', { ascending: false })
    .limit(1);

  if (options.requestId) {
    query = query.eq('id', options.requestId);
  } else {
    query = query.eq('user_id', options.userId);
  }

  const result = await failIfError(await query, 'fetch open deletion request');
  const request = Array.isArray(result.data) ? result.data[0] : null;
  if (!request) {
    throw new Error('No pending or processing deletion request matched the selector');
  }
  return request;
}

async function maybeSingle(supabase, table, select, column, value) {
  const result = await supabase.from(table).select(select).eq(column, value).maybeSingle();
  return (await failIfError(result, `fetch ${table}`)).data ?? null;
}

async function countRows(supabase, table, column, value) {
  const result = await supabase.from(table).select('*', { count: 'exact', head: true }).eq(column, value);
  return (await failIfError(result, `count ${table}`)).count ?? 0;
}

async function countResourceRows(supabase, resource, userId) {
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

async function deleteDirectUserRows(supabase, userId) {
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

async function listStoragePrefix(storageBucket, prefix) {
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

async function deleteOwnedStorageObjects(supabase, userId) {
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

      const { error } = await bucket.remove(listing.paths);
      if (error) {
        throw new Error(`remove storage ${prefix}: ${error.message}`);
      }

      results.push({
        bucket: resource.bucket,
        prefix: sanitizedPrefix,
        status: 'removed',
        pathsAttempted: listing.paths.length,
      });
    }
  }
  return results;
}

async function getOwnedRooms(supabase, userId) {
  const result = await supabase.from('dressing_rooms').select('id,title').eq('user_id', userId);
  return (await failIfError(result, 'list owned dressing rooms')).data ?? [];
}

async function getSharedRoomsForUser(supabase, userId) {
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

function sanitizeSharedRoomForOutput(room) {
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

async function transferSharedRoomOwnership(supabase, userId) {
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

async function buildDeletionSummary(supabase, request) {
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

  if (authUserResult.error) {
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

async function writeAuditFile(outputDir, payload) {
  if (!outputDir) return null;
  const resolved = path.resolve(outputDir);
  await fs.mkdir(resolved, { recursive: true });
  const safeTime = payload.completedAt.replace(/[:.]/g, '-');
  const filename = `deletion-${payload.userId}-${safeTime}.json`;
  const fullPath = path.join(resolved, filename);
  await fs.writeFile(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return fullPath;
}

async function verifyDeletionCompleteness(supabase, userId) {
  const residuals = [];
  for (const resource of USER_DATA_RESOURCES) {
    // Parent-cascade tables are verified through their parent row lifecycle.
    // deletion_requests is the operational request record and is expected to
    // cascade away with the auth user; it is excluded from residual checks.
    if (!resource.column || resource.table === 'deletion_requests') continue;

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
  if (!authUserResult.error && authUserResult.data?.user) {
    residuals.push({ table: 'auth.users', column: 'id', count: 1 });
  }

  return { passed: residuals.length === 0, residuals };
}

async function processDeletionRequest(supabase, request, options) {
  const startedAt = new Date().toISOString();
  const note = `Manual deletion processor started at ${startedAt}.`;
  const safeUserId = shortUserId(request.user_id);

  // Deletion order (see docs/account-deletion-operations.md):
  // 1. Mark request processing and lock the profile.
  // 2. Direct-delete non-cascade rows first to avoid FK errors later.
  // 3. Transfer shared dressing rooms so other participants keep their data.
  // 4. Delete owned storage objects.
  // 5. Delete the Supabase Auth user last so auth FK cascades clean up the rest.

  const markProcessingResult = await supabase
    .from('deletion_requests')
    .update({
      status: 'processing',
      notes: appendNote(request.notes, note),
    })
    .eq('id', request.id)
    .select('id');
  await failIfError(markProcessingResult, 'mark deletion request processing');
  if (!Array.isArray(markProcessingResult.data) || markProcessingResult.data.length !== 1) {
    throw new Error('mark deletion request processing did not update exactly one open request');
  }

  const lockProfileResult = await supabase
    .from('profiles')
    .update({
      account_status: 'pending_deletion',
      account_locked_at: startedAt,
      deletion_requested_at: request.requested_at,
    })
    .eq('id', request.user_id)
    .select('id');
  await failIfError(lockProfileResult, 'lock profile before auth deletion');
  if (!Array.isArray(lockProfileResult.data) || lockProfileResult.data.length !== 1) {
    throw new Error('lock profile before auth deletion did not update exactly one profile');
  }

  const directDeletionResults = await deleteDirectUserRows(supabase, request.user_id);
  const roomTransferResults = await transferSharedRoomOwnership(supabase, request.user_id);
  const storageResults = await deleteOwnedStorageObjects(supabase, request.user_id);
  const deleteResult = await supabase.auth.admin.deleteUser(request.user_id);
  if (deleteResult.error) {
    throw new Error(`delete auth user: ${deleteResult.error.message}`);
  }

  const completedAt = new Date().toISOString();
  const summary = {
    authUserDeleted: true,
    roomsTransferred: roomTransferResults.filter((entry) => entry.action === 'transfer').length,
    storagePrefixesProcessed: storageResults.length,
    storageObjectsRemoved: storageResults.reduce((sum, entry) => sum + (entry.pathsAttempted ?? 0), 0),
    directRowsDeleted: directDeletionResults.reduce(
      (sum, entry) => sum + (typeof entry.count === 'number' ? entry.count : 0),
      0,
    ),
  };

  const auditPayload = {
    completedAt,
    deletionRequestId: request.id,
    requestedAt: request.requested_at,
    requestSource: request.request_source,
    userId: safeUserId,
    authUserDeleted: summary.authUserDeleted,
    summary,
    roomTransferResults,
    storageResults,
    directDeletionResults,
    deletionCoverage: USER_DATA_RESOURCES.map(({ table, column, action, optional }) => ({
      table,
      column,
      action,
      optional: Boolean(optional),
    })),
    note: 'Shared rooms were transferred to the earliest remaining active participant before auth deletion. Supabase Auth user was deleted last; public rows with auth.users(id) foreign keys cascade. Known non-cascade rows and owned storage prefixes were handled first.',
  };
  const auditFile = await writeAuditFile(options.outputDir, auditPayload);

  const result = {
    status: 'completed',
    completedAt,
    deletionRequestId: request.id,
    userId: safeUserId,
    authUserDeleted: summary.authUserDeleted,
    summary,
    roomTransferResults,
    storageResults,
    directDeletionResults,
    auditFile,
  };

  if (options.verify) {
    result.verification = await verifyDeletionCompleteness(supabase, request.user_id);
  }

  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { status: 'help' };
  }

  const supabase = createSupabaseAdminClient();
  if (options.listPending) {
    const requests = await listPendingRequests(supabase, options.limit);
    console.log(JSON.stringify({ pendingDeletionRequests: requests }, null, 2));
    return { status: 'listed', count: requests.length };
  }

  const request = await getOpenRequest(supabase, options);
  const summary = await buildDeletionSummary(supabase, request);

  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
    return { status: 'dry-run', requestId: request.id, userId: request.user_id };
  }

  if (!options.confirmDelete) {
    throw new Error('Refusing to delete without --confirm-delete');
  }

  const result = await processDeletionRequest(supabase, request, options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  appendNote,
  buildDeletionSummary,
  deleteDirectUserRows,
  deleteOwnedStorageObjects,
  getSharedRoomsForUser,
  parseArgs,
  processDeletionRequest,
  shortUserId,
  STORAGE_RESOURCES,
  transferSharedRoomOwnership,
  USER_DATA_RESOURCES,
  verifyDeletionCompleteness,
};
