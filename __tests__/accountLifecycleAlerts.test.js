const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const common = fs.readFileSync(
  path.join(root, 'supabase', 'functions', '_shared', 'deletion', 'common.ts'),
  'utf8',
);
const worker = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'process-account-deletions', 'index.ts'),
  'utf8',
);
const intake = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'handle-user-deletion', 'index.ts'),
  'utf8',
);
const restore = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'restore-account', 'index.ts'),
  'utf8',
);

const requiredEvents = [
  'DELETION_REQUEST_ACCEPTED',
  'USER_DELETION_EMAIL_FAILED',
  'ACCOUNT_RESTORED',
  'PURGE_BECAME_ELIGIBLE',
  'PURGE_CLAIMED',
  'PURGE_STARTED',
  'PURGE_COMPLETED',
  'PROVIDER_REVOCATION_BLOCKED',
  'EVIDENCE_GENERATION_FAILED',
  'EVIDENCE_CHECKSUM_FAILED',
  'EVIDENCE_OBJECT_MISSING',
  'RESIDUAL_PII_DETECTED',
  'CROSS_USER_ANOMALY_DETECTED',
  'WORKER_LEASE_STUCK',
  'BACKUP_FAILED',
  'AUTOMATION_PAUSED',
];

test('sanitized alert contract declares every required lifecycle event', () => {
  for (const event of requiredEvents) assert.ok(common.includes(`'${event}'`), `missing ${event}`);
});

test('alert payload contains the operational fields and no raw content fields', () => {
  for (const field of [
    'environment',
    'severity',
    'deletion_request_id',
    'redacted_user_reference',
    'timestamp',
    'lifecycle_state',
    'application_function_version',
    'evidence_reference',
  ]) {
    assert.ok(common.includes(field), `missing payload field ${field}`);
  }
  const payloadStart = common.indexOf('const payload = {');
  const payloadEnd = common.indexOf('};', payloadStart);
  const payload = common.slice(payloadStart, payloadEnd);
  assert.doesNotMatch(payload, /raw_email|access_token|refresh_token|image|conversation|user_content|secret/i);
});

test('intake, restoration, and worker stages are connected to the alert sink', () => {
  assert.match(intake, /event: 'DELETION_REQUEST_ACCEPTED'/);
  assert.match(intake, /event: 'USER_DELETION_EMAIL_FAILED'/);
  assert.match(restore, /event: 'ACCOUNT_RESTORED'/);
  for (const event of [
    'PURGE_BECAME_ELIGIBLE',
    'PURGE_CLAIMED',
    'PURGE_STARTED',
    'PURGE_COMPLETED',
    'WORKER_LEASE_STUCK',
    'AUTOMATION_PAUSED',
  ]) {
    assert.ok(worker.includes(`event: '${event}'`), `worker missing ${event}`);
  }
});

test('critical failure path pauses before attempting delivery', () => {
  const catchAt = worker.indexOf('} catch (error) {', worker.indexOf('async function processClaimedRequest'));
  const pauseAt = worker.indexOf("pause_account_deletion_automation", catchAt);
  const deliverAt = worker.indexOf('deliverLifecycleAlert({', pauseAt);
  assert.ok(catchAt > 0 && pauseAt > catchAt && deliverAt > pauseAt);
});

