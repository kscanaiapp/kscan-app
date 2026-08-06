// Migration clean-replay regression coverage (Build 25 Phase 1 addendum —
// INFRA-02).
//
// Postgres rejects `CREATE OR REPLACE FUNCTION` when the replacement changes
// an existing function's return type, or renames an existing input
// parameter (SQLSTATE 42P13 in both cases). Two functions in
// 20260723021145_account_deletion_security_hardening.sql redefine functions
// from the earlier 20260722191013_account_deletion_lifecycle.sql
// incompatibly:
//   - schedule_deletion_retry_or_fail: text -> boolean return type
//   - claim_deletion_requests_for_purge: p_lease_interval -> p_lease param
// Both are fixed with an explicit `drop function if exists ...` immediately
// before the incompatible redefinition. This test pins that repair so it
// can never silently regress, and also asserts the general filename/order
// contract the addendum requires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const LIFECYCLE_FILE = '20260722191013_account_deletion_lifecycle.sql';
const HARDENING_FILE = '20260723021145_account_deletion_security_hardening.sql';
const CRASH_RECOVERY_FILE = '20260723040000_account_deletion_crash_recovery.sql';

const lifecycleSource = fs.readFileSync(path.join(MIGRATIONS_DIR, LIFECYCLE_FILE), 'utf8');
const hardeningSource = fs.readFileSync(path.join(MIGRATIONS_DIR, HARDENING_FILE), 'utf8');
const crashRecoverySource = fs.readFileSync(path.join(MIGRATIONS_DIR, CRASH_RECOVERY_FILE), 'utf8');

/**
 * True if `dropPattern` appears in `source` and its match position is
 * strictly before the first `create or replace function <name>` for the
 * same function name — i.e. the drop actually precedes the redefinition,
 * not just appears somewhere in the file.
 */
function dropPrecedesRedefinition(source, functionName, dropPattern) {
  const dropMatch = source.match(dropPattern);
  if (!dropMatch) return false;
  const createRe = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`,
    'i',
  );
  const createMatch = source.match(createRe);
  if (!createMatch) return false;
  return dropMatch.index < createMatch.index;
}

// -- schedule_deletion_retry_or_fail: return-type conflict -----------------

test('lifecycle defines schedule_deletion_retry_or_fail returning text (ground truth for the conflict)', () => {
  assert.match(
    lifecycleSource,
    /create or replace function public\.schedule_deletion_retry_or_fail\(\s*p_request_id uuid,\s*p_worker_id text,\s*p_failure_code text,\s*p_failure_message text,\s*p_max_attempts integer default \d+\s*\)\s*returns text/,
  );
});

test('security-hardening redefines schedule_deletion_retry_or_fail returning boolean (the incompatible change)', () => {
  assert.match(
    hardeningSource,
    /create or replace function public\.schedule_deletion_retry_or_fail\(\s*p_request_id uuid,\s*p_worker_id text,\s*p_failure_code text,\s*p_failure_message text,\s*p_max_attempts integer default \d+\s*\)\s*returns boolean/,
  );
});

test('the incompatible schedule_deletion_retry_or_fail redefinition is preceded by an explicit drop of its full signature', () => {
  const dropPattern = /drop function if exists public\.schedule_deletion_retry_or_fail\(\s*uuid,\s*text,\s*text,\s*text,\s*integer\s*\);/;
  assert.ok(
    dropPrecedesRedefinition(hardeningSource, 'schedule_deletion_retry_or_fail', dropPattern),
    'expected an explicit drop function ... schedule_deletion_retry_or_fail(uuid, text, text, text, integer) before its redefinition',
  );
});

test('the schedule_deletion_retry_or_fail drop does not use CASCADE', () => {
  const dropMatch = hardeningSource.match(/drop function if exists public\.schedule_deletion_retry_or_fail\([\s\S]*?\);/);
  assert.ok(dropMatch, 'drop statement not found');
  assert.doesNotMatch(dropMatch[0], /cascade/i);
});

// -- claim_deletion_requests_for_purge: param-rename conflict ---------------

test('lifecycle defines claim_deletion_requests_for_purge with p_lease_interval (ground truth for the conflict)', () => {
  assert.match(
    lifecycleSource,
    /create or replace function public\.claim_deletion_requests_for_purge\(\s*p_worker_id text,\s*p_limit integer default \d+,\s*p_lease_interval interval default interval '5 minutes'\s*\)/,
  );
});

test('security-hardening redefines claim_deletion_requests_for_purge with p_lease (the incompatible rename)', () => {
  assert.match(
    hardeningSource,
    /create or replace function public\.claim_deletion_requests_for_purge\(\s*p_worker_id text,\s*p_limit integer default \d+,\s*p_lease interval default interval '5 minutes'\s*\)/,
  );
});

test('the incompatible claim_deletion_requests_for_purge redefinition is preceded by an explicit drop of its full signature', () => {
  const dropPattern = /drop function if exists public\.claim_deletion_requests_for_purge\(\s*text,\s*integer,\s*interval\s*\);/;
  assert.ok(
    dropPrecedesRedefinition(hardeningSource, 'claim_deletion_requests_for_purge', dropPattern),
    'expected an explicit drop function ... claim_deletion_requests_for_purge(text, integer, interval) before its redefinition',
  );
});

test('the claim_deletion_requests_for_purge drop does not use CASCADE', () => {
  const dropMatch = hardeningSource.match(/drop function if exists public\.claim_deletion_requests_for_purge\([\s\S]*?\);/);
  assert.ok(dropMatch, 'drop statement not found');
  assert.doesNotMatch(dropMatch[0], /cascade/i);
});

// -- Functions are actually recreated, and grants restored ------------------

test('both functions are recreated (not just dropped) in the security-hardening migration', () => {
  assert.match(hardeningSource, /create or replace function public\.schedule_deletion_retry_or_fail\(/);
  assert.match(hardeningSource, /create or replace function public\.claim_deletion_requests_for_purge\(/);
});

test('service_role retains execute on both functions after the hardening migration, and no other role gains access', () => {
  assert.match(
    hardeningSource,
    /revoke all on function public\.schedule_deletion_retry_or_fail\(uuid, text, text, text, integer\) from public;\s*grant execute on function public\.schedule_deletion_retry_or_fail\(uuid, text, text, text, integer\) to service_role;/,
  );
  assert.match(
    hardeningSource,
    /revoke all on function public\.claim_deletion_requests_for_purge\(text, integer, interval\) from public;\s*grant execute on function public\.claim_deletion_requests_for_purge\(text, integer, interval\) to service_role;/,
  );
  // No grant to authenticated/anon anywhere in this migration for either function.
  assert.doesNotMatch(hardeningSource, /grant execute on function public\.schedule_deletion_retry_or_fail\([^)]*\) to (authenticated|anon)/i);
  assert.doesNotMatch(hardeningSource, /grant execute on function public\.claim_deletion_requests_for_purge\([^)]*\) to (authenticated|anon)/i);
});

// -- The later crash-recovery definition is already consistent -------------

test('crash-recovery redefines both functions with signatures already consistent with security-hardening (no further conflict)', () => {
  assert.match(crashRecoverySource, /create or replace function public\.claim_deletion_requests_for_purge\(\s*p_worker_id text,\s*p_limit integer default \d+,\s*p_lease interval default interval '5 minutes'\s*\)\s*returns setof public\.deletion_requests/);
  assert.match(crashRecoverySource, /create or replace function public\.schedule_deletion_retry_or_fail\(\s*p_request_id uuid,\s*p_worker_id text,\s*p_failure_code text,\s*p_failure_message text,\s*p_max_attempts integer default \d+\s*\)\s*returns boolean/);
});

// -- Schema prerequisites: every referenced schema must be created ----------

test('the blocking migration creates the internal schema it depends on (clean-replay prerequisite)', () => {
  // 20260806153233 defines helpers in the `internal` schema. That schema is
  // otherwise created by 20260804090000_edge_function_errors.sql, which is
  // NOT part of this branch's migration set — so a clean replay from an
  // empty database failed with: ERROR: schema "internal" does not exist
  // (SQLSTATE 3F000). The migration must carry its own prerequisite.
  const blocking = fs.readFileSync(
    path.join(MIGRATIONS_DIR, '20260806153233_dressing_room_user_blocking.sql'),
    'utf8',
  );
  const createSchemaRe = /create schema if not exists internal;/i;
  assert.match(blocking, createSchemaRe, 'blocking migration must create the internal schema idempotently');

  // The create must precede the first use of the schema.
  const createIdx = blocking.match(createSchemaRe).index;
  const firstUseIdx = blocking.search(/create or replace function internal\./i);
  assert.ok(firstUseIdx > 0, 'expected at least one internal.* function definition');
  assert.ok(createIdx < firstUseIdx, 'create schema must precede the first internal.* definition');

  // Idempotent form only — a bare `create schema internal;` would break any
  // database that already has it (i.e. every hosted environment).
  assert.doesNotMatch(blocking, /create schema internal;/i);
});

test('no migration references a schema-qualified object in a schema no migration creates', () => {
  // Narrow, high-signal check: `internal` is the only non-standard schema
  // this migration set uses. Assert it is created somewhere before use.
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let createdAt = -1;
  let firstUsedAt = -1;
  files.forEach((name, index) => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    if (createdAt === -1 && /create schema if not exists internal;/i.test(sql)) createdAt = index;
    if (firstUsedAt === -1 && /\binternal\.[a-z_]+\s*\(/i.test(sql)) firstUsedAt = index;
  });
  assert.ok(createdAt !== -1, 'some migration must create the internal schema');
  assert.ok(firstUsedAt !== -1, 'expected the internal schema to be used');
  assert.ok(
    createdAt <= firstUsedAt,
    'the migration creating the internal schema must not sort after the first migration that uses it',
  );
});

// -- Filename/order contract -------------------------------------------------

test('all three account-deletion migrations exist, are uniquely named, and sort in the documented order', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  assert.equal(new Set(files).size, files.length, 'migration filenames must be unique');
  for (const name of [LIFECYCLE_FILE, HARDENING_FILE, CRASH_RECOVERY_FILE]) {
    assert.ok(files.includes(name), `expected migration to exist: ${name}`);
  }
  const sorted = [...files].sort();
  const lifecycleIdx = sorted.indexOf(LIFECYCLE_FILE);
  const hardeningIdx = sorted.indexOf(HARDENING_FILE);
  const crashRecoveryIdx = sorted.indexOf(CRASH_RECOVERY_FILE);
  assert.ok(lifecycleIdx < hardeningIdx, 'lifecycle must sort before security-hardening');
  assert.ok(hardeningIdx < crashRecoveryIdx, 'security-hardening must sort before crash-recovery');
});
