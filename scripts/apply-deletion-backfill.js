#!/usr/bin/env node

// Applies the pending -> deactivated backfill described by
// scripts/preview-deletion-backfill.js. Only writes to the database when
// --confirm-backfill is passed; otherwise it behaves exactly like the
// preview script (read-only).
//
// For every legacy 'pending' deletion_requests row this:
//   1. Generates a fresh restoration token (lib/account-deletion/tokens.mjs).
//   2. Hashes it (SHA-256) and stores ONLY the hash on the row.
//   3. Sets status='deactivated' and grace_period_ends_at = max(requested_at
//      + 30 days, now() + 7 days) - the same formula as the preview script.
//   4. Optionally writes the PLAINTEXT tokens to a local file
//      (--write-tokens-file <path>) so a separate ops step can send the
//      restoration email/link. This script does NOT send email itself.
//
// Restoration emails are sent by a separate ops step (a Resend-backed edge
// function or equivalent) that reads the tokens file this script produces.
// That file contains secrets - keep it out of source control, delete it
// once the emails are sent, and never log its contents.

'use strict';

const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  computeGracePeriodEndsAt,
  fetchPendingRequests,
  shortUserId,
} = require('./preview-deletion-backfill.js');

let tokensPromise;
function loadTokens() {
  if (!tokensPromise) {
    tokensPromise = import('../lib/account-deletion/tokens.mjs');
  }
  return tokensPromise;
}

let helpersPromise;
function loadHelpers() {
  if (!helpersPromise) {
    helpersPromise = import('../lib/account-deletion/helpers.mjs');
  }
  return helpersPromise;
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

function parseArgs(argv) {
  const options = {
    confirmBackfill: false,
    help: false,
    limit: 200,
    writeTokensFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--confirm-backfill':
        options.confirmBackfill = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--limit': {
        const value = argv[i + 1];
        options.limit = Number.parseInt(value, 10);
        i += 1;
        break;
      }
      case '--write-tokens-file': {
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
          throw new Error('--write-tokens-file requires a path');
        }
        options.writeTokensFile = value;
        i += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error('--limit must be an integer between 1 and 1000');
  }

  return options;
}

function printHelp() {
  console.log(`K Scan deletion backfill apply

Usage:
  node scripts/apply-deletion-backfill.js [--limit <n>]
  node scripts/apply-deletion-backfill.js --confirm-backfill [--limit <n>] [--write-tokens-file <path>]

Environment:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Safety:
  Without --confirm-backfill this command is a read-only preview (identical
  to scripts/preview-deletion-backfill.js) and writes nothing.

  With --confirm-backfill, every legacy 'pending' deletion_requests row is
  moved to 'deactivated' with a grace_period_ends_at and a fresh, hashed
  restoration token. Only the SHA-256 hash is stored in the database.

  This script never sends restoration emails. Pass --write-tokens-file
  <path> to write the plaintext tokens to a local file for a separate ops
  step to send; that file is a secret and must not be committed or logged.
`);
}

async function applyBackfillForRequest(supabase, request, gracePeriodEndsAt, restorationTokenHash) {
  const nowIso = new Date().toISOString();
  const helpers = await loadHelpers();
  const note = `Backfilled to deactivated lifecycle state at ${nowIso}.`;

  const result = await supabase
    .from('deletion_requests')
    .update({
      status: 'deactivated',
      deactivated_at: nowIso,
      grace_period_ends_at: gracePeriodEndsAt,
      restoration_token_hash: restorationTokenHash,
      notes: helpers.appendNote(request.notes, note),
    })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('id');

  if (result.error) {
    const message = String(result.error.message ?? '');
    if (/column|schema cache|PGRST204|does not exist/i.test(message)) {
      throw new Error(
        `update deletion_requests ${request.id}: ${message}. The account-deletion lifecycle migration ` +
          '(grace_period_ends_at/restoration_token_hash/deactivated_at columns) must be applied before running ' +
          'this backfill.',
      );
    }
    throw new Error(`update deletion_requests ${request.id}: ${message}`);
  }

  if (!Array.isArray(result.data) || result.data.length !== 1) {
    // Row was concurrently claimed/updated by something else since the
    // preview query ran; skip it rather than risk a double-backfill.
    return { requestId: request.id, applied: false, reason: 'not_still_pending' };
  }

  return { requestId: request.id, applied: true };
}

async function writeTokensFile(filePath, tokenRecords) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    warning:
      'SECRET - contains plaintext restoration tokens. Send restoration emails from this file via the ops ' +
      'resend step, then delete this file. Do not commit or log its contents.',
    tokens: tokenRecords,
  };
  await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return resolved;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { status: 'help' };
  }

  const supabase = createSupabaseAdminClient();
  const pendingRequests = await fetchPendingRequests(supabase, options.limit);
  const tokens = await loadTokens();

  if (!options.confirmBackfill) {
    const preview = pendingRequests.map((request) => ({
      requestId: request.id,
      partialUserId: shortUserId(request.user_id),
      backfillTo: { status: 'deactivated', gracePeriodEndsAt: computeGracePeriodEndsAt(request.requested_at) },
    }));
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          pendingRequestCount: preview.length,
          preview,
          note: 'Refusing to write without --confirm-backfill. Nothing was changed.',
        },
        null,
        2,
      ),
    );
    return { status: 'dry-run', count: preview.length };
  }

  const results = [];
  const tokenRecords = [];

  for (const request of pendingRequests) {
    const gracePeriodEndsAt = computeGracePeriodEndsAt(request.requested_at);
    const restorationToken = await tokens.generateRestorationToken();
    const restorationTokenHash = await tokens.hashRestorationToken(restorationToken);

    const outcome = await applyBackfillForRequest(supabase, request, gracePeriodEndsAt, restorationTokenHash);
    results.push({ ...outcome, partialUserId: shortUserId(request.user_id), gracePeriodEndsAt });

    if (outcome.applied) {
      tokenRecords.push({
        requestId: request.id,
        userId: request.user_id,
        gracePeriodEndsAt,
        restorationToken,
      });
    }
  }

  let tokensFile = null;
  if (options.writeTokensFile) {
    if (tokenRecords.length > 0) {
      tokensFile = await writeTokensFile(options.writeTokensFile, tokenRecords);
    }
  }

  const summary = {
    status: 'completed',
    completedAt: new Date().toISOString(),
    requestsProcessed: results.length,
    requestsBackfilled: results.filter((r) => r.applied).length,
    results,
    tokensFile,
    note: tokensFile
      ? `Plaintext restoration tokens were written to ${tokensFile}. Send restoration emails from a separate ops step, then delete that file.`
      : options.writeTokensFile
        ? 'No rows were backfilled, so no tokens file was written.'
        : 'No --write-tokens-file was given; plaintext tokens were not persisted anywhere and cannot be recovered. Re-run with --write-tokens-file if restoration emails still need to be sent for these requests.',
  };

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  applyBackfillForRequest,
  parseArgs,
  writeTokensFile,
};
