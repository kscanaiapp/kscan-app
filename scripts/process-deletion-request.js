#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs/promises');
const path = require('node:path');

const OPEN_STATUSES = ['pending', 'processing'];
const USER_DATA_RESOURCES = [
  { table: 'profiles', column: 'id', action: 'auth_delete_cascade' },
  { table: 'privacy_settings', column: 'user_id', action: 'auth_delete_cascade' },
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
  { table: 'inspiration_items', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_sessions', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_messages', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_memory_events', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_usage', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'style_chat_daily_usage', column: 'user_id', action: 'auth_delete_cascade' },
  { table: 'scan_identify_usage_daily', column: 'user_id', action: 'auth_delete_cascade' },
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

const STORAGE_RESOURCES = [
  {
    bucket: 'style-library-images',
    prefixesForUser: (userId) => [`${userId}/scans`, `${userId}/inspirations`],
  },
];

function printHelp() {
  console.log(`K Scan account deletion processor

Usage:
  node scripts/process-deletion-request.js --list-pending
  node scripts/process-deletion-request.js --request-id <uuid> [--dry-run]
  node scripts/process-deletion-request.js --request-id <uuid> --confirm-delete
  node scripts/process-deletion-request.js --user-id <uuid> [--dry-run]
  node scripts/process-deletion-request.js --user-id <uuid> --confirm-delete

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Safety:
  The command is dry-run by default. It only deletes the Supabase Auth user when
  --confirm-delete is present. Deleting the auth user cascades the local public
  rows that reference auth.users(id).
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
  };

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
      const listing = await listStoragePrefix(bucket, prefix);
      if (listing.skipped) {
        results.push({
          bucket: resource.bucket,
          prefix,
          status: listing.reason,
          pathsAttempted: 0,
        });
        continue;
      }

      if (listing.paths.length === 0) {
        results.push({
          bucket: resource.bucket,
          prefix,
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
        prefix,
        status: 'removed',
        pathsAttempted: listing.paths.length,
      });
    }
  }
  return results;
}

async function buildDeletionSummary(supabase, request) {
  const userId = request.user_id;
  const [profile, authUserResult, coverage] = await Promise.all([
    maybeSingle(
      supabase,
      'profiles',
      'id,email,account_status,account_locked_at,deletion_requested_at',
      'id',
      userId,
    ),
    supabase.auth.admin.getUserById(userId),
    Promise.all(USER_DATA_RESOURCES.map((resource) => countResourceRows(supabase, resource, userId))),
  ]);

  if (authUserResult.error) {
    throw new Error(`fetch auth user: ${authUserResult.error.message}`);
  }

  return {
    request,
    user: {
      id: userId,
      email: profile?.email ?? authUserResult.data?.user?.email ?? null,
      authUserExists: Boolean(authUserResult.data?.user),
      profile,
    },
    linkedRowCounts: Object.fromEntries(coverage.map((entry) => [entry.table, entry.count])),
    deletionCoverage: coverage,
    storageCoverage: STORAGE_RESOURCES.flatMap((resource) =>
      resource.prefixesForUser(userId).map((prefix) => ({
        bucket: resource.bucket,
        prefix,
        action: 'remove_owned_storage_objects_before_auth_delete',
      })),
    ),
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

async function processDeletionRequest(supabase, request, options) {
  const startedAt = new Date().toISOString();
  const note = `Manual deletion processor started at ${startedAt}.`;
  const safeUserId = shortUserId(request.user_id);

  await failIfError(
    await supabase
      .from('deletion_requests')
      .update({
        status: 'processing',
        notes: appendNote(request.notes, note),
      })
      .eq('id', request.id),
    'mark deletion request processing',
  );

  await failIfError(
    await supabase
      .from('profiles')
      .update({
        account_status: 'pending_deletion',
        account_locked_at: startedAt,
        deletion_requested_at: request.requested_at,
      })
      .eq('id', request.user_id),
    'lock profile before auth deletion',
  );

  const storageResults = await deleteOwnedStorageObjects(supabase, request.user_id);
  const directDeletionResults = await deleteDirectUserRows(supabase, request.user_id);
  const deleteResult = await supabase.auth.admin.deleteUser(request.user_id);
  if (deleteResult.error) {
    throw new Error(`delete auth user: ${deleteResult.error.message}`);
  }

  const completedAt = new Date().toISOString();
  const auditPayload = {
    completedAt,
    deletionRequestId: request.id,
    requestedAt: request.requested_at,
    requestSource: request.request_source,
    userId: safeUserId,
    storageResults,
    directDeletionResults,
    deletionCoverage: USER_DATA_RESOURCES.map(({ table, column, action, optional }) => ({
      table,
      column,
      action,
      optional: Boolean(optional),
    })),
    note: 'Supabase Auth user deleted last. Public rows with auth.users(id) foreign keys are expected to cascade; known non-cascade rows and owned storage prefixes were handled first.',
  };
  const auditFile = await writeAuditFile(options.outputDir, auditPayload);

  return {
    status: 'completed',
    completedAt,
    deletionRequestId: request.id,
    userId: safeUserId,
    storageResults,
    directDeletionResults,
    auditFile,
  };
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
  parseArgs,
  processDeletionRequest,
  shortUserId,
  STORAGE_RESOURCES,
  USER_DATA_RESOURCES,
};
