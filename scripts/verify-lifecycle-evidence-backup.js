#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

function usage() {
  console.error(`Usage:
  node scripts/verify-lifecycle-evidence-backup.js \\
    --request-id <uuid> --environment <development|staging|production> \\
    --source-dir <downloaded-primary-bundle> \\
    --restored-dir <downloaded-isolated-restore-bundle>

The command is backup-vendor-neutral. Both directories must be independently
downloaded by an approved, access-logged workflow. It verifies the allowlisted
bundle, each SHA256SUMS manifest, and byte equality. It never deletes either
directory; cleanup remains an explicit operator step.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--request-id') options.requestId = argv[++index];
    else if (argument === '--environment') options.environment = argv[++index];
    else if (argument === '--source-dir') options.sourceDir = argv[++index];
    else if (argument === '--restored-dir') options.restoredDir = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function loadBundle(directory, requiredFiles) {
  const root = path.resolve(String(directory ?? ''));
  if (!directory) throw new Error('bundle directory is required');
  const files = new Map();
  for (const filename of requiredFiles) {
    const target = path.join(root, filename);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`required evidence object is not a regular file: ${filename}`);
    }
    files.set(filename, await fs.readFile(target));
  }
  return files;
}

async function pauseAutomation(reason) {
  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) return 'not_configured';
  const supabase = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const result = await supabase.rpc('pause_account_deletion_automation', {
    p_reason: String(reason).slice(0, 500),
  });
  if (result.error) throw new Error('failed to pause account deletion automation');
  return 'paused';
}

async function deliverBackupFailureAlert(payload) {
  const webhook = process.env.ACCOUNT_LIFECYCLE_ALERT_WEBHOOK_URL;
  const token = process.env.ACCOUNT_LIFECYCLE_ALERT_WEBHOOK_TOKEN;
  if (!webhook || !token) return 'not_configured';
  const response = await fetch(webhook, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`backup failure alert delivery returned HTTP ${response.status}`);
  return 'delivered';
}

async function reportFailure({ evidence, requestId, environment, category }) {
  let automation = 'pause_failed';
  try {
    automation = await pauseAutomation(`BACKUP_FAILED: ${category}`);
  } catch {
    // The nonzero command result remains the primary fail-closed signal.
  }

  const payload = {
    event: 'BACKUP_FAILED',
    environment,
    severity: 'critical',
    deletion_request_id: requestId,
    redacted_user_reference: evidence.sha256(requestId),
    timestamp: new Date().toISOString(),
    lifecycle_state: 'evidence_backup_verification',
    application_function_version: process.env.FUNCTION_VERSION ?? 'backup-verifier-v1',
    evidence_reference: null,
    sanitized_failure_category: category,
  };
  let alert = 'delivery_failed';
  try {
    alert = await deliverBackupFailureAlert(payload);
  } catch {
    // Do not put webhook details or provider response bodies in output.
  }
  console.error(JSON.stringify({ ...payload, automation, alert }, null, 2));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }
  const evidence = await import('../lib/account-deletion/evidenceStore.mjs');
  const requestId = evidence.assertUuid(options.requestId, 'request_id');
  const environment = evidence.normalizeEnvironment(options.environment);

  try {
    const [source, restored] = await Promise.all([
      loadBundle(options.sourceDir, evidence.REQUIRED_EVIDENCE_FILES),
      loadBundle(options.restoredDir, evidence.REQUIRED_EVIDENCE_FILES),
    ]);
    const result = evidence.verifyEvidenceBackupRestore(source, restored);
    if (!result.valid) throw new Error('checksum_or_byte_mismatch');
    console.log(JSON.stringify({
      status: 'backup_restore_verified',
      deletionRequestId: requestId,
      environment,
      requiredFileCount: evidence.REQUIRED_EVIDENCE_FILES.length,
      sourceManifestHash: result.sourceManifestHash,
      restoredManifestHash: result.restoredManifestHash,
    }, null, 2));
  } catch (error) {
    const category = error instanceof Error && error.message === 'checksum_or_byte_mismatch'
      ? error.message
      : 'missing_or_unreadable_backup_object';
    await reportFailure({ evidence, requestId, environment, category });
    throw new Error(`backup restore verification failed: ${category}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[evidence-backup] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, loadBundle };
