const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const provider = fs.readFileSync(
  path.join(root, 'supabase', 'functions', '_shared', 'deletion', 'providerRevocation.ts'),
  'utf8',
);
const worker = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'process-account-deletions', 'index.ts'),
  'utf8',
);

test('provider revocation uses the configured secret boundary and never email as provider identity', () => {
  assert.match(provider, /ACCOUNT_PROVIDER_REVOCATION_BROKER_URL/);
  assert.match(provider, /ACCOUNT_PROVIDER_REVOCATION_BROKER_TOKEN/);
  assert.match(provider, /provider_id/);
  assert.match(provider, /identity_data\?\.sub/);
  assert.doesNotMatch(provider, /identity_data\?\.email/);
  assert.match(provider, /provider_subject_hash/);
});

test('email is NOT_APPLICABLE while Apple and Google fail closed without material', () => {
  assert.match(provider, /provider === 'email'/);
  assert.match(provider, /status: 'NOT_APPLICABLE'/);
  assert.match(provider, /REVOCATION_SECRET_BOUNDARY_UNCONFIGURED/);
  assert.match(provider, /PROVIDER_SUBJECT_UNAVAILABLE/);
  assert.match(provider, /REVOCATION_RESULT_AMBIGUOUS/);
});

test('only unambiguous terminal provider results are accepted', () => {
  assert.match(provider, /status === 'REVOKED' \|\| status === 'ALREADY_REVOKED'/);
  assert.match(provider, /GOOGLE_GRANT_TYPE_AMBIGUOUS/);
  assert.match(provider, /grantType === 'identity_sharing'/);
  assert.match(provider, /grantType === 'oauth_api'/);
  assert.match(provider, /results\.every\(\(result\) => result\.status !== 'BLOCKED'\)/);
});

test('provider revocation precedes all destructive deletion stages', () => {
  const providerAt = worker.indexOf('revokeLinkedProviders({');
  const directDeleteAt = worker.indexOf('deleteDirectUserRows(supabase, userId)');
  const authDeleteAt = worker.indexOf('supabase.auth.admin.deleteUser(userId)');
  assert.ok(providerAt > 0 && providerAt < directDeleteAt);
  assert.ok(directDeleteAt < authDeleteAt);
  assert.match(worker, /criticalEvent = 'PROVIDER_REVOCATION_BLOCKED'/);
  assert.match(worker, /eventType: 'PROVIDER_REVOCATION_COMPLETED'/);
});

test('ambiguous revocation pauses through the existing critical failure path', () => {
  const blockedAt = worker.indexOf("throw new Error('provider revocation blocked before destructive purge')");
  const catchAt = worker.indexOf('} catch (error) {', blockedAt);
  const pauseAt = worker.indexOf("pause_account_deletion_automation", catchAt);
  assert.ok(blockedAt > 0 && catchAt > blockedAt && pauseAt > catchAt);
});

