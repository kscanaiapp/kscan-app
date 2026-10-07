#!/usr/bin/env node
'use strict';

/**
 * Build 35 migration-parity campaign controls.
 *
 * Staging legitimately carries FIVE known pending migrations (the October
 * Build 35 set that Production already holds). These tests prove the tooling can
 * hold five known pending migrations without ever treating that as permission to
 * apply them: deploy-only runs pass and execute nothing, one explicitly approved
 * version runs per invocation in the declared order, and everything the
 * authority does not explain still fails closed.
 *
 * Lettered controls A-L follow the owner's ruling. They run against the REAL
 * manifest and the REAL migration tree. The ledger is a frozen, read-only
 * capture of live Staging taken before the campaign. Pure: no network, no secrets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const OCTOBER = ['20261002010000', '20261003195716', '20261004184118', '20261004221500', '20261004231628'];
const OBSOLETE = '20260916234025';
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, '__tests__', 'fixtures', 'staging-ledger-2026-10-07.json'), 'utf8'));

const toUrl = (...parts) => `file:///${path.join(ROOT, ...parts).replace(/\\/g, '/')}`;
const loadPreflight = () => import(toUrl('scripts', 'staging-deploy-preflight.mjs'));
const loadApply = () => import(toUrl('scripts', 'apply-staging-migration.mjs'));
const loadHelpers = () => import(toUrl('scripts', 'lib', 'staging-helpers.mjs'));

async function world() {
  const [{ loadLedgerReconciliation }, { listLocalMigrationVersions }] = await Promise.all([loadPreflight(), loadHelpers()]);
  // The manifest loader resolves against cwd by default; pin it to this checkout.
  const manifest = path.join(ROOT, 'config', 'migration-authority-manifest.json');
  return {
    local: listLocalMigrationVersions(path.join(ROOT, 'supabase', 'migrations')),
    remote: [...fixture.staging.versions],
    reconciliation: loadLedgerReconciliation(STAGING_REF, manifest),
  };
}
const clone = (value) => structuredClone(value);
const withDisposition = (reconciliation, version, disposition) => {
  const next = clone(reconciliation);
  next.knownPending.find((k) => k.localVersion === version).disposition = disposition;
  return next;
};
const fakeLocal = (version) => ({ version, name: 'synthetic', path: `supabase/migrations/${version}_synthetic.sql` });

test('fixture sanity: Staging holds none of the five, Production holds all five', () => {
  for (const version of OCTOBER) {
    assert.ok(!fixture.staging.versions.includes(version), `staging must not hold ${version}`);
    assert.ok(fixture.productionOctober.versions.includes(version), `production must hold ${version}`);
  }
  assert.equal(new Set(fixture.staging.versions).size, fixture.staging.versions.length);
});

// ---- A / K. Deploy-only with five pending: PASS, nothing selected ----------

test('A+K: deploy-only with five known pending passes and selects NO migration', async () => {
  const { compareMigrations } = await loadPreflight();
  const { local, remote, reconciliation } = await world();
  const report = compareMigrations(local, remote, '', reconciliation);
  assert.equal(report.ok, true, report.blockers.join('; '));
  assert.equal(report.knownPendingCount, 5);
  assert.deepEqual(report.knownPending.map((m) => m.version), OCTOBER);
  assert.equal(report.selectedMigration, 'NONE');
  assert.equal(report.approvedSelectedForExecution, 0);
  assert.equal(report.approvedPending, undefined);
  assert.deepEqual(report.unexplainedLocal, []);
  assert.deepEqual(report.unexplainedRemote, []);
  assert.deepEqual(report.hold, []);
  assert.deepEqual(report.exclude, []);
});

test('K: the controlled-deploy workflow applies a migration only when a version is supplied AND approved', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'staging-controlled-deploy.yml'), 'utf8');
  assert.match(workflow, /if \[ -n "\$VER" \] && \[ "\$APPROVE" = "YES" \]; then\s+echo "apply=true"/);
  assert.match(workflow, /else\s+echo "apply=false"/);
  assert.match(workflow, /approved-single-migration:[\s\S]*?if: needs\.migration-plan\.outputs\.apply == 'true'/);
});

// ---- B. An unknown sixth pending migration -----------------------------------

test('B: an undeclared sixth pending migration fails, even with an approved known one', async () => {
  const { compareMigrations } = await loadPreflight();
  const { local, remote, reconciliation } = await world();
  const withSixth = [...local, fakeLocal('20269999999999')];
  for (const approved of ['', OCTOBER[0]]) {
    const report = compareMigrations(withSixth, remote, approved, reconciliation);
    assert.equal(report.ok, false, `approved=${approved || '(none)'}`);
    assert.ok(report.blockers.some((b) => b.includes('20269999999999')));
    assert.deepEqual(report.unexplainedLocal.map((m) => m.version), ['20269999999999']);
  }
});

// ---- C / L. One approved among five selects exactly one ----------------------

test('C: approving one of five selects exactly that version and leaves four untouched', async () => {
  const { compareMigrations } = await loadPreflight();
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  const report = compareMigrations(local, remote, OCTOBER[0], reconciliation);
  assert.equal(report.ok, true, report.blockers.join('; '));
  assert.equal(report.selectedMigration, OCTOBER[0]);
  assert.equal(report.approvedSelectedForExecution, 1);
  assert.equal(report.otherKnownPendingCount, 4);
  const selection = selectMigrationForApply({ version: OCTOBER[0], local, remote, reconciliation });
  assert.equal(selection.ok, true, selection.blockers.join('; '));
  assert.equal(selection.migration.version, OCTOBER[0]);
  assert.deepEqual(selection.report.knownPending.map((m) => m.version).filter((v) => v !== OCTOBER[0]), OCTOBER.slice(1));
});

test('L: five known pending never authorize batch application', async () => {
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  // No list, range, wildcard or "all" is a version.
  for (const bad of [OCTOBER.join(','), `${OCTOBER[0]} ${OCTOBER[1]}`, 'all', '*', `${OCTOBER[0]}-${OCTOBER[4]}`, '']) {
    const selection = selectMigrationForApply({ version: bad, local, remote, reconciliation });
    assert.equal(selection.ok, false, `"${bad}"`);
    assert.equal(selection.migration, null);
  }
  // And the script's own version contract is a single 12-14 digit token.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'), 'utf8');
  assert.match(source, /\/\^\\d\{12,14\}\$\/\.test\(version\)/);
  assert.doesNotMatch(source, /\.split\(','\)|MIGRATION_VERSIONS/);
});

test('L: no blanket migration command is executable from the apply script', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'), 'utf8');
  const executable = source.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executable, /'db',\s*'push'|'db',\s*'reset'|'migration',\s*'up'/);
  const calls = [...executable.matchAll(/runSupabase\(\[([^\]]*)\]/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.deepEqual(calls.sort(), [
    "'db', 'query', '--linked', '-f', migration.path",
    "'link', '--project-ref', STAGING_PROJECT_REF, '--yes'",
    "'migration', 'repair', version, '--status', 'applied', '--linked'",
  ].sort());
});

// ---- Order: the campaign cannot be reordered ---------------------------------

test('order: each October migration is refused until its predecessor is applied', async () => {
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  for (const version of OCTOBER.slice(1)) {
    const selection = selectMigrationForApply({ version, local, remote, reconciliation });
    assert.equal(selection.ok, false, version);
    assert.ok(selection.blockers.some((b) => /must be applied after .*campaign order/.test(b)), selection.blockers.join('; '));
  }
});

test('order: the campaign runs one version per step, in order, and ends fully aligned', async () => {
  const { compareMigrations } = await loadPreflight();
  const { selectMigrationForApply } = await loadApply();
  const { local, reconciliation } = await world();
  let remote = [...fixture.staging.versions];
  for (const [index, version] of OCTOBER.entries()) {
    const selection = selectMigrationForApply({ version, local, remote, reconciliation });
    assert.equal(selection.ok, true, `${version}: ${selection.blockers.join('; ')}`);
    assert.equal(selection.report.knownPendingCount, 5 - index);
    remote = [...remote, version]; // the ledger gains exactly this one version
    const after = compareMigrations(local, remote, version, reconciliation);
    assert.equal(after.ok, true, after.blockers.join('; '));
    assert.equal(after.knownPendingCount, 5 - index - 1);
    assert.equal(after.fulfilled.length, index + 1);
    assert.equal(after.selectedMigration, 'NONE');
  }
  // Fully converged: nothing pending, nothing unexplained, and every version refuses replay.
  const done = compareMigrations(local, remote, '', reconciliation);
  assert.equal(done.ok, true);
  assert.equal(done.knownPendingCount, 0);
  assert.deepEqual(done.localOnly, []);
  for (const version of OCTOBER) {
    assert.equal(selectMigrationForApply({ version, local, remote, reconciliation }).ok, false);
  }
});

// ---- D / E / F. HOLD, EXCLUDE and unknown approvals --------------------------

for (const disposition of ['HOLD', 'EXCLUDE']) {
  test(`${disposition === 'HOLD' ? 'D' : 'E'}: approving a ${disposition} migration fails`, async () => {
    const { selectMigrationForApply } = await loadApply();
    const { local, remote, reconciliation } = await world();
    const declared = withDisposition(reconciliation, OCTOBER[0], disposition);
    const selection = selectMigrationForApply({ version: OCTOBER[0], local, remote, reconciliation: declared });
    assert.equal(selection.ok, false);
    assert.ok(selection.blockers.some((b) => b.includes(`declared ${disposition}`)), selection.blockers.join('; '));
    // The other four are not rescued by the one that is blocked.
    assert.equal(selectMigrationForApply({ version: OCTOBER[1], local, remote, reconciliation: declared }).ok, false);
  });
}

test('F: approving an unknown or undeclared version fails', async () => {
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  assert.equal(selectMigrationForApply({ version: '20269999999998', local, remote, reconciliation }).ok, false);
  const undeclared = clone(reconciliation);
  undeclared.knownPending = undeclared.knownPending.filter((k) => k.localVersion !== OCTOBER[0]);
  const selection = selectMigrationForApply({ version: OCTOBER[0], local, remote, reconciliation: undeclared });
  assert.equal(selection.ok, false);
  assert.ok(selection.blockers.some((b) => /unexplained|no knownPending declaration|diverge/.test(b)), selection.blockers.join('; '));
});

// ---- G / H. Historical reconciliation ---------------------------------------

test('G: 20260916234025 is explained as obsolete remote-only and can never execute', async () => {
  const { compareMigrations } = await loadPreflight();
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  assert.ok(remote.includes(OBSOLETE));
  assert.ok(!local.some((m) => m.version === OBSOLETE), 'no governed file may carry the obsolete migration');
  const report = compareMigrations(local, remote, '', reconciliation);
  assert.deepEqual(report.remoteOnlyAllowed.map((r) => [r.version, r.classification]), [[OBSOLETE, 'OBSOLETE_REMOTE_ONLY']]);
  assert.ok(!report.remoteOnly.includes(OBSOLETE));
  const selection = selectMigrationForApply({ version: OBSOLETE, local, remote, reconciliation });
  assert.equal(selection.ok, false);
  assert.ok(selection.blockers.some((b) => b.includes('OBSOLETE_REMOTE_ONLY')), selection.blockers.join('; '));
  // Even if a file for it were smuggled into the tree, the declared row still refuses.
  const smuggled = selectMigrationForApply({ version: OBSOLETE, local: [...local, fakeLocal(OBSOLETE)], remote: remote.filter((v) => v !== OBSOLETE), reconciliation });
  assert.equal(smuggled.ok, false);
});

test('H: staging 20260916204355 reconciles to local 20260916203000 and the rest of the September set matches', async () => {
  const { compareMigrations } = await loadPreflight();
  const { local, remote, reconciliation } = await world();
  const report = compareMigrations(local, remote, '', reconciliation);
  const renumber = report.reconciledLocal.find((m) => m.version === '20260916203000');
  assert.ok(renumber, '20260916203000 must be reconciled, not pending');
  assert.equal(renumber.classification, 'EQUIVALENT_RENUMBER');
  assert.deepEqual(renumber.remoteVersions, ['20260916204355']);
  assert.ok(!report.remoteOnly.includes('20260916204355'));
  for (const version of ['20260916233708', '20260916235651', '20260917163000']) {
    assert.ok(local.some((m) => m.version === version), `${version} source is carried`);
    assert.ok(remote.includes(version), `${version} is in the Staging ledger under the same version`);
    assert.ok(!report.localOnly.some((m) => m.version === version), `${version} is not pending`);
  }
});

test('H: the September files are provenance only and are never selectable for execution', async () => {
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  for (const version of ['20260916203000', '20260916233708', '20260916235651', '20260917163000']) {
    assert.equal(selectMigrationForApply({ version, local, remote, reconciliation }).ok, false, version);
  }
});

// ---- I. Replay refusal --------------------------------------------------------

test('I: an already-applied version refuses replay', async () => {
  const { selectMigrationForApply } = await loadApply();
  const { local, remote, reconciliation } = await world();
  const applied = selectMigrationForApply({ version: '20260917163000', local, remote, reconciliation });
  assert.equal(applied.ok, false);
  assert.ok(applied.blockers.some((b) => /already recorded|already present|reconciled|not pending|neither pending/i.test(b)), applied.blockers.join('; '));
  const afterFirst = selectMigrationForApply({ version: OCTOBER[0], local, remote: [...remote, OCTOBER[0]], reconciliation });
  assert.equal(afterFirst.ok, false);
  assert.ok(afterFirst.blockers.some((b) => b.includes('already recorded')), afterFirst.blockers.join('; '));
});

// ---- J. Production can never be targeted ---------------------------------------

test('J: the Production project ref is refused by the target guard', async () => {
  const { assertStagingTarget } = await loadHelpers();
  const url = `https://${STAGING_REF}.supabase.co`;
  assert.throws(() => assertStagingTarget({ projectRef: PRODUCTION_REF, url, anonKey: 'x' }), /production/i);
  assert.throws(() => assertStagingTarget({ projectRef: STAGING_REF, url: `https://${PRODUCTION_REF}.supabase.co`, anonKey: 'x' }), /production/i);
  assert.doesNotThrow(() => assertStagingTarget({ projectRef: STAGING_REF, url, anonKey: 'sb_publishable_example' }));
});

test('J: the apply script exits before touching any CLI when aimed at Production', () => {
  const env = {
    SystemRoot: process.env.SystemRoot,
    SUPABASE_ACCESS_TOKEN: 'not-a-real-token',
    SUPABASE_STAGING_PROJECT_REF: PRODUCTION_REF,
    SUPABASE_STAGING_URL: `https://${PRODUCTION_REF}.supabase.co`,
    SUPABASE_STAGING_ANON_KEY: 'not-a-real-key',
    MIGRATION_VERSION: OCTOBER[0], APPROVE_STAGING_MIGRATION: 'YES',
  };
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'apply-staging-migration.mjs')], { env, cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /production/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /pre-apply/);
});

test('J: the production authority records all five October versions as applied and none as pending', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'migration-authority-manifest.json'), 'utf8'));
  const production = manifest.ledgerReconciliation.environments[PRODUCTION_REF];
  for (const version of OCTOBER) {
    const entry = production.reconciled.find((r) => r.localVersion === version);
    assert.ok(entry, `${version} must be reconciled in Production`);
    assert.equal(entry.classification, 'EXACT_VERSION_APPLIED');
    assert.deepEqual(entry.remoteVersions, [version]);
    assert.ok(!production.knownPending.some((k) => k.localVersion === version), `${version} must not stay declared pending`);
    assert.ok(fixture.productionOctober.versions.includes(version), `${version} is in the captured live Production ledger`);
  }
});

// ---- Library: applyAfter integrity ---------------------------------------------

test('applyAfter must name another real local migration, or the declaration is a blocker', async () => {
  const { compareMigrations } = await loadPreflight();
  const { local, remote, reconciliation } = await world();
  for (const bad of [['20269999999997'], [OCTOBER[0]], 'not-an-array', [42]]) {
    const next = clone(reconciliation);
    next.knownPending.find((k) => k.localVersion === OCTOBER[0]).applyAfter = bad;
    const report = compareMigrations(local, remote, '', next);
    assert.equal(report.ok, false, JSON.stringify(bad));
    assert.ok(report.blockers.some((b) => b.includes('applyAfter')), report.blockers.join('; '));
  }
});

// ---- Scanner policy: no global weakening, only version+hash scoped overrides ----

test('scanner: the strict findings for the October set are pinned, and no override is committed yet', async () => {
  const { scanSqlForProhibited } = await loadHelpers();
  const { reconciliation } = await world();
  const expected = {
    '20261002010000': ['DESTRUCTIVE_ALTER', 'TRUNCATE'],
    '20261003195716': ['TRUNCATE'],
    '20261004184118': [],
    '20261004221500': ['DESTRUCTIVE_ALTER'],
    '20261004231628': [],
  };
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const version of OCTOBER) {
    const file = fs.readdirSync(dir).find((f) => f.startsWith(`${version}_`));
    const findings = scanSqlForProhibited(fs.readFileSync(path.join(dir, file), 'utf8'), { allowDestructive: false });
    assert.deepEqual(findings.map((f) => f.id).sort(), expected[version], version);
  }
  // A scanner exception needs explicit owner approval; none is committed by this change.
  assert.deepEqual(reconciliation.knownPending.filter((k) => k.scannerOverrides !== undefined), []);
});

test('scanner: an override is scoped to a finding id and the exact SQL, and is logged when used', async () => {
  const { applyScannerPolicy, normalizedSha256 } = await loadApply();
  const sql = "select 1 where 'TRUNCATE' = 'TRUNCATE';\r\nalter table t drop constraint c;\r\n";
  const findings = [{ id: 'TRUNCATE', severity: 'BLOCK' }, { id: 'DESTRUCTIVE_ALTER', severity: 'BLOCK' }];
  const base = { findingId: 'TRUNCATE', sha256: normalizedSha256(sql), reason: 'privilege-name string literal, not a statement' };

  assert.deepEqual(applyScannerPolicy({ findings, declaration: undefined, sql }).blocked.map((f) => f.id), ['TRUNCATE', 'DESTRUCTIVE_ALTER']);

  const cleared = applyScannerPolicy({ findings, declaration: { scannerOverrides: [base] }, sql });
  assert.deepEqual(cleared.blocked.map((f) => f.id), ['DESTRUCTIVE_ALTER'], 'only the named finding is cleared');
  assert.deepEqual(cleared.overridden.map((o) => o.findingId), ['TRUNCATE']);

  // LF and CRLF checkouts agree; any edit to the SQL voids the override.
  assert.equal(applyScannerPolicy({ findings, declaration: { scannerOverrides: [base] }, sql: sql.replace(/\r\n/g, '\n') }).blocked.length, 1);
  assert.equal(applyScannerPolicy({ findings, declaration: { scannerOverrides: [base] }, sql: `${sql}-- edited\n` }).blocked.length, 2);
  // A reason is mandatory; a wrong id or wrong hash clears nothing.
  for (const override of [{ ...base, reason: '' }, { ...base, reason: undefined }, { ...base, findingId: 'DROP_SCHEMA' }, { ...base, sha256: 'f'.repeat(64) }]) {
    assert.equal(applyScannerPolicy({ findings, declaration: { scannerOverrides: [override] }, sql }).blocked.length, 2);
  }
  // WARN findings are not blocks and need no override.
  assert.equal(applyScannerPolicy({ findings: [{ id: 'DESTRUCTIVE_ALTER', severity: 'WARN' }], declaration: undefined, sql }).blocked.length, 0);
});

test('scanner: the scanner patterns themselves are untouched', () => {
  const constants = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staging-constants.mjs'), 'utf8');
  for (const id of ['DROP_DATABASE', 'DROP_SCHEMA', 'TRUNCATE', 'DB_RESET', 'MIGRATION_REPAIR', 'BLANKET_DB_PUSH']) {
    assert.match(constants, new RegExp(`id: '${id}'`));
  }
});

test('MIGRATION_FILE may only restate the governed migration file', () => {
  // A same-named copy OUTSIDE supabase/migrations must not run under an approved
  // version. The child gets no PATH, so even a broken guard cannot reach the CLI.
  const governed = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).find((f) => f.startsWith(`${OCTOBER[0]}_`));
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kscan-migration-file-'));
  try {
    const outside = path.join(temp, governed);
    fs.copyFileSync(path.join(ROOT, 'supabase', 'migrations', governed), outside);
    const env = {
      SystemRoot: process.env.SystemRoot,
      SUPABASE_ACCESS_TOKEN: 'not-a-real-token',
      SUPABASE_STAGING_PROJECT_REF: STAGING_REF,
      SUPABASE_STAGING_URL: `https://${STAGING_REF}.supabase.co`,
      SUPABASE_STAGING_ANON_KEY: 'not-a-real-key',
      MIGRATION_VERSION: OCTOBER[0], APPROVE_STAGING_MIGRATION: 'YES', MIGRATION_FILE: outside,
    };
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'apply-staging-migration.mjs')], { env, cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /MIGRATION_FILE is not the governed supabase\/migrations file/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
