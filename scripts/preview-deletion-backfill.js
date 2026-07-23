#!/usr/bin/env node

// Read-only preview of the pending -> deactivated backfill for legacy
// deletion_requests rows. Computes, for every open request still on the
// old 'pending' status, the grace_period_ends_at it would receive once the
// new lifecycle columns are applied:
//
//   grace = max(requested_at + 30 days, now() + 7 days)
//
// This never writes to the database. Use scripts/apply-deletion-backfill.js
// (with --confirm-backfill) to actually perform the backfill.

'use strict';

const { createClient } = require('@supabase/supabase-js');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

function shortUserId(userId) {
  return typeof userId === 'string' && userId.length > 8 ? `${userId.slice(0, 8)}...` : 'unknown';
}

/**
 * grace = max(requested_at + 30 days, now() + 7 days)
 *
 * Legacy 'pending' rows may already be older than 30 days (the manual
 * process was never guaranteed to run within 30 days), so this floors every
 * backfilled request to at least a 7-day grace period from the moment the
 * backfill runs, even if requested_at + 30 days has already passed.
 */
function computeGracePeriodEndsAt(requestedAt, now = new Date()) {
  const requestedAtMs = new Date(requestedAt).getTime();
  const byRequestAge = requestedAtMs + THIRTY_DAYS_MS;
  const byMinimumGrace = now.getTime() + SEVEN_DAYS_MS;
  return new Date(Math.max(byRequestAge, byMinimumGrace)).toISOString();
}

function parseArgs(argv) {
  const options = { limit: 200, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--limit') {
      const value = argv[i + 1];
      options.limit = Number.parseInt(value, 10);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error('--limit must be an integer between 1 and 1000');
  }
  return options;
}

function printHelp() {
  console.log(`K Scan deletion backfill preview (read-only)

Usage:
  node scripts/preview-deletion-backfill.js [--limit <n>]

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

This command never writes to the database. It prints, as JSON, the
grace_period_ends_at every legacy 'pending' deletion_requests row would
receive if scripts/apply-deletion-backfill.js were run right now.
`);
}

async function fetchPendingRequests(supabase, limit) {
  const result = await supabase
    .from('deletion_requests')
    .select('id,user_id,status,requested_at,request_source')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(limit);
  if (result.error) {
    throw new Error(`fetch pending deletion requests: ${result.error.message}`);
  }
  return result.data ?? [];
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { status: 'help' };
  }

  const supabase = createSupabaseAdminClient();
  const now = new Date();
  const pendingRequests = await fetchPendingRequests(supabase, options.limit);

  const preview = pendingRequests.map((request) => {
    const gracePeriodEndsAt = computeGracePeriodEndsAt(request.requested_at, now);
    return {
      requestId: request.id,
      partialUserId: shortUserId(request.user_id),
      currentStatus: request.status,
      requestSource: request.request_source,
      requestedAt: request.requested_at,
      backfillTo: {
        status: 'deactivated',
        gracePeriodEndsAt,
      },
      graceRemainingFromNowMs: new Date(gracePeriodEndsAt).getTime() - now.getTime(),
    };
  });

  const output = {
    dryRun: true,
    generatedAt: now.toISOString(),
    pendingRequestCount: preview.length,
    preview,
    note:
      'Read-only preview. No rows were modified. Run scripts/apply-deletion-backfill.js --confirm-backfill to apply this backfill.',
  };

  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  computeGracePeriodEndsAt,
  fetchPendingRequests,
  parseArgs,
  shortUserId,
};
