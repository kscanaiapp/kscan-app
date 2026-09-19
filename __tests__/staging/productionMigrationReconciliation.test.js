/**
 * Hostile tests for the PRODUCTION migration reconciliation authority and the
 * single-approved-migration selection gate.
 *
 * The model under test is
 *
 *   EXACTLY_ONE_EXPLICITLY_APPROVED_PENDING_MIGRATION + ZERO_UNEXPLAINED_DRIFT
 *
 * so these tests are written to attack it from the direction that matters: can
 * anything become executable WITHOUT being explicitly approved, and can unknown
 * drift ever pass? Every test below either proves a legitimate selection of
 * exactly one migration, or proves a refusal.
 *
 * Nothing here touches a database. The gate is pure: it takes the local
 * inventory, the remote ledger and the declared authority and returns a
 * decision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFLIGHT = path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs');
const APPLIER = path.join(ROOT, 'scripts', 'apply-production-migration.mjs');
const RECON = path.join(ROOT, 'scripts', 'lib', 'migration-reconciliation.mjs');
const MANIFEST = path.join(ROOT, 'config', 'migration-authority-manifest.json');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_REF = 'yzqjvdfgefveprobvvyw';

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

const loadPreflight = () => import(pathToFileUrl(PREFLIGHT));
const loadApplier = () => import(pathToFileUrl(APPLIER));
const loadRecon = () => import(pathToFileUrl(RECON));

/** local migration inventory in the shape listLocalMigrationVersions returns */
function localOf(...versions) {
  return versions.map((version) => ({
    version,
    name: `m_${version}`,
    path: `supabase/migrations/${version}_m_${version}.sql`,
  }));
}

const EVIDENCE = 'proven by direct object inspection on production, read-only, 2026-09-19';

function knownPending(version, disposition = 'KNOWN_FUTURE_UNAPPLIED') {
  return { localVersion: version, logicalName: `m_${version}`, disposition, evidence: EVIDENCE };
}

function reconciledEntry(localVersion, remoteVersions, classification = 'EQUIVALENT_RENUMBER') {
  return { localVersion, logicalName: `m_${localVersion}`, remoteVersions, classification, evidence: EVIDENCE };
}

function remoteOnlyEntry(remoteVersion, classification = 'PRODUCTION_ONLY_HISTORICAL') {
  return { remoteVersion, logicalName: `m_${remoteVersion}`, classification, evidence: EVIDENCE };
}

/** The four account-deletion versions the production campaign actually cares about. */
const AD_DB_001 = '20260831140000'; // deleted_owner_retained_media  <- the controlled test case
const AD_DB_002 = '20260908230000';
const AD_DB_003 = '20260916130553';
const AD_DB_004 = '20260917163000';
const ALL_FOUR = [AD_DB_001, AD_DB_002, AD_DB_003, AD_DB_004];

/** An authority that declares all four as legitimately pending and nothing else. */
function fourPendingAuthority(extra = {}) {
  return {
    reconciled: [],
    knownPending: ALL_FOUR.map((v) => knownPending(v)),
    remoteOnly: [],
    genuinelyUnapplied: [],
    ...extra,
  };
}

const REMOTE_BASE = ['20260101000000'];
const LOCAL_BASE = localOf('20260101000000', ...ALL_FOUR);

// ---------------------------------------------------------------- 1, 2, 3, 19

test('1. many known pending migrations plus one approved version PASSES', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, fourPendingAuthority());

  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.equal(result.knownPending.length, 4, 'all four stay visible as known pending');
  assert.equal(result.unexplainedRemote.length, 0);
  assert.equal(result.unexplainedLocal.length, 0);
});

test('2. exactly the approved migration is selected, and only it', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, fourPendingAuthority());

  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.equal(result.approvedPending.version, AD_DB_001);
  assert.equal(result.approvedSelectedForExecution, 1, 'exactly one migration may execute');
  assert.equal(result.otherKnownPendingCount, 3);
});

test('3. the other three pending migrations remain pending and untouched', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, fourPendingAuthority());

  const stillPending = result.knownPending.map((m) => m.version);
  for (const other of [AD_DB_002, AD_DB_003, AD_DB_004]) {
    assert.ok(stillPending.includes(other), `${other} must remain pending`);
  }
  assert.equal(result.approvedPending.version, AD_DB_001);
});

test('19. approving one version can never cause another migration to execute', async () => {
  const { resolveApprovedMigration, validateKnownPending, validateReconciliation } = await loadRecon();
  const localSet = new Set(LOCAL_BASE.map((m) => m.version));
  const remoteSet = new Set(REMOTE_BASE);
  const auth = fourPendingAuthority();
  const { aliasedLocal } = validateReconciliation([], localSet, remoteSet);
  const { declaredPending } = validateKnownPending(auth.knownPending, localSet, remoteSet, aliasedLocal);
  const pending = LOCAL_BASE.filter((m) => !remoteSet.has(m.version));

  // Approve each of the four in turn. Each time, exactly one is selected, and it
  // is always the one that was approved.
  for (const approved of ALL_FOUR) {
    const out = resolveApprovedMigration({
      approvedVersion: approved,
      pending,
      declaredPending,
      aliasedLocal,
      remoteSet,
      localSet,
      requireDeclaration: true,
    });
    assert.equal(out.blockers.length, 0, `${approved}: ${out.blockers.join(', ')}`);
    assert.equal(out.selected.version, approved, 'the selection is always the approved version');
    const selectedCount = ALL_FOUR.filter((v) => out.selected.version === v).length;
    assert.equal(selectedCount, 1, 'exactly one of the four is ever selected');
  }
});

test('the selection mechanism is not hardcoded to AD-DB-001', async () => {
  const { compareMigrations } = await loadPreflight();
  const second = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_002, fourPendingAuthority());

  assert.equal(second.ok, true, second.blockers.join('\n'));
  assert.equal(second.approvedPending.version, AD_DB_002);
  assert.equal(second.approvedSelectedForExecution, 1);
  assert.ok(
    second.knownPending.map((m) => m.version).includes(AD_DB_001),
    'AD-DB-001 goes back to being merely pending when a different version is approved',
  );
});

// ------------------------------------------------------------------- 4, 5, 6

test('4. an approved version that is absent from the local tree FAILS', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, '20269999999999', fourPendingAuthority());

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('20269999999999')));
  assert.equal(result.approvedSelectedForExecution, 0);
  assert.equal(result.approvedPending, undefined);
});

test('5. an approved version the production ledger already holds selects nothing, and the applier refuses it', async () => {
  const { compareMigrations } = await loadPreflight();
  const { selectApprovedMigration } = await loadApplier();

  const remote = [...REMOTE_BASE, AD_DB_001];
  const auth = {
    reconciled: [],
    knownPending: [AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    remoteOnly: [],
  };

  // The preflight re-runs after a successful apply carrying the same approval,
  // so it reports it as satisfied -- but it never selects it for execution.
  const pre = compareMigrations(LOCAL_BASE, remote, AD_DB_001, auth);
  assert.equal(pre.approvedAlreadyApplied, AD_DB_001);
  assert.equal(pre.approvedSelectedForExecution, 0, 'an applied version is never selected');
  assert.equal(pre.approvedPending, undefined);

  // The applier, which is the thing that would actually mutate production,
  // refuses outright.
  const decision = selectApprovedMigration({
    local: LOCAL_BASE,
    remote,
    approvedVersion: AD_DB_001,
    reconciliation: auth,
  });
  assert.equal(decision.selected, null);
  assert.ok(decision.blockers.some((b) => b.includes('already recorded on production')));
});

test('6. an approved version declared as a reconciled equivalent FAILS', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE, '20260831135251'];
  const auth = {
    reconciled: [reconciledEntry(AD_DB_001, ['20260831135251'])],
    knownPending: [AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    remoteOnly: [],
  };
  const result = compareMigrations(LOCAL_BASE, remote, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => b.includes('declared reconciled')),
    result.blockers.join('\n'),
  );
  assert.equal(result.approvedSelectedForExecution, 0);
});

// ---------------------------------------------------------------- 7, 8, 9

test('7. an approved version declared HOLD FAILS', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [
      knownPending(AD_DB_001, 'HOLD'),
      ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    ],
  });
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('HOLD')), result.blockers.join('\n'));
  assert.equal(result.approvedSelectedForExecution, 0);
});

test('8. an approved version declared EXCLUDE FAILS', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [
      knownPending(AD_DB_001, 'EXCLUDE'),
      ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    ],
  });
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('EXCLUDE')), result.blockers.join('\n'));
  assert.equal(result.approvedSelectedForExecution, 0);
});

test('9. an approved version whose effect is obsolete/superseded FAILS', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE];
  const auth = {
    // SUPERSEDED_BY_LATER_MIGRATION is the one classification allowed to name no
    // remote version. It still asserts "already accounted for", so it must still
    // refuse execution.
    reconciled: [reconciledEntry(AD_DB_001, [], 'SUPERSEDED_BY_LATER_MIGRATION')],
    knownPending: [AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    remoteOnly: [],
  };
  const result = compareMigrations(LOCAL_BASE, remote, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('SUPERSEDED_BY_LATER_MIGRATION')));
  assert.equal(result.approvedSelectedForExecution, 0);
});

// -------------------------------------------------------------- 10, 11, 12

test('10. an UNKNOWN remote-only version FAILS even with a valid approval', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE, '20260816020548'];
  const result = compareMigrations(LOCAL_BASE, remote, AD_DB_001, fourPendingAuthority());

  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => b.includes('remote-only migrations exist with no declared reconciliation')),
    result.blockers.join('\n'),
  );
  assert.deepEqual(result.unexplainedRemote, ['20260816020548']);
});

test('11. an UNKNOWN local divergence FAILS even with a valid approval', async () => {
  const { compareMigrations } = await loadPreflight();
  const local = localOf('20260101000000', ...ALL_FOUR, '20260404040404');
  const result = compareMigrations(local, REMOTE_BASE, AD_DB_001, fourPendingAuthority());

  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => b.includes('20260404040404')),
    result.blockers.join('\n'),
  );
  assert.deepEqual(result.unexplainedLocal.map((m) => m.version), ['20260404040404']);
});

test('12. a KNOWN production-only remote version passes reconciliation', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE, '20260816020548'];
  const auth = fourPendingAuthority({ remoteOnly: [remoteOnlyEntry('20260816020548')] });
  const result = compareMigrations(LOCAL_BASE, remote, AD_DB_001, auth);

  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.deepEqual(result.unexplainedRemote, []);
  assert.deepEqual(
    result.remoteOnlyAllowed.map((r) => r.version),
    ['20260816020548'],
  );
  assert.equal(result.remoteOnlyAllowed[0].classification, 'PRODUCTION_ONLY_HISTORICAL');
});

// ------------------------------------------------------------------------ 13

test('13. no approved migration means nothing is selected and nothing may mutate', async () => {
  const { compareMigrations } = await loadPreflight();
  const { selectApprovedMigration } = await loadApplier();

  const pre = compareMigrations(LOCAL_BASE, REMOTE_BASE, '', fourPendingAuthority());
  assert.equal(pre.approvedSelectedForExecution, 0);
  assert.equal(pre.approvedPending, undefined);
  assert.equal(pre.knownPending.length, 4, 'all four stay pending and none is chosen');

  const decision = selectApprovedMigration({
    local: LOCAL_BASE,
    remote: REMOTE_BASE,
    approvedVersion: '',
    reconciliation: fourPendingAuthority(),
  });
  assert.equal(decision.selected, null, 'the applier selects nothing without an approval');
  assert.ok(decision.blockers.some((b) => b.includes('No approved migration was supplied')));
});

// ---------------------------------------------------- 14, 15, 16, 17 (applier)

const loadProductionHelpers = () =>
  import(pathToFileUrl(path.join(ROOT, 'scripts', 'lib', 'production-helpers.mjs')));

test('14. targeting the STAGING project ref is refused', async () => {
  const { assertProductionTarget } = await loadProductionHelpers();

  assert.throws(
    () =>
      assertProductionTarget({
        projectRef: STAGING_REF,
        url: `https://${STAGING_REF}.supabase.co`,
        anonKey: 'anon',
      }),
    /equals staging — refusing/,
    'the staging ref must be refused outright',
  );

  // Even a production ref paired with a staging URL is refused.
  assert.throws(
    () =>
      assertProductionTarget({
        projectRef: PRODUCTION_REF,
        url: `https://${STAGING_REF}.supabase.co`,
        anonKey: 'anon',
      }),
    /points at staging — refusing/,
  );

  // And the applier really does call this guard before anything else.
  const src = fs.readFileSync(APPLIER, 'utf8');
  assert.match(src, /identity = assertProductionTarget\(\)/);
  assert.ok(
    src.indexOf('assertProductionTarget()') < src.indexOf("runSupabaseProduction(['db', 'query'"),
    'the target guard must precede execution',
  );
});

test('15. targeting an unknown project ref is refused', async () => {
  const { assertProductionTarget } = await loadProductionHelpers();

  assert.throws(
    () =>
      assertProductionTarget({
        projectRef: 'zzzzzzzzzzzzzzzzzzzz',
        url: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',
        anonKey: 'anon',
      }),
    /Production project ref must be wyyuqfdxucjksghsmhry/,
    'only the pinned production ref is ever accepted',
  );

  assert.throws(
    () => assertProductionTarget({ projectRef: '', url: '', anonKey: '' }),
    /SUPABASE_PRODUCTION_PROJECT_REF is absent/,
    'an absent ref fails closed rather than defaulting',
  );
});

test('16. the applier refuses a stale governed SHA', () => {
  const src = fs.readFileSync(APPLIER, 'utf8');
  assert.match(src, /assertGovernedCommit\(governedBranch\)/);
  const preflight = fs.readFileSync(path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs'), 'utf8');
  assert.match(preflight, /is not the current tip of/, 'HEAD must equal the governed branch tip');
});

test('17. a dirty worktree is refused, with no escape hatch', () => {
  const preflight = fs.readFileSync(path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs'), 'utf8');
  assert.match(preflight, /production never deploys from a dirty worktree/);
  assert.match(preflight, /if \(!gitWorkingTreeClean\(\)\)/, 'the check is unconditional');

  // The staging preflight offers --allow-dirty and a CI bypass. The production
  // one must offer neither: its parseArgs accepts only --json and --skip-remote.
  const parseArgs = preflight.slice(preflight.indexOf('function parseArgs'));
  const body = parseArgs.slice(0, parseArgs.indexOf('}\n'));
  assert.doesNotMatch(body, /allowDirty/, 'production parses no allow-dirty flag');
  assert.doesNotMatch(body, /CI === 'true'/, 'production has no CI bypass for a dirty tree');

  const staging = fs.readFileSync(path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs'), 'utf8');
  assert.match(staging, /allowDirty/, 'staging keeps its own flag — this is a production-only rule');
});

test('18. a migration carrying prohibited SQL FAILS before anything runs', () => {
  const src = fs.readFileSync(APPLIER, 'utf8');
  assert.match(src, /scanSqlForProhibited\(sql, \{ allowDestructive \}\)/);
  assert.match(src, /Migration blocked by prohibited SQL patterns/);

  // The prohibited-SQL scan must happen BEFORE the SQL is executed.
  assert.ok(
    src.indexOf('Migration blocked by prohibited SQL patterns') <
      src.indexOf("runSupabaseProduction(['db', 'query'"),
    'the prohibited-SQL gate must precede execution',
  );
});

// ------------------------------------------------------------------------ 20

test('20. post-apply reconciliation detects an unexpected ledger change', () => {
  const src = fs.readFileSync(APPLIER, 'utf8');

  assert.match(src, /unexpectedLedgerAdditions/, 'the applier computes unexpected ledger additions');
  assert.match(
    src,
    /afterRemote\.filter\(\s*\(v\) => v !== version && !remote\.includes\(v\)/,
    'anything added to the ledger other than the approved version is unexpected',
  );
  assert.match(src, /UNEXPECTED_DRIFT/, 'the artifact records the unexpected-drift outcome');
  assert.match(
    src,
    /otherMigrationsApplied: unexpectedLedgerAdditions\.length/,
    'the artifact reports what happened, never a hardcoded zero',
  );
  assert.match(
    src,
    /if \(remoteOnly\.length > 0 \|\| localOnly\.length > 0 \|\| unexpectedLedgerAdditions\.length > 0\) \{\s*process\.exit\(1\);/,
    'unexpected post-apply drift must exit non-zero',
  );
  // Post-apply verification still asserts that exactly the approved version landed.
  assert.match(src, /Post-apply verification failed: version \$\{version\} not present/);
});

// -------------------------------------------------- the applier never loops

test('the applier applies exactly one governed file and never loops or pushes', () => {
  const src = fs.readFileSync(APPLIER, 'utf8');

  // Strip comments first: the file's own header legitimately NAMES the commands
  // it refuses to use, and a naive grep would match that prose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.doesNotMatch(code, /'db',\s*'push'/, 'db push is never invoked');
  assert.doesNotMatch(code, /'migration',\s*'up'/, 'migration up is never invoked');
  assert.doesNotMatch(code, /'db',\s*'reset'/, 'db reset is never invoked');

  // Exactly one apply call, and it takes the resolved governed file path.
  const applyCalls = src.match(/runSupabaseProduction\(\['db', 'query', '--linked', '-f'/g) || [];
  assert.equal(applyCalls.length, 1, 'exactly one SQL apply call exists');
  assert.match(src, /'-f', migration\.path/, 'the apply reads the exact governed file');

  // Exactly one ledger write, for exactly the approved version.
  const repairCalls = src.match(/'migration', 'repair', version/g) || [];
  assert.equal(repairCalls.length, 1, 'exactly one ledger record call exists');

  // No iteration over the pending set anywhere near execution.
  assert.doesNotMatch(src, /for\s*\(\s*const\s+\w+\s+of\s+pending\s*\)/, 'the applier never loops over pending');
  assert.doesNotMatch(src, /pending\.forEach/, 'the applier never iterates pending');
});

test('MIGRATION_FILE cannot substitute alternate SQL for an approved governed version', async (t) => {
  const { resolveMigrationFile } = await loadApplier();
  const governed = resolveMigrationFile(AD_DB_001, '');
  assert.equal(path.basename(governed.path), `${AD_DB_001}_deleted_owner_retained_media.sql`);
  assert.equal(resolveMigrationFile(AD_DB_001, governed.path).path, governed.path);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-migration-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const substitute = path.join(dir, `${AD_DB_001}_substitute.sql`);
  fs.writeFileSync(substitute, 'select 1; -- different SQL under an approved version\n');

  const script = [
    `import { resolveMigrationFile } from ${JSON.stringify(pathToFileUrl(APPLIER))};`,
    `resolveMigrationFile(${JSON.stringify(AD_DB_001)}, ${JSON.stringify(substitute)});`,
  ].join('\n');
  const attempt = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(attempt.status, 1, attempt.stderr || attempt.stdout);
  assert.match(attempt.stderr, /MIGRATION_FILE must resolve to the governed local migration/);
});

test('the old pending.length === 1 invariant is gone', () => {
  const src = fs.readFileSync(APPLIER, 'utf8');
  assert.doesNotMatch(src, /pending\.length !== 1/);
  assert.doesNotMatch(src, /Expected exactly one approved pending migration/);
  assert.match(src, /selectApprovedMigration/, 'replaced by the explicit selection gate');
});

// -------------------------------------------- the shipped production authority

test('the shipped production authority explains every divergent version', async () => {
  const { loadLedgerReconciliation } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);

  const localVersions = fs
    .readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.match(/^(\d+)_/)[1]);

  const reconciledLocal = new Set(prod.reconciled.map((r) => r.localVersion));
  const declaredPending = new Set(prod.knownPending.map((k) => k.localVersion));

  // Every declaration must name a real file. A rotted authority is a blocker.
  for (const v of [...reconciledLocal, ...declaredPending]) {
    assert.ok(localVersions.includes(v), `declared version ${v} has no migration file`);
  }

  // No version may be both reconciled (effect present) and known-pending
  // (effect absent). That contradiction is what the validator exists to catch.
  for (const v of declaredPending) {
    assert.ok(!reconciledLocal.has(v), `${v} is declared both reconciled and pending`);
  }

  // The four account-deletion migrations are declared, and only the first is
  // approvable in the way the campaign expects: all four are KNOWN_FUTURE_UNAPPLIED.
  for (const v of ALL_FOUR) {
    const entry = prod.knownPending.find((k) => k.localVersion === v);
    assert.ok(entry, `${v} must be declared in the production authority`);
    assert.equal(entry.disposition, 'KNOWN_FUTURE_UNAPPLIED', `${v} must be approvable`);
  }
});

test('the production authority never declares a HOLD or EXCLUDE migration approvable', async () => {
  const { loadLedgerReconciliation, APPROVABLE_DISPOSITIONS } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);

  assert.deepEqual([...APPROVABLE_DISPOSITIONS], ['KNOWN_FUTURE_UNAPPLIED']);

  const held = prod.knownPending.filter((k) => k.disposition !== 'KNOWN_FUTURE_UNAPPLIED');
  assert.ok(held.length > 0, 'production really does carry HOLD/EXCLUDE entries');
  for (const entry of held) {
    assert.ok(
      !APPROVABLE_DISPOSITIONS.has(entry.disposition),
      `${entry.localVersion} (${entry.disposition}) must not be approvable`,
    );
  }
});

test('the reaction-count token contract is NOT laundered as already reconciled', async () => {
  const { loadLedgerReconciliation } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);

  // Production exposes only get_item_reaction_counts(uuid[]). The two migrations
  // that introduce the token-bound two-argument contract are therefore genuinely
  // absent, and must never be recorded as reconciled -- that would assert a
  // client-facing RPC contract production does not have.
  for (const version of ['20260916203000', '20260916233708']) {
    assert.ok(
      !prod.reconciled.some((r) => r.localVersion === version),
      `${version} must not be declared reconciled: its effect is absent from production`,
    );
    const entry = prod.knownPending.find((k) => k.localVersion === version);
    assert.ok(entry, `${version} must be declared as pending`);
    assert.equal(entry.disposition, 'HOLD', `${version} is held behind the Build 34 client change`);
    assert.match(entry.evidence, /one-argument|B34-FE-DR-001/);
  }
});

// SUPERSEDED by the sequential-campaign lifecycle (FIX 1). A KNOWN_FUTURE_UNAPPLIED
// entry whose version lands in the ledger is FULFILLED, not stale authority --
// otherwise every successful migration would invalidate the manifest and demand a
// source edit before the next one could run. The tolerance is asymmetric, and
// this test now pins both halves of that asymmetry.
test('a knownPending version the ledger holds is FULFILLED for KNOWN_FUTURE_UNAPPLIED, and a blocker otherwise', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE, AD_DB_001];

  const tolerated = compareMigrations(LOCAL_BASE, remote, '', fourPendingAuthority());
  assert.equal(tolerated.ok, true, tolerated.blockers.join('\n'));
  assert.deepEqual(tolerated.fulfilled.map((f) => f.version), [AD_DB_001]);
  assert.ok(!tolerated.knownPending.map((m) => m.version).includes(AD_DB_001));

  for (const disposition of ['HOLD', 'EXCLUDE']) {
    const auth = fourPendingAuthority({
      knownPending: [
        knownPending(AD_DB_001, disposition),
        ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
      ],
    });
    const refused = compareMigrations(LOCAL_BASE, remote, '', auth);
    assert.equal(refused.ok, false, `${disposition} present remotely must fail closed`);
    assert.ok(refused.blockers.some((b) => b.includes('unexplained production mutation')));
  }
});

test('a knownPending declaration for a version that does not exist locally is a blocker', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [...ALL_FOUR.map((v) => knownPending(v)), knownPending('20269999999999')],
  });
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('stale authority')));
});

test('a knownPending entry with no evidence is a blocker', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [
      { localVersion: AD_DB_001, logicalName: 'x', disposition: 'KNOWN_FUTURE_UNAPPLIED', evidence: '  ' },
      ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    ],
  });
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('evidence is required')));
});

test('a knownPending entry with an invented disposition is a blocker', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [
      knownPending(AD_DB_001, 'DEFINITELY_FINE'),
      ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    ],
  });
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, auth);

  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('disposition must be one of')));
});

test('a version cannot be both reconciled and known-pending', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE, '20260831135251'];
  const auth = {
    reconciled: [reconciledEntry(AD_DB_001, ['20260831135251'])],
    knownPending: ALL_FOUR.map((v) => knownPending(v)),
    remoteOnly: [],
  };
  const result = compareMigrations(LOCAL_BASE, remote, '', auth);

  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => b.includes('contradictory authority')),
    result.blockers.join('\n'),
  );
});

test('an environment variable alone can never make a migration executable', async () => {
  const { compareMigrations } = await loadPreflight();
  // No authority at all for this environment: the approved version is pending,
  // but nothing explains the rest of the divergence, so it still fails closed.
  const emptyAuthority = { reconciled: [], knownPending: [], remoteOnly: [] };
  const result = compareMigrations(LOCAL_BASE, REMOTE_BASE, AD_DB_001, emptyAuthority);

  assert.equal(result.ok, false, 'an undeclared environment keeps the strict one-pending rule');
  assert.ok(result.blockers.some((b) => b.includes('multiple pending migrations')));
});

test('staging semantics are unchanged: no knownPending means one pending migration only', async () => {
  const { compareMigrations, loadLedgerReconciliation } = await loadPreflight();
  const staging = loadLedgerReconciliation(STAGING_REF, MANIFEST);
  assert.deepEqual(staging.knownPending, [], 'staging declares no knownPending');

  const result = compareMigrations(localOf('20260101000000', '20260202000000'), [], '', {
    reconciled: [],
    knownPending: [],
    remoteOnly: [],
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('multiple pending migrations')));
});

test('a manifest that cannot be parsed is a hard error, never a silent empty authority', async () => {
  const { loadLedgerReconciliation } = await loadRecon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-manifest-'));
  const file = path.join(dir, 'migration-authority-manifest.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadLedgerReconciliation(PRODUCTION_REF, file), /unparseable/);
});

test('a knownPending section that is not an array is a hard error', async () => {
  const { loadLedgerReconciliation } = await loadRecon();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-manifest-'));
  const file = path.join(dir, 'migration-authority-manifest.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      ledgerReconciliation: { environments: { [PRODUCTION_REF]: { knownPending: 'all of them' } } },
    }),
  );
  assert.throws(() => loadLedgerReconciliation(PRODUCTION_REF, file), /knownPending must be an array/);
});

// ===========================================================================
// RELEASE-SAFETY REPAIR PASS
//
// The tests above prove ONE migration can be selected safely. These prove the
// CAMPAIGN is safe: that four migrations can be applied one at a time, in
// sequence, against a single unchanged authority manifest, and that the
// migrations the owner has taken out of Build 34 scope can never be selected.
// ===========================================================================

// --------------------------------------------------- sequential campaign (1-3)

test('SEQ 1. M1 -> M2 -> M3 -> M4 runs to completion on ONE unchanged manifest', async () => {
  const { compareMigrations } = await loadPreflight();

  // Authored ONCE, deliberately frozen, and deep-frozen so that any attempt to
  // mutate it between steps throws rather than quietly passing the test.
  const AUTHORITY = Object.freeze(fourPendingAuthority());
  Object.freeze(AUTHORITY.knownPending);
  AUTHORITY.knownPending.forEach(Object.freeze);
  const authoritySnapshot = JSON.stringify(AUTHORITY);

  let remote = [...REMOTE_BASE];
  const applied = [];

  for (const step of ALL_FOUR) {
    const result = compareMigrations(LOCAL_BASE, remote, step, AUTHORITY);

    assert.equal(result.ok, true, `approving ${step}: ${result.blockers.join('\n')}`);
    assert.equal(result.approvedPending.version, step, `${step} must be the selection`);
    assert.equal(result.approvedSelectedForExecution, 1, `${step}: exactly one selection`);

    // Everything already applied is FULFILLED: no longer pending, still visible.
    assert.deepEqual(
      result.fulfilled.map((f) => f.version).sort(),
      [...applied].sort(),
      `${step}: fulfilled set must be exactly what has been applied`,
    );
    for (const done of applied) {
      assert.ok(
        !result.knownPending.map((m) => m.version).includes(done),
        `${done} must not still be pending after it was applied`,
      );
    }

    // Simulate a SUCCESSFUL apply: the ledger gains exactly this version.
    // The manifest is NOT touched.
    remote = [...remote, step];
    applied.push(step);
  }

  assert.equal(applied.length, 4, 'all four migrations ran');
  assert.equal(
    JSON.stringify(AUTHORITY),
    authoritySnapshot,
    'the authority manifest was never edited during the campaign',
  );

  // Campaign complete: nothing left pending, all four fulfilled, still green.
  const final = compareMigrations(LOCAL_BASE, remote, '', AUTHORITY);
  assert.equal(final.ok, true, final.blockers.join('\n'));
  assert.equal(final.knownPending.length, 0, 'nothing remains pending');
  assert.equal(final.fulfilled.length, 4, 'all four are fulfilled');
});

test('SEQ 2. a FULFILLED entry does not block the next migration or read as stale authority', async () => {
  const { compareMigrations } = await loadPreflight();

  // M1 already applied; the manifest still lists it as knownPending.
  const remote = [...REMOTE_BASE, AD_DB_001];
  const result = compareMigrations(LOCAL_BASE, remote, AD_DB_002, fourPendingAuthority());

  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.ok(
    !result.blockers.some((b) => b.includes('stale authority')),
    'a fulfilled entry must never be reported as stale authority',
  );
  assert.deepEqual(result.fulfilled.map((f) => f.version), [AD_DB_001]);
  assert.equal(result.approvedPending.version, AD_DB_002, 'the next migration is selectable');
  assert.equal(result.approvedSelectedForExecution, 1);
});

test('SEQ 3. a FULFILLED migration can never be selected again', async () => {
  const { compareMigrations } = await loadPreflight();
  const { selectApprovedMigration } = await loadApplier();
  const remote = [...REMOTE_BASE, AD_DB_001];

  // Re-approving M1 after it is present selects NOTHING.
  const pre = compareMigrations(LOCAL_BASE, remote, AD_DB_001, fourPendingAuthority());
  assert.equal(pre.approvedSelectedForExecution, 0, 're-approval must select nothing');
  assert.equal(pre.approvedPending, undefined);
  assert.equal(pre.approvedAlreadyApplied, AD_DB_001);
  assert.ok(
    !pre.knownPending.map((m) => m.version).includes(AD_DB_001),
    'a fulfilled migration is no longer pending',
  );

  // And the applier, the only thing that mutates production, refuses outright.
  const decision = selectApprovedMigration({
    local: LOCAL_BASE,
    remote,
    approvedVersion: AD_DB_001,
    reconciliation: fourPendingAuthority(),
  });
  assert.equal(decision.selected, null);
  assert.ok(decision.blockers.some((b) => b.includes('already recorded on production')));
});

// ------------------------------------------- the tolerance is asymmetric (4-5)

test('SEQ 4. a HOLD migration that appears in production FAILS CLOSED', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [
      knownPending(AD_DB_001, 'HOLD'),
      ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    ],
  });
  const result = compareMigrations(LOCAL_BASE, [...REMOTE_BASE, AD_DB_001], AD_DB_002, auth);

  assert.equal(result.ok, false, 'a HOLD migration appearing remotely is never tolerated');
  assert.ok(
    result.blockers.some((b) => b.includes('unexplained production mutation')),
    result.blockers.join('\n'),
  );
  assert.equal(result.fulfilled.length, 0, 'HOLD is never fulfilled — it is a mutation we did not sanction');
});

test('SEQ 5. an EXCLUDE migration that appears in production FAILS CLOSED', async () => {
  const { compareMigrations } = await loadPreflight();
  const auth = fourPendingAuthority({
    knownPending: [
      knownPending(AD_DB_001, 'EXCLUDE'),
      ...[AD_DB_002, AD_DB_003, AD_DB_004].map((v) => knownPending(v)),
    ],
  });
  const result = compareMigrations(LOCAL_BASE, [...REMOTE_BASE, AD_DB_001], AD_DB_002, auth);

  assert.equal(result.ok, false, 'an EXCLUDE migration appearing remotely is never tolerated');
  assert.ok(result.blockers.some((b) => b.includes('unexplained production mutation')));
  assert.equal(result.fulfilled.length, 0);
});

// ------------------------------------- locked owner scope decisions (6, 7, 8, 9)

/** Asserts a real shipped-manifest version carries `disposition` and cannot be approved. */
async function assertNotSelectable(version, disposition, evidencePattern) {
  const { loadLedgerReconciliation } = await loadRecon();
  const { compareMigrations } = await loadPreflight();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);

  const entry = prod.knownPending.find((k) => k.localVersion === version);
  assert.ok(entry, `${version} must be declared in the shipped production authority`);
  assert.equal(entry.disposition, disposition, `${version} must be ${disposition}`);
  if (evidencePattern) assert.match(entry.evidence, evidencePattern);

  // And prove the gate actually refuses it, not just that the manifest says so.
  const local = localOf(version, AD_DB_002);
  const auth = {
    reconciled: [],
    remoteOnly: [],
    knownPending: [
      { ...entry, logicalName: entry.logicalName || `m_${version}` },
      knownPending(AD_DB_002),
    ],
  };
  const result = compareMigrations(local, [], version, auth);
  assert.equal(result.ok, false, `${version} must not be approvable`);
  assert.equal(result.approvedSelectedForExecution, 0);
  assert.ok(
    result.blockers.some((b) => b.includes(disposition)),
    `${version}: ${result.blockers.join('\n')}`,
  );
  return entry;
}

test('SEQ 6. the Signature Style closet-evidence migration is HOLD and cannot be selected', async () => {
  await assertNotSelectable(
    '20260915232402',
    'HOLD',
    /SIGNATURE_STYLE_FREE_CLOSET_EVIDENCE_MIGRATION=HOLD_AS_CURRENTLY_WRITTEN/,
  );

  // Its sibling is explicitly NOT covered by that decision and stays approvable.
  const { loadLedgerReconciliation } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);
  const sibling = prod.knownPending.find((k) => k.localVersion === '20260915214857');
  assert.ok(sibling, 'signature_style_free_entitlement must still be declared');
  assert.equal(
    sibling.disposition,
    'KNOWN_FUTURE_UNAPPLIED',
    'the entitlement migration is legitimate Build 34 work and must not be swept up in the hold',
  );
});

test('SEQ 7. every Build 34 wearable migration is EXCLUDE and cannot be selected', async () => {
  const WEARABLE = [
    '20260819125404', // wearable_pairings_sessions
    '20260819125700', // saved_scans_wearable_source
    '20260819144630', // widen_saved_scans_source_for_meta_wearable
    '20260819151224', // wearable_security_hardening
    '20260823170850', // reconcile_wearable_schema_with_staging
  ];
  for (const version of WEARABLE) {
    await assertNotSelectable(version, 'EXCLUDE', /WEARABLE_SCOPE=EXCLUDE_FROM_BUILD34_PRODUCTION/);
  }

  // No wearable-named migration may be left approvable anywhere in the authority.
  const { loadLedgerReconciliation } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);
  const strays = prod.knownPending.filter(
    (k) => /wearable/i.test(k.logicalName) && k.disposition !== 'EXCLUDE',
  );
  assert.deepEqual(strays.map((k) => k.localVersion), [], 'no wearable migration may remain selectable');
});

test('SEQ 8. the investor migration is EXCLUDE and cannot be selected', async () => {
  await assertNotSelectable('20260824175813', 'EXCLUDE', /INVESTOR_SCOPE=EXCLUDE_FROM_BUILD34_PRODUCTION/);

  const { loadLedgerReconciliation } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);
  const strays = prod.knownPending.filter(
    (k) => /investor/i.test(k.logicalName) && k.disposition !== 'EXCLUDE',
  );
  assert.deepEqual(strays.map((k) => k.localVersion), [], 'no investor migration may remain selectable');
});

test('SEQ 9. the non-canonical display-name duplicate cannot be selected', async () => {
  await assertNotSelectable('20260818000001', 'EXCLUDE', /NON-CANONICAL DUPLICATE/);
});

test('SEQ 10. the CANONICAL display-name identity remains valid when otherwise eligible', async () => {
  const { loadLedgerReconciliation } = await loadRecon();
  const { compareMigrations } = await loadPreflight();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);

  const canonical = prod.knownPending.find((k) => k.localVersion === '20260818141056');
  assert.ok(canonical, 'the canonical identity must still be declared');
  assert.equal(canonical.disposition, 'KNOWN_FUTURE_UNAPPLIED', 'the canonical copy stays approvable');

  // The registry names 20260818141056 as the canonical ledgerVersion, and names
  // 20260818000001 only as its sourceOriginalFilename.
  const registry = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entry = registry.entries.find((e) => e.ledgerVersion === '20260818141056');
  assert.ok(entry, 'the registry must carry the canonical ledger identity');
  assert.match(entry.sourceOriginalFilename, /20260818000001_/, 'the duplicate is only the original source file');
  assert.ok(
    !registry.entries.some((e) => e.ledgerVersion === '20260818000001'),
    'the non-canonical version must never be a ledger identity',
  );

  // And it really is selectable when approved.
  const local = localOf('20260818141056', AD_DB_002);
  const auth = {
    reconciled: [],
    remoteOnly: [],
    knownPending: [canonical, knownPending(AD_DB_002)],
  };
  const result = compareMigrations(local, [], '20260818141056', auth);
  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.equal(result.approvedPending.version, '20260818141056');
  assert.equal(result.approvedSelectedForExecution, 1);
});

test('SEQ 11. both reaction-count migrations remain HOLD and cannot be selected', async () => {
  for (const version of ['20260916203000', '20260916233708']) {
    const entry = await assertNotSelectable(version, 'HOLD', /one-argument|B34-FE-DR-001/);
    assert.ok(
      !/KNOWN_FUTURE_UNAPPLIED/.test(entry.disposition),
      `${version} must not be loosened to approvable merely because its backend effect is absent`,
    );
  }
});

// ------------------------------------------------------- reporting (FIX 7)

test('SEQ 12. the report separates HOLD and EXCLUDE from the approvable pending count', async () => {
  const { compareMigrations } = await loadPreflight();
  const local = localOf('20260101000000', ...ALL_FOUR);
  const auth = {
    reconciled: [],
    remoteOnly: [],
    knownPending: [
      knownPending(AD_DB_001),
      knownPending(AD_DB_002, 'HOLD'),
      knownPending(AD_DB_003, 'EXCLUDE'),
      knownPending(AD_DB_004),
    ],
  };
  const result = compareMigrations(local, REMOTE_BASE, AD_DB_001, auth);

  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.deepEqual(result.approvableKnownPending.map((m) => m.version), [AD_DB_001, AD_DB_004]);
  assert.deepEqual(result.hold.map((m) => m.version), [AD_DB_002]);
  assert.deepEqual(result.exclude.map((m) => m.version), [AD_DB_003]);
  assert.equal(result.knownPending.length, 4, 'the umbrella count still shows everything known');

  // The operator must be able to tell approvable work from parked work. Folding
  // HOLD and EXCLUDE into one number is exactly what this asserts against.
  assert.notEqual(
    result.approvableKnownPending.length,
    result.knownPending.length,
    'approvable and known must be distinct numbers',
  );
});

test('SEQ 13. the production preflight prints every required bucket', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs'), 'utf8');
  for (const label of [
    'RECONCILED',
    'KNOWN_PENDING',
    'FULFILLED',
    'HOLD',
    'EXCLUDE',
    'REMOTE_ONLY_ALLOWED',
    'UNEXPLAINED_REMOTE',
    'APPROVED_PENDING',
  ]) {
    assert.ok(src.includes(label), `the production preflight must report ${label}`);
  }
});

// ---------------------------------------- the shipped authority, after repair

test('SEQ 14. the shipped production authority reflects every locked scope decision', async () => {
  const { loadLedgerReconciliation } = await loadRecon();
  const prod = loadLedgerReconciliation(PRODUCTION_REF, MANIFEST);

  const disposition = (v) => prod.knownPending.find((k) => k.localVersion === v)?.disposition;

  assert.equal(disposition('20260915232402'), 'HOLD');
  assert.equal(disposition('20260915214857'), 'KNOWN_FUTURE_UNAPPLIED');
  for (const v of ['20260819125404', '20260819125700', '20260819144630', '20260819151224', '20260823170850']) {
    assert.equal(disposition(v), 'EXCLUDE', `${v} is wearable and must be EXCLUDE`);
  }
  assert.equal(disposition('20260824175813'), 'EXCLUDE');
  assert.equal(disposition('20260818000001'), 'EXCLUDE');
  assert.equal(disposition('20260818141056'), 'KNOWN_FUTURE_UNAPPLIED');
  assert.equal(disposition('20260916203000'), 'HOLD');
  assert.equal(disposition('20260916233708'), 'HOLD');

  // The four account-deletion migrations stay approvable, in order.
  for (const v of ALL_FOUR) {
    assert.equal(disposition(v), 'KNOWN_FUTURE_UNAPPLIED', `${v} must stay approvable`);
  }

  // Every declaration still carries its own evidence.
  for (const entry of prod.knownPending) {
    assert.ok(entry.evidence.trim().length > 40, `${entry.localVersion} needs evidence`);
  }
});
