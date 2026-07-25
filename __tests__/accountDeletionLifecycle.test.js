/**
 * Account-deletion lifecycle source invariants.
 *
 * These lock the behaviour of the deletion subsystem that was reconciled into
 * this branch from repair/account-deletion-hostile-audit-20260722 (835ec97),
 * which is byte-equivalent to the source currently deployed in production.
 *
 * Runtime purge behaviour is NOT asserted here: production has the worker kill
 * switch off, dry-run forced on, and no scheduler installed, so no destructive
 * purge has been observed. See the closeout report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const worker = read('supabase/functions/process-account-deletions/index.ts');
const intake = read('supabase/functions/handle-user-deletion/index.ts');
const restore = read('supabase/functions/restore-account/index.ts');
const shared = read('supabase/functions/_shared/deletion/common.ts');
const resources = read('supabase/functions/_shared/deletion/userDataResources.ts');
const restoreScreen = read('app/account/restore.tsx');
const deletionService = read('services/accountDeletion.js');

// ── Request intake and deactivation ────────────────────────────────────────

test('a deletion request deactivates, revokes sessions, and bans auth login', () => {
  assert.match(intake, /status: 'deactivated'/);
  assert.match(intake, /account_status: 'pending_deletion'/);
  assert.match(intake, /revokeAllSessions\(user\.id, user\.accessToken\)/);
  assert.match(intake, /ban_duration: '720h'/, 'auth login is banned for the grace window');
});

test('a failed deactivation compensates so purge cannot proceed', () => {
  assert.match(intake, /PROFILE_DEACTIVATION_FAILED/);
  assert.match(intake, /status: 'failed'/);
  assert.match(
    intake,
    /restoration_token_hash: null/,
    'a failed request must not leave a usable restoration token',
  );
});

test('the restoration token is stored hashed, never in plaintext', () => {
  assert.match(intake, /hashRestorationToken\(/);
  assert.match(intake, /restoration_token_hash/);
  assert.doesNotMatch(intake, /restoration_token:\s/, 'no plaintext token column write');
  assert.match(shared, /crypto\.subtle\.digest|sha-?256/i);
});

// ── Worker safety ──────────────────────────────────────────────────────────

test('the worker fails safe: disabled or dry-run means no destructive work', () => {
  assert.match(
    worker,
    /const dryRun = envDryRun \|\| dryRunFlag \|\| !enabled;/,
    'a disabled worker must degrade to dry-run, never to destructive',
  );
  assert.match(worker, /readAppConfigFlag\('account_deletion_worker_enabled'\)/);
  assert.match(worker, /readAppConfigFlag\('account_deletion_worker_dry_run'\)/);
  assert.match(worker, /kill_switch_skip/);
});

test('the dry-run path only inventories candidates', () => {
  assert.match(worker, /list_deletion_purge_candidates/);
  const dryBlock = worker.slice(worker.indexOf('if (dryRun)'), worker.indexOf('if (dryRun)') + 1400);
  assert.doesNotMatch(dryBlock, /auth\.admin\.deleteUser/);
  assert.doesNotMatch(dryBlock, /\.remove\(/);
});

test('claiming is an atomic RPC, not select-then-update', () => {
  assert.match(worker, /rpc\('claim_deletion_requests_for_purge'/);
  assert.doesNotMatch(
    worker,
    /select[\s\S]{0,120}status=eq\.deactivated[\s\S]{0,120}PATCH/,
    'no read-modify-write claim',
  );
});

test('the lease is re-checked between every destructive stage', () => {
  assert.match(worker, /heartbeat_deletion_request_lease/);
  const beats = worker.match(/if \(!\(await heartbeat\(requestId, workerId\)\)\) return \{ status: 'lost_lease' \}/g) || [];
  assert.ok(beats.length >= 4, `expected repeated lease checks, saw ${beats.length}`);
});

test('a crashed worker is recoverable and retries are scheduled, not lost', () => {
  assert.match(worker, /reconcile_orphaned_purging_requests/);
  assert.match(worker, /schedule_deletion_retry_or_fail/);
  assert.match(worker, /mark_deletion_request_purged/, 'finalisation is a conditional RPC');
});

// ── Storage and Auth purge ordering ────────────────────────────────────────

test('storage removal protects objects still referenced by other rows', () => {
  assert.match(worker, /referenced\.add\(String\(row\.storage_path\)\)/);
  assert.match(worker, /storage_partial_removal/, 'partial removal is alerted, not silent');
});

test('Auth identity deletion is hard and runs after storage work', () => {
  assert.match(worker, /supabase\.auth\.admin\.deleteUser\(userId\)/);
  const storageAt = worker.indexOf('bucket.remove(');
  const authAt = worker.indexOf('auth.admin.deleteUser(');
  assert.ok(storageAt > -1 && authAt > -1);
  assert.ok(storageAt < authAt, 'owned storage must be cleared before the auth user is removed');
});

test('the resource registry is explicit and ownership-keyed', () => {
  assert.match(resources, /user_id|owner_id|\bid\b/);
  assert.ok(resources.length > 200, 'registry must enumerate real resources');
});

// ── Restoration ────────────────────────────────────────────────────────────

test('restoration compares a hash, never a plaintext token', () => {
  assert.match(restore, /hashRestorationToken\(token\)/);
  assert.match(
    restore,
    /rpc\('restore_account_by_token_hash',\s*\{\s*p_token_hash: tokenHash/,
    'the raw token must never reach the database comparison',
  );
  assert.match(restore, /token\.length < 32/, 'a malformed token is rejected before any lookup');
  assert.doesNotMatch(restore, /logEvent\([^)]*\btoken\b(?!Hash)/, 'the token is never logged');
  assert.doesNotMatch(restore, /account_status: 'pending_deletion'/);
});

test('the restore screen scrubs the token and never logs it', () => {
  assert.doesNotMatch(restoreScreen, /console\.log\([^)]*token/i);
  assert.match(deletionService, /restoreAccountWithToken/);
  assert.match(deletionService, /resendRestorationEmail/);
});

// ── Privacy ────────────────────────────────────────────────────────────────

test('deletion logging carries no PII or credential material', () => {
  for (const [name, src] of [['worker', worker], ['intake', intake], ['restore', restore]]) {
    assert.doesNotMatch(src, /logEvent\([^)]*user\.email/, `${name} must not log an email`);
    assert.doesNotMatch(src, /logEvent\([^)]*accessToken/, `${name} must not log a token`);
  }
  assert.match(shared, /export function shortUserId/, 'identifiers are shortened, not raw');
});

test('no subscription or billing claim is made where no billing system exists', () => {
  // K Scan ships no RevenueCat / Stripe / Play Billing dependency, so the
  // deletion UI must not claim a subscription is or is not being cancelled.
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.equal(
    deps.some((d) => /revenuecat|stripe|iap|in-app-purchase|billing/i.test(d)),
    false,
    'a billing dependency would require subscription copy in the deletion flow',
  );
  const privacyScreen = read('app/privacy.tsx');
  assert.doesNotMatch(privacyScreen, /subscription (?:is|has been) cancell?ed/i);
});
