const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Regression guards for the Blockers repaired in
// docs/audits/deletion-hostile-audit-findings-2026-07-22.md.
//
// These are source-text checks, NOT behavioral proof -- the SQL runs in
// Postgres and the edge functions run in Deno, neither of which this Node
// test runner can execute. Their only job is to fail loudly if someone
// reverts or silently drops a fix, the same limitation flagged against the
// existing *EdgeContract-style tests in P1-6 of the audit report. Treat a
// green run here as "the fix is still present in source," not as "the fix
// is correct" -- correctness for the SQL fixes was checked by hand against
// live production schema (docs/audits/deletion-hostile-audit-findings-2026-07-22.md,
// B3/B5) and should be re-verified against a real Postgres instance
// (local `supabase db start`, or a disposable branch) before deploy.

const root = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const crashRecoveryMigration = 'supabase/migrations/20260723040000_account_deletion_crash_recovery.sql';
const rlsMigration = 'supabase/migrations/20260723050000_account_deletion_rls_active_account.sql';
const processFn = 'supabase/functions/process-account-deletions/index.ts';
const restoreFn = 'supabase/functions/restore-account/index.ts';

test('B1: claim_deletion_requests_for_purge reclaims stale purging leases', () => {
  const sql = read(crashRecoveryMigration);
  assert.match(sql, /create or replace function public\.claim_deletion_requests_for_purge/);
  assert.match(sql, /dr\.status = 'purging'/);
  assert.match(sql, /dr\.worker_lease_expires_at <= now\(\)/);
});

test('B1: reconcile_orphaned_purging_requests exists and is service_role-only', () => {
  const sql = read(crashRecoveryMigration);
  assert.match(sql, /create or replace function public\.reconcile_orphaned_purging_requests/);
  assert.match(sql, /dr\.user_id is null/);
  assert.match(sql, /perform public\.mark_deletion_request_purged\(rec\.id, null\)/);
  assert.match(
    sql,
    /revoke all on function public\.reconcile_orphaned_purging_requests\(integer\) from public;\s*\ngrant execute on function public\.reconcile_orphaned_purging_requests\(integer\) to service_role;/,
  );
});

test('B1: worker calls the orphan-reconciliation RPC before claiming new work', () => {
  const src = read(processFn);
  const reconcileIdx = src.indexOf("rpc('reconcile_orphaned_purging_requests'");
  const claimIdx = src.indexOf("rpc('claim_deletion_requests_for_purge'");
  assert.ok(reconcileIdx > -1, 'reconcile call missing');
  assert.ok(claimIdx > -1, 'claim call missing');
  assert.ok(reconcileIdx < claimIdx, 'reconcile must run before claiming new work');
});

test('P1-1: schedule_deletion_retry_or_fail requires status = purging again', () => {
  const sql = read(crashRecoveryMigration);
  const fnStart = sql.indexOf('create or replace function public.schedule_deletion_retry_or_fail');
  assert.ok(fnStart > -1);
  const fnBody = sql.slice(fnStart, fnStart + 700);
  assert.match(fnBody, /where id = p_request_id\s*\n\s*and status = 'purging'/);
});

test('P1-5: deletion_requests has an explicit SELECT revoke', () => {
  const sql = read(crashRecoveryMigration);
  assert.match(sql, /revoke select on public\.deletion_requests from anon, authenticated;/);
});

test('B2: claim_deletion_requests_for_purge checks the dry-run flag before returning candidates', () => {
  const sql = read(crashRecoveryMigration);
  const fnStart = sql.indexOf('create or replace function public.claim_deletion_requests_for_purge');
  const candidatesStart = sql.indexOf('with candidates as', fnStart);
  assert.ok(fnStart > -1 && candidatesStart > -1);
  const guardSection = sql.slice(fnStart, candidatesStart);
  assert.match(guardSection, /account_deletion_worker_dry_run/);
  assert.match(guardSection, /if coalesce\(v_dry_run, false\) is true then\s*\n\s*return;/);
});

test('B3: post-purge verification runs after auth.admin.deleteUser, not before', () => {
  const src = read(processFn);
  const deleteUserIdx = src.indexOf('supabase.auth.admin.deleteUser(userId)');
  const verifyIdx = src.indexOf('post-purge verification found residual rows');
  const markPurgedIdx = src.indexOf("rpc('mark_deletion_request_purged'");
  assert.ok(deleteUserIdx > -1 && verifyIdx > -1 && markPurgedIdx > -1);
  assert.ok(deleteUserIdx < verifyIdx, 'verification must run after the auth user is deleted');
  assert.ok(verifyIdx < markPurgedIdx, 'verification must run before marking the request purged');
});

test('B3: verification excludes only the survive_auth_delete ledger action', () => {
  const src = read(processFn);
  assert.match(src, /resource\.action !== 'survive_auth_delete'/);
  assert.match(src, /throw new Error\(\s*\n?\s*`post-purge verification found residual rows/);
});

test('B3: outfit_decision_groups was added to both the JSON registry and its Deno mirror', () => {
  const registry = JSON.parse(read('lib/account-deletion/user-data-resources.json'));
  const mirror = read('supabase/functions/_shared/deletion/userDataResources.ts');
  const jsonEntry = registry.tables.find((t) => t.table === 'outfit_decision_groups');
  assert.ok(jsonEntry, 'missing from JSON registry');
  assert.equal(jsonEntry.action, 'auth_delete_set_null');
  assert.match(mirror, /table: 'outfit_decision_groups', column: 'created_by', action: 'auth_delete_set_null'/);
});

test('B4: AuthSessionContext registers a device session on sign-in and token refresh', () => {
  const src = read('contexts/AuthSessionContext.tsx');
  assert.match(src, /register_user_device_session/);
  assert.match(src, /getOrCreateDeviceKey/);
  // Must run on the boot session resolution AND on onAuthStateChange, not just one.
  const occurrences = src.match(/void registerDeviceSession\(\);/g) || [];
  assert.equal(occurrences.length, 2, 'expected registerDeviceSession() on both boot and auth-state-change paths');
});

test('B5: restrictive is_active_account() policy targets the shared-data tables found reachable post-deletion', () => {
  const sql = read(rlsMigration);
  const expectedTables = [
    'dressing_rooms',
    'dressing_room_items',
    'looks',
    'look_items',
    'room_shares',
    'dressing_room_item_reactions',
    'dressing_room_messages',
    'inspiration_items',
    'dressing_room_inspiration_items',
  ];
  for (const t of expectedTables) {
    assert.ok(sql.includes(`'${t}'`), `missing table in RLS guard list: ${t}`);
  }
  assert.match(sql, /as restrictive/);
  assert.match(sql, /using \(public\.is_active_account\(\)\)/);
  assert.match(sql, /with check \(public\.is_active_account\(\)\)/);
});

test('B6: server.js has no live /api/analyze pipeline and render.yaml declares no LLM keys', () => {
  const server = read('server.js');
  const renderYaml = read('render.yaml');
  assert.match(server, /LEGACY_ANALYZE_DISABLED/);
  assert.match(server, /app\.all\('\/api\/analyze'/);
  assert.match(server, /internal\/email\/account-deletion-restoration/);
  assert.match(server, /x-kscan-email-secret/);
  assert.doesNotMatch(renderYaml, /GEMINI_API_KEY/);
  assert.doesNotMatch(renderYaml, /OPENROUTER_API_KEY/);
  assert.match(renderYaml, /KSCAN_EMAIL_INTERNAL_SECRET/);
});

test('B7: restore-account separates the unban call from the swallowed catch block', () => {
  const src = read(restoreFn);
  assert.match(src, /restoration_unban_failed_needs_manual_intervention/);
  assert.match(src, /restored_pending_unban/);
  assert.match(src, /json\(\s*\n?\s*\{/); // still returns json(...) helper for the 202 path
  assert.match(src, /},\s*\n?\s*202,\s*\n?\s*\);/);
});
