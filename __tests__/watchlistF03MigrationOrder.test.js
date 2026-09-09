// F-03: Watchlist migration ordering / fresh-replay certification.
//
// THE DEFECT. Commit 6b8d0390 (MIG-01) resolved the duplicate migration version
// 20260830160000, shared by two unrelated files, by renaming each to its true
// applied ledger version:
//
//   20260830160000_vto_feature_control.sql      -> 20260830174616_...
//   20260830160000_user_device_push_tokens.sql  -> 20260830212508_...
//
// The second rename is correct against the ledger and wrong against the source
// tree. 20260830190000_watchlist_push_token_actor_isolation.sql (DEF-WL-01)
// hardens the register_device_push_token() and the table that 20260830212508
// CREATES. On staging that hardening applied under ledger version
// 20260830214752 -- after its dependency, which is the intended order -- but
// its repo filename says 20260830190000, which sorts BEFORE it. The rename
// carried the dependency past its own dependent in filename order.
//
// Reproduced by real execution against a disposable PostgreSQL cluster
// (scripts/f03/replay.sh): a fresh replay aborts at that file with
//   ERROR: type "public.user_device_push_tokens" does not exist
// because `returns public.user_device_push_tokens` is resolved at CREATE time.
//
// THE REPAIR, pinned here so it cannot silently revert:
//   1. 20260830190000's executable body is wrapped in an existence guard, so on
//      a database that has not created the table yet it is a no-op rather than
//      an abort. Its version, filename and ledger identity are unchanged.
//   2. 20260909170000_..._reconciliation re-applies that identical hardening at
//      a version after the dependency and after every later migration that
//      touches the table, so a fresh replay converges on the DEF-WL-01 state.
//
// These are source-level assertions. The executable proof -- both database
// histories, data preservation, and two negative controls -- lives in
// scripts/f03/ and is driven by scripts/f03/certify.sh, which needs a local
// PostgreSQL cluster and therefore does not run inside this suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const DEPENDENT = '20260830190000_watchlist_push_token_actor_isolation.sql';
const DEPENDENCY = '20260830212508_user_device_push_tokens.sql';
const RECONCILIATION =
  '20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql';

// The hardening's true applied ledger identity on staging, recorded in
// config/migration-authority-manifest.json's entry for 20260830212508.
const DEPENDENT_LEDGER_VERSION = '20260830214752';

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const read = (f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
const versionOf = (f) => f.split('_')[0];

// Read tolerantly: if a repair part is missing entirely, every assertion that
// depends on it must report WHICH part is gone, rather than the whole file
// crashing at load with an ENOENT that names no repair.
const readOrEmpty = (f) => (fs.existsSync(path.join(MIGRATIONS_DIR, f)) ? read(f) : '');

const dependentSource = readOrEmpty(DEPENDENT);
const dependencySource = readOrEmpty(DEPENDENCY);
const reconciliationSource = readOrEmpty(RECONCILIATION);

// ── The inversion is real, and is what makes the repair necessary ──────────

test('F-03 ground truth: the hardening file sorts BEFORE the migration that creates what it hardens', () => {
  const dependentIndex = migrations.indexOf(DEPENDENT);
  const dependencyIndex = migrations.indexOf(DEPENDENCY);
  assert.notEqual(dependentIndex, -1, `${DEPENDENT} missing`);
  assert.notEqual(dependencyIndex, -1, `${DEPENDENCY} missing`);
  assert.ok(
    dependentIndex < dependencyIndex,
    'the ordering inversion F-03 repairs is gone; if the files were reordered, ' +
      'applied migration identities were rewritten, which F-03 forbids',
  );
});

test('F-03 ground truth: the dependency migration is the one that creates the table and the v1 RPC', () => {
  assert.match(dependencySource, /create table if not exists public\.user_device_push_tokens/);
  assert.match(
    dependencySource,
    /create or replace function public\.register_device_push_token\(/,
  );
});

test('F-03 ground truth: the hardening migration binds to that table at CREATE time', () => {
  // `returns public.user_device_push_tokens` is a composite-type reference
  // resolved when the function is created -- this is why the inverted order is
  // a hard abort rather than a deferred failure.
  assert.match(dependentSource, /returns public\.user_device_push_tokens/);
});

// ── Part 1: the guard ──────────────────────────────────────────────────────

test('F-03 repair part 1: the out-of-order hardening cannot abort a fresh replay', () => {
  assert.match(
    dependentSource,
    /do \$f03_guard\$/,
    'the hardening migration must be wrapped in an existence guard',
  );
  assert.match(
    dependentSource,
    /if to_regclass\('public\.user_device_push_tokens'\) is null then/,
    'the guard must test for the table it depends on',
  );
  const guardIndex = dependentSource.indexOf('do $f03_guard$');
  const firstExecutable = dependentSource.search(
    /create or replace function public\.register_device_push_token\(/,
  );
  assert.ok(
    guardIndex !== -1 && guardIndex < firstExecutable,
    'the guard must open before any executable statement in the file',
  );
});

test('F-03 repair part 1: the guard preserves the hardening verbatim, it does not weaken it', () => {
  // Same competing-route retirement, same partial unique index, same
  // service-role-only grants as before the guard was added.
  assert.match(
    dependentSource,
    /and \(device_id = p_device_id or push_token = p_push_token\)/,
  );
  assert.match(
    dependentSource,
    /create unique index if not exists user_device_push_tokens_live_token_uidx/,
  );
  assert.match(
    dependentSource,
    /grant execute on function public\.register_device_push_token\(uuid, text, text, text\) to service_role/,
  );
  assert.doesNotMatch(
    dependentSource,
    /grant execute on function public\.register_device_push_token[^;]*to (anon|authenticated)/,
  );
});

// ── Part 2: the forward reconciliation ─────────────────────────────────────

test('F-03 repair part 2: a reconciliation migration exists and is additive, not a rename', () => {
  assert.ok(migrations.includes(RECONCILIATION), `${RECONCILIATION} missing`);
  assert.ok(
    versionOf(RECONCILIATION) > versionOf(DEPENDENCY),
    'the reconciliation must sort after the migration that creates the table',
  );
});

test('F-03 repair part 2: the reconciliation sorts after EVERY migration that touches the token table', () => {
  const touching = migrations.filter(
    (f) => f !== RECONCILIATION && read(f).includes('user_device_push_tokens'),
  );
  assert.ok(touching.length >= 4, 'expected the known set of files touching the table');
  for (const f of touching) {
    assert.ok(
      versionOf(RECONCILIATION) > versionOf(f),
      `${RECONCILIATION} must sort after ${f}, or a later migration could overwrite the repair`,
    );
  }
});

test('F-03 repair part 2: the reconciliation re-establishes the DEF-WL-01 hardened body', () => {
  assert.match(
    reconciliationSource,
    /create or replace function public\.register_device_push_token\(/,
  );
  assert.match(
    reconciliationSource,
    /and \(device_id = p_device_id or push_token = p_push_token\)/,
    'the reconciliation must install the competing-route retirement, not the v1 body',
  );
  assert.match(
    reconciliationSource,
    /create unique index if not exists user_device_push_tokens_live_token_uidx\s+on public\.user_device_push_tokens \(push_token\)\s+where revoked_at is null/,
  );
});

test('F-03 repair part 2: the reconciliation fails loudly rather than silently skipping', () => {
  // Unlike the guard, this file is the ONLY thing establishing DEF-WL-01 on a
  // fresh database, so a missing dependency here must stop the replay.
  assert.match(reconciliationSource, /raise exception\s*\n?\s*'F-03: public\.user_device_push_tokens is absent/);
  assert.match(
    reconciliationSource,
    /raise exception[\s\S]{0,200}not DEF-WL-01 hardened/,
    'the reconciliation must assert its own end state, not assume it',
  );
});

test('F-03 repair part 2: the reconciliation is non-destructive', () => {
  const executable = reconciliationSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  for (const pattern of [
    /\bdrop table\b/i,
    /\bdrop column\b/i,
    /\bdrop index\b/i,
    /\bdrop function\b/i,
    /\btruncate\b/i,
    /\bdelete\s+from\b/i,
    /\balter table[^;]*drop\b/i,
  ]) {
    assert.doesNotMatch(executable, pattern, `reconciliation must not contain ${pattern}`);
  }
});

test('F-03 repair part 2: the reconciliation loosens no privilege', () => {
  const executable = reconciliationSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(executable, /grant[^;]*\bto\b[^;]*\banon\b/i);
  assert.doesNotMatch(executable, /grant[^;]*\bto\b[^;]*\bauthenticated\b/i);
  assert.doesNotMatch(executable, /\bdisable row level security\b/i);
  assert.doesNotMatch(executable, /\bcreate policy\b/i);
  assert.match(
    executable,
    /revoke all on function public\.register_device_push_token\(uuid, text, text, text\) from public, anon, authenticated/,
  );
});

// ── Applied identities are preserved (§4) ─────────────────────────────────

test('F-03: no applied migration identity was renamed, deleted or reused', () => {
  // Every version prefix is unique, both target files still exist under their
  // applied names, and the reconciliation claims a brand-new version rather
  // than reusing one.
  const versions = migrations.map(versionOf);
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual(duplicates, [], `duplicate migration versions: ${duplicates.join(', ')}`);

  assert.ok(migrations.includes(DEPENDENT), `${DEPENDENT} must keep its applied filename`);
  assert.ok(migrations.includes(DEPENDENCY), `${DEPENDENCY} must keep its applied filename`);
  assert.equal(
    versions.filter((v) => v === versionOf(RECONCILIATION)).length,
    1,
    'the reconciliation must not reuse an existing migration version',
  );
});

test('F-03: the repair does not activate the evaluator, worker or any schedule', () => {
  const executable = reconciliationSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(executable, /pg_cron/i);
  assert.doesNotMatch(executable, /cron\.schedule/i);
  assert.doesNotMatch(executable, /\bpg_net\b/i);
  assert.doesNotMatch(executable, /watchlist_worker/i);
});

test('F-03: the repair does not touch the N-4 receipt table', () => {
  const executable = reconciliationSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(executable, /watchlist_push_receipts/);
});

// ── The ledger identity the repair reasons from is the recorded one ────────

test('F-03: the authority manifest still records the ledger version the repair reasons from', () => {
  const manifest = require(path.join(ROOT, 'config', 'migration-authority-manifest.json'));
  const entry = manifest.entries.find((e) => e.ledgerVersion === versionOf(DEPENDENCY));
  assert.ok(entry, `no authority entry for ledger version ${versionOf(DEPENDENCY)}`);
  assert.ok(
    entry.note.includes(DEPENDENT_LEDGER_VERSION),
    `the authority note must still record ${DEPENDENT_LEDGER_VERSION} as the hardening's applied ledger version`,
  );
  assert.equal(
    entry.sourceOriginalFilename,
    'supabase/migrations/20260830160000_user_device_push_tokens.sql',
    'the rename that caused F-03 must remain recorded',
  );
});

// ── The executable certification harness is present and wired ──────────────

test('F-03: the executable replay/upgrade certification harness is committed', () => {
  for (const f of [
    'scripts/f03/replay.sh',
    'scripts/f03/verify.sh',
    'scripts/f03/verify-watchlist-schema.sql',
    'scripts/f03/upgrade-fixture.sql',
    'scripts/f03/snapshot.sql',
    'scripts/f03/behaviour-test.sql',
    'scripts/f03/negative-control.sh',
    'scripts/f03/certify.sh',
    'scripts/f03/supabase-bootstrap.sql',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} missing`);
  }
});
