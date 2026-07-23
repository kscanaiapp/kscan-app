const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260722191013_account_deletion_lifecycle.sql'),
  'utf8',
);
const restoreSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'restore-account', 'index.ts'),
  'utf8',
);
const resendSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'resend-restoration-email', 'index.ts'),
  'utf8',
);
const workerSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'process-account-deletions', 'index.ts'),
  'utf8',
);
const commonSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'deletion', 'common.ts'),
  'utf8',
);
const previewScript = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'preview-deletion-backfill.js'),
  'utf8',
);

test('migration makes deletion_requests.user_id nullable with ON DELETE SET NULL', () => {
  assert.match(migration, /alter column user_id drop not null/i);
  assert.match(migration, /on delete set null/i);
  assert.match(migration, /subject_ref uuid not null/i);
});

test('migration creates append-only deletion_state_transitions ledger', () => {
  assert.match(migration, /create table if not exists public\.deletion_state_transitions/i);
  assert.match(migration, /revoke all on table public\.deletion_state_transitions from anon, authenticated/i);
});

test('migration defaults kill switch OFF and dry-run ON', () => {
  assert.match(migration, /account_deletion_worker_enabled/);
  assert.match(migration, /"enabled": false/);
  assert.match(migration, /account_deletion_worker_dry_run/);
});

test('migration provides atomic claim and restore RPCs', () => {
  assert.match(migration, /claim_deletion_requests_for_purge/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /restore_account_by_token_hash/);
  assert.match(migration, /heartbeat_deletion_request_lease/);
  assert.match(migration, /rotate_restoration_token_by_email/);
});

test('restoration endpoint consumes opaque token only', () => {
  assert.match(restoreSource, /hashRestorationToken/);
  assert.match(restoreSource, /restore_account_by_token_hash/);
  assert.doesNotMatch(restoreSource, /user_id.*body/i);
});

test('resend pathway is enumeration-safe and rate-limited in SQL', () => {
  assert.match(resendSource, /If an eligible deletion request exists/);
  assert.match(resendSource, /rotate_restoration_token_by_email/);
  assert.match(migration, /restoration_email_count.*>= 3/s);
});

test('worker requires dedicated secret and rejects anon authority', () => {
  assert.match(workerSource, /ACCOUNT_DELETION_WORKER_SECRET/);
  assert.match(workerSource, /SUPABASE_ANON_KEY/);
  assert.match(workerSource, /kill_switch_skip|account_deletion_worker_enabled/);
  assert.match(workerSource, /DELETION_WORKER_DRY_RUN|account_deletion_worker_dry_run/);
  assert.match(workerSource, /mark_deletion_request_purged/);
  assert.match(workerSource, /AUTH_DELETE_STARTED/);
});

test('common helpers hash restoration tokens and never log them', () => {
  assert.match(commonSource, /generateRestorationToken/);
  assert.match(commonSource, /hashRestorationToken/);
  assert.match(commonSource, /SHA-256/);
  assert.doesNotMatch(commonSource, /console\.log\([^\)]*token/i);
});

test('assertAccountActive fails closed for non-active accounts', () => {
  assert.match(commonSource, /assertAccountActive/);
  assert.match(commonSource, /ACCOUNT_DEACTIVATED/);
  assert.match(commonSource, /status !== 'active'/);
});

test('backfill preview uses greatest(requested_at+30d, now()+7d) and is read-only', () => {
  assert.match(previewScript, /greatest|30 days|7 days/i);
  assert.doesNotMatch(previewScript, /\.update\(/);
  assert.doesNotMatch(previewScript, /\.insert\(/);
  assert.doesNotMatch(previewScript, /\.delete\(/);
});

test('shared links are not revoked at request time (binding product decision)', () => {
  const handleSource = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'handle-user-deletion', 'index.ts'),
    'utf8',
  );
  assert.doesNotMatch(handleSource, /revoke_room_share/);
});
