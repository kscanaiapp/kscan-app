const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function loadEvidence() {
  return import('../lib/account-deletion/evidenceStore.mjs');
}

test('evidence path is request-scoped, versioned, UTC-based, and contains no email', async () => {
  const evidence = await loadEvidence();
  const requestId = '2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7';
  const bundlePath = evidence.buildEvidenceBundlePath({
    environment: 'production',
    requestDate: '2026-08-02T23:59:59-04:00',
    deletionRequestId: requestId,
    version: 2,
  });
  assert.equal(bundlePath, `production/2026/08/${requestId}/v2`);
  assert.doesNotMatch(bundlePath, /@/);
});

test('normalized email search key is deterministic but does not retain raw email', async () => {
  const evidence = await loadEvidence();
  const first = evidence.hashNormalizedEmail('  Person.Example@KSCAN.APP ');
  const second = evidence.hashNormalizedEmail('person.example@kscan.app');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /person|kscan/i);
});

test('evidence sanitization strips secret-bearing keys and redacts email/token values', async () => {
  const evidence = await loadEvidence();
  const sanitized = evidence.sanitizeEvidenceValue({
    note: 'contact person@example.com',
    authorization: 'Bearer secret',
    nested: {
      access_token: 'secret',
      safe: 'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz12345.abcdefghijklmnopqrstuvwxyz12345',
    },
  });
  assert.equal(sanitized.note, 'contact [redacted-email]');
  assert.equal('authorization' in sanitized, false);
  assert.equal('access_token' in sanitized.nested, false);
  assert.equal(sanitized.nested.safe, '[redacted-token]');
  evidence.assertEvidenceIsSanitized(sanitized);
});

test('bundle generator emits the required sanitized files and verifies SHA256SUMS', async () => {
  const evidence = await loadEvidence();
  const requestId = '2e981c64-7dd9-4ac7-930a-f1b3eb1e87d7';
  const files = evidence.buildEvidenceFiles({
    summary: {
      deletion_request_id: requestId,
      correlation_id: requestId,
      environment: 'staging',
      evidence_version: 1,
      evidence_bundle_path: `staging/2026/08/${requestId}/v1`,
      lifecycle_state: 'purged',
    },
    timeline: [
      {
        occurred_at: '2026-08-02T18:00:00.000Z',
        event_type: 'PURGE_COMPLETED',
        source: 'test-worker',
        actor_type: 'worker',
        state_before: 'purging',
        state_after: 'purged',
        outcome: 'success',
        sanitized_metadata: { recipient: 'person@example.com' },
      },
    ],
    accessLog: [],
    generatedAt: '2026-08-02T18:01:00.000Z',
  });

  assert.deepEqual([...files.keys()].sort(), [...evidence.REQUIRED_EVIDENCE_FILES].sort());
  assert.equal(evidence.verifyEvidenceChecksums(files).valid, true);
  assert.doesNotMatch(files.get('timeline.jsonl').toString('utf8'), /person@example\.com/);

  files.set('timeline.jsonl', Buffer.from('tampered\n'));
  const invalid = evidence.verifyEvidenceChecksums(files);
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.failures.map((item) => item.filename), ['timeline.jsonl']);
});

test('migration creates a private service-role-only evidence surface', () => {
  const migration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260802181610_account_lifecycle_evidence_store.sql'),
    'utf8',
  );
  assert.match(migration, /'account-lifecycle-evidence'[\s\S]*false/i);
  assert.match(migration, /account_lifecycle_evidence_index/);
  assert.match(migration, /evidence_retention_policies/);
  assert.match(migration, /account_lifecycle_events/);
  assert.match(migration, /evidence_access_events/);
  assert.match(migration, /with \(security_invoker = true\)/i);
  assert.match(migration, /verify_account_lifecycle_hash_chain/);
  assert.match(migration, /pause_account_deletion_automation/);
  assert.match(migration, /revoke all on table public\.account_lifecycle_evidence_index from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /create policy[\s\S]{0,200}account-lifecycle-evidence/i);
});

test('review and export CLIs require authorization, checksum verification, and cleanup', () => {
  const review = fs.readFileSync(path.join(root, 'scripts', 'review-lifecycle-request.js'), 'utf8');
  const exporter = fs.readFileSync(path.join(root, 'scripts', 'export-lifecycle-evidence.js'), 'utf8');
  assert.match(review, /is_account_lifecycle_reviewer_authorized/);
  assert.match(review, /verifyEvidenceChecksums/);
  assert.match(review, /EVIDENCE_CHECKSUM_FAILED/);
  assert.match(review, /removeTemporaryDirectory/);
  assert.match(exporter, /upsert: false/);
  assert.match(exporter, /round-trip checksum verification/i);
  assert.match(exporter, /pause_account_deletion_automation/);
});

test('destructive worker fails closed until evidence pipeline readiness is approved', () => {
  const worker = fs.readFileSync(
    path.join(root, 'supabase', 'functions', 'process-account-deletions', 'index.ts'),
    'utf8',
  );
  const migration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20260802181610_account_lifecycle_evidence_store.sql'),
    'utf8',
  );
  assert.match(worker, /account_deletion_evidence_pipeline_ready/);
  assert.match(worker, /pause_account_deletion_automation/);
  assert.match(worker, /Evidence pipeline is not ready; automation paused/);
  assert.match(migration, /'account_deletion_evidence_pipeline_ready'[\s\S]*'enabled', false/i);
});
