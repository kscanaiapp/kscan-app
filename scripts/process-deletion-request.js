#!/usr/bin/env node

// Thin CLI wrapper around the runtime-neutral hard-delete pipeline in
// lib/account-deletion/. This file stays CommonJS so the existing Node test
// suite (which uses require()) keeps working unchanged. The registry
// (USER_DATA_RESOURCES/STORAGE_RESOURCES) is loaded synchronously from the
// single JSON-backed source via lib/account-deletion/loadRegistry.cjs. The
// async pipeline functions (which were already awaited everywhere they are
// used) are lazily bridged to their ESM implementations in
// lib/account-deletion/processorCore.mjs via dynamic import() - this keeps
// exactly one implementation of the deletion logic while still exposing a
// synchronous require()-able CJS interface for the CLI and tests.

const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs/promises');
const path = require('node:path');

const { loadRegistry } = require('../lib/account-deletion/loadRegistry.cjs');

const {
  USER_DATA_RESOURCES,
  STORAGE_RESOURCES,
  SHARED_ROOM_TRANSFER_POLICY,
  REQUIRED_REGISTRY_TABLES,
} = loadRegistry();

// Legacy statuses ('pending', 'processing') are the original request-based
// model. 'deactivated'/'purging' are the new grace-period lifecycle states.
// Both are "open" for the CLI's list/get/process operations.
const OPEN_STATUSES = ['pending', 'processing', 'deactivated', 'purging'];

let corePromise;
function loadCore() {
  if (!corePromise) {
    corePromise = import('../lib/account-deletion/processorCore.mjs');
  }
  return corePromise;
}

let helpersPromise;
function loadHelpers() {
  if (!helpersPromise) {
    helpersPromise = import('../lib/account-deletion/helpers.mjs');
  }
  return helpersPromise;
}

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

  --confirm-delete additionally refuses to proceed unless ALL of the following
  hold (these mirror the automated worker's gates so the CLI is not a way to
  bypass them):
    * the request's 30-day grace period has elapsed (never shortened);
    * the request has not been restored by the user;
    * the request is not already purged;
    * the request is not currently held by a live automated-worker lease;
    * the global account_deletion_worker_dry_run flag is confirmed disabled.
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

// shortUserId/appendNote are trivial, dependency-free helpers that are also
// exported here for CJS test compatibility, so they are kept as real
// synchronous functions (mirroring lib/account-deletion/helpers.mjs) rather
// than bridged through a dynamic import - callers rely on them returning a
// value immediately, not a Promise.
function shortUserId(userId) {
  return typeof userId === 'string' && userId.length > 8 ? `${userId.slice(0, 8)}...` : 'unknown';
}

function appendNote(existing, note) {
  const trimmed = typeof existing === 'string' ? existing.trim() : '';
  return trimmed ? `${trimmed}\n${note}` : note;
}

async function failIfError(result, label) {
  const helpers = await loadHelpers();
  return helpers.failIfError(result, label);
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
  // Select * so eligibility columns (grace_period_ends_at, restored_at,
  // purged_at, worker_lease_expires_at) are available to the safety gate
  // below without hard-coding a column list that a legacy schema might lack.
  let query = supabase
    .from('deletion_requests')
    .select('*')
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

// Standard statuses a manual purge may legitimately act on. A stale (crashed)
// 'purging' claim is allowed separately, only after the active-lease check.
const CLI_PURGE_ELIGIBLE_STATUSES = ['pending', 'processing', 'deactivated'];

// P1-3: the manual CLI previously shared none of the automated worker's
// safety gates -- it would purge a request that was still inside its 30-day
// grace period, one the user had restored, one already purged, or one the
// automated worker currently holds a live lease on. These are hard refusals;
// there is deliberately no override for the grace-period check (the global
// 30-day grace must not be shortened).
function assertCliPurgeEligible(request, now = new Date()) {
  if (request.purged_at || request.status === 'purged') {
    throw new Error('Refusing to purge: request is already purged.');
  }
  if (request.restored_at || request.status === 'restored') {
    throw new Error('Refusing to purge: request was restored by the user.');
  }
  if (
    request.grace_period_ends_at &&
    new Date(request.grace_period_ends_at) > now
  ) {
    throw new Error(
      'Refusing to purge: grace period has not elapsed. The 30-day deletion grace period must not be shortened.',
    );
  }
  if (request.status === 'purging') {
    const leaseActive =
      request.worker_lease_expires_at &&
      new Date(request.worker_lease_expires_at) > now;
    if (leaseActive) {
      throw new Error(
        'Refusing to purge: the automated worker holds an active lease on this request. Wait for the lease to expire or for the worker to finish.',
      );
    }
  }
}

// The set of statuses the atomic claim update is allowed to transition from,
// given the fetched request. A stale 'purging' row may be finished manually;
// everything else must come from the standard eligible set.
function cliEligibleStatuses(request) {
  return request.status === 'purging' ? ['purging'] : CLI_PURGE_ELIGIBLE_STATUSES;
}

// P1-3: the CLI had no linkage to the global dry-run flag, so a --confirm-delete
// run would purge for real even while account_deletion_worker_dry_run was ON.
// Fail CLOSED: proceed only if we can positively confirm the flag is disabled.
async function assertGlobalDryRunDisabled(supabase) {
  let row;
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'account_deletion_worker_dry_run')
      .maybeSingle();
    if (error) {
      throw new Error(
        `Refusing to purge: could not read account_deletion_worker_dry_run (${error.message}).`,
      );
    }
    row = data;
  } catch (err) {
    throw new Error(
      `Refusing to purge: could not confirm global dry-run is disabled (${err instanceof Error ? err.message : err}).`,
    );
  }
  if (!row) {
    throw new Error(
      'Refusing to purge: account_deletion_worker_dry_run flag not found; cannot confirm dry-run is disabled.',
    );
  }
  if (row.value?.enabled) {
    throw new Error(
      'Refusing to purge: global dry-run (account_deletion_worker_dry_run) is ON. Disable it before running a manual purge.',
    );
  }
}

// --- Bridged pipeline functions -------------------------------------------
// Each of these was already async/awaited everywhere it is called, so
// delegating to the single ESM implementation in processorCore.mjs via a
// lazily-cached dynamic import() is transparent to callers and to tests.

async function buildDeletionSummary(supabase, request) {
  const core = await loadCore();
  return core.buildDeletionSummary(supabase, request);
}

async function deleteDirectUserRows(supabase, userId) {
  const core = await loadCore();
  return core.deleteDirectUserRows(supabase, userId);
}

async function deleteOwnedStorageObjects(supabase, userId) {
  const core = await loadCore();
  return core.deleteOwnedStorageObjects(supabase, userId);
}

async function getSharedRoomsForUser(supabase, userId) {
  const core = await loadCore();
  return core.getSharedRoomsForUser(supabase, userId);
}

async function transferSharedRoomOwnership(supabase, userId) {
  const core = await loadCore();
  return core.transferSharedRoomOwnership(supabase, userId);
}

async function verifyDeletionCompleteness(supabase, userId) {
  const core = await loadCore();
  return core.verifyDeletionCompleteness(supabase, userId);
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

// Best-effort post-purge bookkeeping. deletion_requests now survives the
// Auth user deletion (its FK is ON DELETE SET NULL, not CASCADE - see
// lib/account-deletion/user-data-resources.json), so once the hard-delete
// pipeline finishes we mark the surviving row purged. This must never fail
// the overall deletion: legacy schemas may not have the new worker columns
// yet, and the row may already be gone under the old CASCADE FK.
async function markRequestPurged(supabase, request) {
  const purgedAt = new Date().toISOString();
  const fullPayload = {
    status: 'purged',
    purged_at: purgedAt,
    processed_at: purgedAt,
    claimed_by: null,
    claimed_at: null,
  };

  try {
    const result = await supabase.from('deletion_requests').update(fullPayload).eq('id', request.id).select('id');
    if (!result.error) return;

    const message = String(result.error.message ?? '');
    if (/column|schema cache|PGRST204|does not exist/i.test(message)) {
      // Legacy schema without the new worker columns yet - fall back to the
      // minimal update so the request is still marked complete.
      await supabase
        .from('deletion_requests')
        .update({ status: 'purged', processed_at: purgedAt })
        .eq('id', request.id)
        .select('id');
    } else {
      console.warn(`[process-deletion-request] mark_purged_failed: ${message}`);
    }
  } catch (error) {
    console.warn(
      `[process-deletion-request] mark_purged_best_effort_failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function processDeletionRequest(supabase, request, options) {
  const core = await loadCore();
  const startedAt = new Date().toISOString();
  const note = `Manual deletion processor started at ${startedAt}.`;
  const safeUserId = shortUserId(request.user_id);

  // Deletion order (see docs/account-deletion-operations.md):
  // 1. Mark request processing and lock the profile.
  // 2. Direct-delete non-cascade rows first to avoid FK errors later.
  // 3. Transfer shared dressing rooms so other participants keep their data.
  // 4. Delete owned storage objects.
  // 5. Delete the Supabase Auth user last so auth FK cascades clean up the rest.
  // 6. Mark the surviving deletion_requests row purged (best-effort).

  // Atomic status-guarded claim (P1-3): constrain the transition to the
  // statuses this request is actually eligible to move from, so the CLI can
  // never stomp a row that changed concurrently (e.g. the user restored it,
  // or the automated worker claimed it) between fetch and update. If zero
  // rows match, the row moved under us -- abort rather than overwrite.
  const eligibleStatuses = cliEligibleStatuses(request);
  const markProcessingResult = await supabase
    .from('deletion_requests')
    .update({
      status: 'processing',
      notes: appendNote(request.notes, note),
    })
    .eq('id', request.id)
    .in('status', eligibleStatuses)
    .select('id');
  await failIfError(markProcessingResult, 'mark deletion request processing');
  if (!Array.isArray(markProcessingResult.data) || markProcessingResult.data.length !== 1) {
    throw new Error(
      'mark deletion request processing did not update exactly one eligible request (it may have been restored, claimed by the worker, or already purged concurrently)',
    );
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

  const pipelineResult = await core.runHardDeletePipeline(supabase, request, {
    afterAuthDelete: (client, req) => markRequestPurged(client, req),
  });

  const { authUserDeleted, summary, directDeletionResults, roomTransferResults, storageResults } = pipelineResult;

  const completedAt = new Date().toISOString();

  const auditPayload = {
    completedAt,
    deletionRequestId: request.id,
    requestedAt: request.requested_at,
    requestSource: request.request_source,
    userId: safeUserId,
    authUserDeleted,
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
    note: 'Shared rooms were transferred to the earliest remaining active participant before auth deletion. Supabase Auth user was deleted last; public rows with auth.users(id) foreign keys cascade. Known non-cascade rows and owned storage prefixes were handled first. deletion_requests survives the auth delete (ON DELETE SET NULL) and was marked purged.',
  };
  const auditFile = await writeAuditFile(options.outputDir, auditPayload);

  const result = {
    status: 'completed',
    completedAt,
    deletionRequestId: request.id,
    userId: safeUserId,
    authUserDeleted,
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

  // P1-3 safety gates before any destructive work: request must be genuinely
  // eligible (grace elapsed, not restored/purged, not held by a live worker
  // lease) and the global dry-run flag must be confirmed disabled.
  assertCliPurgeEligible(request);
  await assertGlobalDryRunDisabled(supabase);

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
  assertCliPurgeEligible,
  assertGlobalDryRunDisabled,
  buildDeletionSummary,
  cliEligibleStatuses,
  CLI_PURGE_ELIGIBLE_STATUSES,
  deleteDirectUserRows,
  deleteOwnedStorageObjects,
  getSharedRoomsForUser,
  OPEN_STATUSES,
  parseArgs,
  processDeletionRequest,
  REQUIRED_REGISTRY_TABLES,
  SHARED_ROOM_TRANSFER_POLICY,
  shortUserId,
  STORAGE_RESOURCES,
  transferSharedRoomOwnership,
  USER_DATA_RESOURCES,
  verifyDeletionCompleteness,
};
