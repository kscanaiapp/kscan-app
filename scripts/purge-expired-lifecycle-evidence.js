#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

function parseLimit(argv) {
  const index = argv.indexOf('--limit');
  if (index === -1) return 10;
  const value = Number(argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 25) {
    throw new Error('--limit must be an integer between 1 and 25');
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function createAdminClient() {
  return createClient(requiredEnvironment('SUPABASE_URL'), requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function pauseAutomation(supabase, reason) {
  const result = await supabase.rpc('pause_account_deletion_automation', { p_reason: reason.slice(0, 500) });
  if (result.error) console.error('[evidence-retention] CRITICAL: failed to set PAUSED mode');
}

async function main(argv = process.argv.slice(2)) {
  const limit = parseLimit(argv);
  const evidence = await import('../lib/account-deletion/evidenceStore.mjs');
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const candidates = await supabase
    .from('account_lifecycle_evidence_index')
    .select('id,deletion_request_id,evidence_version,evidence_bundle_path,lifecycle_state')
    .eq('legal_hold', false)
    .is('deleted_at', null)
    .lte('retention_expires_at', now)
    .order('retention_expires_at', { ascending: true })
    .limit(limit);
  if (candidates.error) throw new Error(`load expired evidence: ${candidates.error.message}`);

  const results = [];
  for (const row of candidates.data ?? []) {
    try {
      const objectPaths = evidence.REQUIRED_EVIDENCE_FILES.map(
        (filename) => `${row.evidence_bundle_path}/${filename}`,
      );
      const removed = await supabase.storage.from(evidence.EVIDENCE_BUCKET).remove(objectPaths);
      if (removed.error) throw new Error(`remove evidence objects: ${removed.error.message}`);

      const updated = await supabase
        .from('account_lifecycle_evidence_index')
        .update({
          generation_status: 'deleted',
          subject_user_id: null,
          normalized_email_hash: '0'.repeat(64),
          deleted_at: now,
        })
        .eq('id', row.id)
        .eq('legal_hold', false)
        .is('deleted_at', null)
        .select('id')
        .single();
      if (updated.error) throw new Error(`mark evidence expired: ${updated.error.message}`);

      const event = await supabase.rpc('append_account_lifecycle_event', {
        p_deletion_request_id: row.deletion_request_id,
        p_correlation_id: row.deletion_request_id,
        p_event_type: 'EVIDENCE_RETENTION_PURGED',
        p_source: 'purge-expired-lifecycle-evidence',
        p_actor_type: 'scheduler',
        p_outcome: 'deleted',
        p_idempotency_key: `evidence-retention-purged:${row.deletion_request_id}:v${row.evidence_version}`,
        p_state_before: row.lifecycle_state,
        p_state_after: row.lifecycle_state,
        p_sanitized_metadata: { evidence_version: row.evidence_version },
      });
      if (event.error) throw new Error(`append retention event: ${event.error.message}`);
      results.push({ deletionRequestId: row.deletion_request_id, evidenceVersion: row.evidence_version, status: 'deleted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'retention purge failed';
      await pauseAutomation(supabase, `EVIDENCE_RETENTION_FAILURE: ${message}`);
      results.push({ deletionRequestId: row.deletion_request_id, evidenceVersion: row.evidence_version, status: 'failed' });
      break;
    }
  }

  console.log(JSON.stringify({ checkedAt: now, candidateCount: candidates.data?.length ?? 0, results }, null, 2));
  if (results.some((item) => item.status === 'failed')) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[evidence-retention] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseLimit };
