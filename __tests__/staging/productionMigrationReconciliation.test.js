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

test('a knownPending declaration for a version the ledger already holds is a blocker', async () => {
  const { compareMigrations } = await loadPreflight();
  const remote = [...REMOTE_BASE, AD_DB_001];
  const result = compareMigrations(LOCAL_BASE, remote, '', fourPendingAuthority());

  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => b.includes('already contains this version')),
    result.blockers.join('\n'),
  );
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
