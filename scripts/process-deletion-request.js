#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs/promises');
const path = require('node:path');

const OPEN_STATUSES = ['pending', 'processing'];
const COUNT_TABLES = [
  'profiles',
  'privacy_settings',
  'privacy_export_requests',
  'privacy_correction_requests',
  'deletion_requests',
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

async function buildDeletionSummary(supabase, request) {
  const userId = request.user_id;
  const [profile, authUserResult, counts] = await Promise.all([
    maybeSingle(
      supabase,
      'profiles',
      'id,email,account_status,account_locked_at,deletion_requested_at',
      'id',
      userId,
    ),
    supabase.auth.admin.getUserById(userId),
    Promise.all(COUNT_TABLES.map(async (table) => [table, await countRows(supabase, table, table === 'profiles' ? 'id' : 'user_id', userId)])),
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
    linkedRowCounts: Object.fromEntries(counts),
    localDeviceDataNote: 'Saved scan thumbnails live in the app sandbox and are removed by in-app delete or app uninstall; they are not server-side Supabase rows.',
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
    userId: request.user_id,
    note: 'Supabase Auth user deleted. Public rows with auth.users(id) foreign keys are expected to cascade.',
  };
  const auditFile = await writeAuditFile(options.outputDir, auditPayload);

  return {
    status: 'completed',
    completedAt,
    deletionRequestId: request.id,
    userId: request.user_id,
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
  parseArgs,
  processDeletionRequest,
};
