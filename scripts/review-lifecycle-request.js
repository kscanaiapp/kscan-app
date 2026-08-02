#!/usr/bin/env node
'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');

function usage() {
  console.error(`Usage:
  node scripts/review-lifecycle-request.js \\
    --request-id <uuid> --reviewer-id <approved-id> --reason <reason> \\
    [--case-number <case>] [--version <n>] [--open] [--export-dir <new-dir>]

The command downloads only to an OS temporary directory, verifies SHA256SUMS,
records access, and removes the temporary directory in a finally block.
--export-dir requires the reviewer's export capability and must not exist.`);
}

function parseArgs(argv) {
  const options = { open: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request-id') options.requestId = argv[++i];
    else if (arg === '--reviewer-id') options.reviewerId = argv[++i];
    else if (arg === '--reason') options.reason = argv[++i];
    else if (arg === '--case-number') options.caseNumber = argv[++i];
    else if (arg === '--version') options.version = Number(argv[++i]);
    else if (arg === '--export-dir') options.exportDir = argv[++i];
    else if (arg === '--open') options.open = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function createAdminClient() {
  const url = required(process.env.SUPABASE_URL, 'SUPABASE_URL');
  const key = required(process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function failIfError(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function assertReviewer(supabase, reviewerId, capability) {
  const result = await supabase.rpc('is_account_lifecycle_reviewer_authorized', {
    p_reviewer_id: reviewerId,
    p_capability: capability,
  });
  const authorized = await failIfError(result, `authorize reviewer for ${capability}`);
  if (authorized !== true) throw new Error(`reviewer is not authorized for ${capability}`);
}

async function recordAccess(supabase, indexRow, options, eventType, files, outcome, exportChecksum = null) {
  return failIfError(
    await supabase.rpc('record_evidence_access_event', {
      p_evidence_index_id: indexRow.id,
      p_event_type: eventType,
      p_reviewer_identity: options.reviewerId,
      p_reason: options.reason,
      p_case_number: options.caseNumber ?? null,
      p_files_accessed: files,
      p_export_checksum: exportChecksum,
      p_outcome: outcome,
      p_idempotency_key: `evidence-access:${eventType}:${crypto.randomUUID()}`,
    }),
    `record ${eventType}`,
  );
}

async function pauseAutomation(supabase, reason) {
  const result = await supabase.rpc('pause_account_deletion_automation', { p_reason: reason.slice(0, 500) });
  if (result.error) console.error('[evidence-review] CRITICAL: failed to set PAUSED mode');
}

async function downloadBundle(supabase, evidence, indexRow, tempDirectory) {
  const files = new Map();
  for (const filename of evidence.REQUIRED_EVIDENCE_FILES) {
    const objectPath = `${indexRow.evidence_bundle_path}/${filename}`;
    const result = await supabase.storage.from(evidence.EVIDENCE_BUCKET).download(objectPath);
    if (result.error) throw new Error(`download ${filename}: ${result.error.message}`);
    const buffer = Buffer.from(await result.data.arrayBuffer());
    files.set(filename, buffer);
    await fs.writeFile(path.join(tempDirectory, filename), buffer, { flag: 'wx' });
  }
  return files;
}

function openReadme(readmePath) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '""', readmePath];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [readmePath];
  } else {
    command = 'xdg-open';
    args = [readmePath];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function createAuthorizedExport(sourceDirectory, requestedDirectory, evidence) {
  const exportDirectory = path.resolve(requestedDirectory);
  await fs.mkdir(exportDirectory, { recursive: false });
  for (const filename of evidence.REQUIRED_EVIDENCE_FILES) {
    await fs.copyFile(path.join(sourceDirectory, filename), path.join(exportDirectory, filename), fsConstants.COPYFILE_EXCL);
  }
  return exportDirectory;
}

async function removeTemporaryDirectory(tempDirectory) {
  if (!tempDirectory) return;
  const resolvedTempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolvedTarget = path.resolve(tempDirectory);
  if (!resolvedTarget.startsWith(resolvedTempRoot) || !path.basename(resolvedTarget).startsWith('kscan-lifecycle-review-')) {
    throw new Error('refusing to remove an unverified temporary directory');
  }
  await fs.rm(resolvedTarget, { recursive: true, force: true });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }

  const evidence = await import('../lib/account-deletion/evidenceStore.mjs');
  options.requestId = evidence.assertUuid(options.requestId, 'request_id');
  options.reviewerId = required(options.reviewerId, 'reviewer_id');
  options.reason = required(options.reason, 'reason');
  if (options.version != null && (!Number.isSafeInteger(options.version) || options.version < 1)) {
    throw new Error('version must be a positive integer');
  }

  const supabase = createAdminClient();
  let tempDirectory;
  let indexRow;
  let downloadedFiles = [];
  let checksumFailureRecorded = false;

  try {
    await assertReviewer(supabase, options.reviewerId, 'view');
    if (options.exportDir) await assertReviewer(supabase, options.reviewerId, 'export');

    let query = supabase
      .from('account_lifecycle_evidence_index')
      .select('id,deletion_request_id,evidence_version,evidence_bundle_path,generation_status,checksum_status,legal_hold,retention_expires_at')
      .eq('deletion_request_id', options.requestId)
      .eq('generation_status', 'complete')
      .order('evidence_version', { ascending: false })
      .limit(1);
    if (options.version != null) query = query.eq('evidence_version', options.version);
    indexRow = await failIfError(await query.maybeSingle(), 'locate evidence bundle');
    if (!indexRow) throw new Error('no completed evidence bundle found for deletion request');

    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'kscan-lifecycle-review-'));
    const files = await downloadBundle(supabase, evidence, indexRow, tempDirectory);
    downloadedFiles = [...files.keys()];
    const verification = evidence.verifyEvidenceChecksums(files);
    if (!verification.valid) {
      await recordAccess(
        supabase,
        indexRow,
        options,
        'EVIDENCE_CHECKSUM_FAILED',
        verification.failures.map((item) => item.filename),
        'failed',
      );
      await supabase
        .from('account_lifecycle_evidence_index')
        .update({ checksum_status: 'failed' })
        .eq('id', indexRow.id);
      await pauseAutomation(supabase, `EVIDENCE_CHECKSUM_FAILED: ${options.requestId}:v${indexRow.evidence_version}`);
      checksumFailureRecorded = true;
      throw new Error(`checksum verification failed for ${verification.failures.map((item) => item.filename).join(', ')}`);
    }

    await recordAccess(
      supabase,
      indexRow,
      options,
      'EVIDENCE_BUNDLE_DOWNLOADED',
      downloadedFiles,
      'verified',
    );

    const readmePath = path.join(tempDirectory, 'README.html');
    await fs.access(readmePath);
    await recordAccess(
      supabase,
      indexRow,
      options,
      'EVIDENCE_BUNDLE_VIEWED',
      ['README.html'],
      'verified',
    );
    if (options.open) openReadme(readmePath);

    let exportDirectory = null;
    let exportChecksum = null;
    if (options.exportDir) {
      exportDirectory = await createAuthorizedExport(tempDirectory, options.exportDir, evidence);
      exportChecksum = evidence.sha256(files.get('SHA256SUMS'));
      await recordAccess(
        supabase,
        indexRow,
        options,
        'EVIDENCE_EXPORT_CREATED',
        downloadedFiles,
        'verified',
        exportChecksum,
      );
    }

    console.log(JSON.stringify({
      status: 'verified',
      deletionRequestId: options.requestId,
      evidenceVersion: indexRow.evidence_version,
      checksumStatus: 'verified',
      readableTimeline: 'README.html',
      exportDirectory,
      exportChecksum,
      temporaryFilesRemovedOnExit: true,
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'evidence review failed';
    const integrityFailure = /checksum|SHA256SUMS|download .*:|required evidence file missing/i.test(message);
    if (indexRow && integrityFailure && !checksumFailureRecorded) {
      try {
        await recordAccess(
          supabase,
          indexRow,
          options,
          'EVIDENCE_CHECKSUM_FAILED',
          downloadedFiles,
          'failed',
        );
      } catch {
        console.error('[evidence-review] CRITICAL: failed to record checksum failure access event');
      }
      await pauseAutomation(supabase, `EVIDENCE_CHECKSUM_FAILED: ${options.requestId}:v${indexRow.evidence_version}`);
    }
    throw error;
  } finally {
    await removeTemporaryDirectory(tempDirectory);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[evidence-review] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, removeTemporaryDirectory };
