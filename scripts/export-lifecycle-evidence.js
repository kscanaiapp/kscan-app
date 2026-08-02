#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

function usage() {
  console.error(`Usage:
  node scripts/export-lifecycle-evidence.js \\
    --request-id <uuid> --environment <development|staging|production> \\
    [--version <n>] [--change-note <sanitized explanation>]

Required environment variables:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

The command builds the bundle in memory, uploads with upsert disabled, then
downloads every object and verifies SHA256SUMS before finalizing the index.`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request-id') options.requestId = argv[++i];
    else if (arg === '--environment') options.environment = argv[++i];
    else if (arg === '--version') options.version = Number(argv[++i]);
    else if (arg === '--change-note') options.changeNote = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createAdminClient() {
  return createClient(requireEnvironment('SUPABASE_URL'), requireEnvironment('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function failIfError(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function pauseAutomation(supabase, reason) {
  const safeReason = String(reason ?? 'evidence generation failed').slice(0, 500);
  const result = await supabase.rpc('pause_account_deletion_automation', { p_reason: safeReason });
  if (result.error) {
    console.error('[evidence-export] CRITICAL: failed to set PAUSED mode');
  }
}

async function resolveRetentionPolicy(supabase, environment) {
  const now = new Date().toISOString();
  const result = await supabase
    .from('evidence_retention_policies')
    .select('id,retention_days,policy_version,effective_at')
    .eq('environment', environment)
    .eq('evidence_type', 'account_lifecycle')
    .lte('effective_at', now)
    .is('retired_at', null)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const policy = await failIfError(result, 'load evidence retention policy');
  if (!policy) {
    throw new Error(`no approved active account_lifecycle retention policy for ${environment}`);
  }
  return policy;
}

async function resolveVersion(supabase, requestId, requestedVersion) {
  const result = await supabase
    .from('account_lifecycle_evidence_index')
    .select('evidence_version,normalized_email_hash')
    .eq('deletion_request_id', requestId)
    .order('evidence_version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const latest = await failIfError(result, 'load latest evidence version');
  const expectedNext = (latest?.evidence_version ?? 0) + 1;
  const version = requestedVersion ?? expectedNext;
  if (!Number.isSafeInteger(version) || version !== expectedNext) {
    throw new Error(`evidence version must be the next immutable version: v${expectedNext}`);
  }
  return { version, priorEmailHash: latest?.normalized_email_hash ?? null };
}

async function resolveEmailHash(supabase, request, priorEmailHash, hashNormalizedEmail) {
  if (priorEmailHash) return priorEmailHash;
  if (!request.user_id) {
    throw new Error('subject Auth user is gone and no prepared email hash exists; manual evidence recovery required');
  }
  const result = await supabase.auth.admin.getUserById(request.user_id);
  if (result.error) throw new Error(`load Auth identity: ${result.error.message}`);
  return hashNormalizedEmail(result.data.user?.email);
}

async function assertPathUnused(supabase, bucket, path) {
  const listed = await supabase.storage.from(bucket).list(path, { limit: 100, offset: 0 });
  if (listed.error) throw new Error(`check immutable evidence path: ${listed.error.message}`);
  if ((listed.data ?? []).length > 0) {
    throw new Error(`evidence path already contains objects and cannot be overwritten: ${path}`);
  }
}

async function uploadAndVerify(supabase, bucket, path, files, contentTypeFor, verifyEvidenceChecksums) {
  for (const [filename, value] of files) {
    const uploaded = await supabase.storage.from(bucket).upload(`${path}/${filename}`, value, {
      contentType: contentTypeFor(filename),
      cacheControl: '0',
      upsert: false,
    });
    if (uploaded.error) throw new Error(`upload ${filename}: ${uploaded.error.message}`);
  }

  const downloaded = new Map();
  for (const filename of files.keys()) {
    const result = await supabase.storage.from(bucket).download(`${path}/${filename}`);
    if (result.error) throw new Error(`round-trip download ${filename}: ${result.error.message}`);
    downloaded.set(filename, Buffer.from(await result.data.arrayBuffer()));
  }
  const verification = verifyEvidenceChecksums(downloaded);
  if (!verification.valid) {
    throw new Error(`round-trip checksum verification failed for ${verification.failures.map((item) => item.filename).join(', ')}`);
  }
  return downloaded;
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
  const supabase = createAdminClient();
  let indexRow = null;

  try {
    const request = await failIfError(
      await supabase
        .from('deletion_requests')
        .select('id,user_id,subject_ref,status,requested_at,deactivated_at,grace_period_ends_at,restored_at,purge_started_at,purged_at,legal_hold_until')
        .eq('id', requestId)
        .single(),
      'load deletion request',
    );
    const policy = await resolveRetentionPolicy(supabase, environment);
    const { version, priorEmailHash } = await resolveVersion(supabase, requestId, options.version);
    if (version > 1 && !String(options.changeNote ?? '').trim()) {
      throw new Error('--change-note is required for corrected evidence versions');
    }
    const normalizedEmailHash = await resolveEmailHash(
      supabase,
      request,
      priorEmailHash,
      evidence.hashNormalizedEmail,
    );
    const bundlePath = evidence.buildEvidenceBundlePath({
      environment,
      requestDate: request.requested_at,
      deletionRequestId: requestId,
      version,
    });
    const retentionExpiresAt = new Date(Date.now() + Number(policy.retention_days) * 86400000).toISOString();

    await assertPathUnused(supabase, evidence.EVIDENCE_BUCKET, bundlePath);

    indexRow = await failIfError(
      await supabase
        .from('account_lifecycle_evidence_index')
        .insert({
          deletion_request_id: requestId,
          subject_ref: request.subject_ref,
          subject_user_id: request.user_id,
          normalized_email_hash: normalizedEmailHash,
          environment,
          request_date: request.requested_at,
          lifecycle_state: request.status,
          evidence_bundle_path: bundlePath,
          evidence_version: version,
          generation_status: 'generating',
          checksum_status: 'pending',
          retention_policy_id: policy.id,
          retention_expires_at: retentionExpiresAt,
        })
        .select('*')
        .single(),
      'reserve immutable evidence index',
    );

    const timeline = await failIfError(
      await supabase
        .from('v_account_lifecycle_timeline')
        .select('*')
        .eq('deletion_request_id', requestId)
        .order('occurred_at', { ascending: true }),
      'load lifecycle timeline',
    );
    const accessLog = await failIfError(
      await supabase
        .from('evidence_access_events')
        .select('event_type,reviewer_identity,occurred_at,reason,case_number,files_accessed,export_checksum,outcome')
        .eq('deletion_request_id', requestId)
        .order('occurred_at', { ascending: true }),
      'load evidence access log',
    );
    const hashChain = await failIfError(
      await supabase.rpc('verify_account_lifecycle_hash_chain', { p_deletion_request_id: requestId }),
      'verify lifecycle hash chain',
    );
    if (!hashChain?.[0]?.valid) throw new Error('lifecycle ledger hash-chain verification failed');

    const summary = {
      deletion_request_id: requestId,
      correlation_id: requestId,
      environment,
      evidence_version: version,
      evidence_bundle_path: bundlePath,
      lifecycle_state: request.status,
      requested_at: request.requested_at,
      deactivated_at: request.deactivated_at,
      grace_period_ends_at: request.grace_period_ends_at,
      restored_at: request.restored_at,
      purge_started_at: request.purge_started_at,
      purged_at: request.purged_at,
      legal_hold_active: Boolean(request.legal_hold_until && new Date(request.legal_hold_until) > new Date()),
      retention_policy_version: policy.policy_version,
      retention_expires_at: retentionExpiresAt,
      ledger_hash_chain_valid: true,
      correction_note: options.changeNote ?? null,
    };
    const files = evidence.buildEvidenceFiles({ summary, timeline, accessLog });
    const downloaded = await uploadAndVerify(
      supabase,
      evidence.EVIDENCE_BUCKET,
      bundlePath,
      files,
      evidence.contentTypeFor,
      evidence.verifyEvidenceChecksums,
    );
    const checksumManifestHash = evidence.sha256(downloaded.get('SHA256SUMS'));

    await failIfError(
      await supabase
        .from('account_lifecycle_evidence_index')
        .update({
          lifecycle_state: request.status,
          generation_status: 'complete',
          checksum_status: 'verified',
          checksum_verified_at: new Date().toISOString(),
          finalized_at: new Date().toISOString(),
        })
        .eq('id', indexRow.id)
        .eq('generation_status', 'generating'),
      'finalize evidence index',
    );

    await failIfError(
      await supabase.rpc('append_account_lifecycle_event', {
        p_deletion_request_id: requestId,
        p_correlation_id: requestId,
        p_event_type: 'EVIDENCE_BUNDLE_GENERATED',
        p_source: 'export-lifecycle-evidence',
        p_actor_type: 'system',
        p_outcome: 'verified',
        p_idempotency_key: `evidence-generated:${requestId}:v${version}`,
        p_subject_user_id: request.user_id,
        p_evidence_reference: bundlePath,
        p_sanitized_metadata: {
          evidence_version: version,
          checksum_manifest_hash: checksumManifestHash,
          retention_policy_version: policy.policy_version,
          change_note: options.changeNote ?? null,
        },
      }),
      'append evidence generation event',
    );

    console.log(JSON.stringify({
      status: 'evidence_verified',
      deletionRequestId: requestId,
      evidenceVersion: version,
      bucket: evidence.EVIDENCE_BUCKET,
      path: bundlePath,
      checksumManifestHash,
      retentionExpiresAt,
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'evidence generation failed';
    if (indexRow) {
      await supabase
        .from('account_lifecycle_evidence_index')
        .update({ generation_status: 'failed', checksum_status: 'failed' })
        .eq('id', indexRow.id);
    }
    await pauseAutomation(supabase, `EVIDENCE_GENERATION_FAILED: ${message}`);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[evidence-export] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
