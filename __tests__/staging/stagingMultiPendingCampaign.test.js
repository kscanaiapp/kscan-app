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

// ---- Scanner overrides: the owner-approved, hash-bound exceptions ---------------

const STRICT_FINDINGS = {
  '20261002010000': ['DESTRUCTIVE_ALTER', 'TRUNCATE'],
  '20261003195716': ['TRUNCATE'],
  '20261004184118': [],
  '20261004221500': ['DESTRUCTIVE_ALTER'],
  '20261004231628': [],
};
// Exactly what the owner approved (2026-10-07). Nothing else may carry an override.
const APPROVED_OVERRIDES = {
  '20261002010000': ['DESTRUCTIVE_ALTER', 'TRUNCATE'],
  '20261003195716': ['TRUNCATE'],
  '20261004221500': ['DESTRUCTIVE_ALTER'],
};
const sqlOf = (version) => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  return fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(`${version}_`))), 'utf8');
};
const ids = (findings) => findings.map((f) => f.id).sort();

test('scanner: the strict findings for the October set are pinned', async () => {
  const { scanSqlForProhibited } = await loadHelpers();
  for (const version of OCTOBER) {
    assert.deepEqual(ids(scanSqlForProhibited(sqlOf(version), { allowDestructive: false })), STRICT_FINDINGS[version], version);
  }
});

test('scanner: the committed overrides are exactly the owner-approved set, each bound to its real SQL', async () => {
  const { normalizedSha256 } = await loadApply();
  const { reconciliation } = await world();
  const carrying = reconciliation.knownPending.filter((k) => k.scannerOverrides !== undefined);
  assert.deepEqual(carrying.map((k) => k.localVersion).sort(), Object.keys(APPROVED_OVERRIDES));
  for (const declaration of carrying) {
    const { localVersion } = declaration;
    assert.deepEqual(declaration.scannerOverrides.map((o) => o.findingId).sort(), APPROVED_OVERRIDES[localVersion], localVersion);
    for (const override of declaration.scannerOverrides) {
      assert.match(override.sha256, /^[0-9a-f]{64}$/, `${localVersion}/${override.findingId} must be hash-bound`);
      assert.equal(override.sha256, normalizedSha256(sqlOf(localVersion)), `${localVersion}/${override.findingId} hash must equal the real SQL`);
      assert.match(override.reason, /Owner-approved 2026-10-07/);
      assert.ok(['TRUNCATE', 'DESTRUCTIVE_ALTER'].includes(override.findingId));
    }
  }
  // The pre-existing per-invocation switch is not how any of this is cleared.
  for (const version of ['20261004184118', '20261004231628']) {
    assert.equal(reconciliation.knownPending.find((k) => k.localVersion === version).scannerOverrides, undefined, version);
  }
});

// A. exact version + exact finding + exact source hash -> allowed
test('scanner A: the approved version, finding and source hash are allowed, and the use is logged', async () => {
  const { evaluateScannerForMigration, normalizedSha256 } = await loadApply();
  const { reconciliation } = await world();
  for (const version of Object.keys(APPROVED_OVERRIDES)) {
    const result = evaluateScannerForMigration({ version, sql: sqlOf(version), reconciliation, allowDestructive: false });
    assert.deepEqual(result.blocked, [], version);
    assert.deepEqual(ids(result.overridden.map((o) => ({ id: o.findingId }))), APPROVED_OVERRIDES[version], version);
    assert.ok(result.overridden.every((o) => o.sha256 === normalizedSha256(sqlOf(version)) && o.reason.length > 40));
  }
});

// B. same version, changed source hash -> FAIL
test('scanner B: the same version with a changed source hash is blocked', async () => {
  const { evaluateScannerForMigration } = await loadApply();
  const { reconciliation } = await world();
  for (const version of Object.keys(APPROVED_OVERRIDES)) {
    const original = sqlOf(version);
    for (const edited of [`${original}\n-- edited\n`, original.replace(/[a-z]/, (c) => c.toUpperCase()), original.slice(0, -1)]) {
      assert.notEqual(edited, original);
      const result = evaluateScannerForMigration({ version, sql: edited, reconciliation, allowDestructive: false });
      assert.deepEqual(ids(result.blocked), STRICT_FINDINGS[version], `${version} must stay blocked when its SQL changes`);
      assert.deepEqual(result.overridden, []);
    }
  }
});

// C. same version with an additional destructive finding -> FAIL
test('scanner C: an additional destructive finding is blocked even for an approved version', async () => {
  const { evaluateScannerForMigration, applyScannerPolicy } = await loadApply();
  const { reconciliation } = await world();
  const version = '20261004221500';
  // (i) new destructive SQL changes the hash, so nothing is cleared.
  for (const extra of ['\ndrop table public.user_closet_items;\n', '\ntruncate public.user_closet_items;\n', '\ndrop schema public cascade;\n']) {
    const result = evaluateScannerForMigration({ version, sql: sqlOf(version) + extra, reconciliation, allowDestructive: false });
    assert.ok(result.blocked.length >= 2, `${JSON.stringify(extra)} -> ${ids(result.blocked)}`);
    assert.deepEqual(result.overridden, []);
  }
  // (ii) the SQL is byte-identical but the scanner reports a finding the override does not name.
  const declaration = reconciliation.knownPending.find((k) => k.localVersion === version);
  const withExtra = applyScannerPolicy({
    findings: [{ id: 'DESTRUCTIVE_ALTER', severity: 'BLOCK' }, { id: 'DROP_TABLE', severity: 'BLOCK' }, { id: 'DROP_SCHEMA', severity: 'BLOCK' }],
    declaration, sql: sqlOf(version),
  });
  assert.deepEqual(ids(withExtra.blocked), ['DROP_SCHEMA', 'DROP_TABLE']);
  assert.deepEqual(withExtra.overridden.map((o) => o.findingId), ['DESTRUCTIVE_ALTER']);
  // (iii) an override for one finding never clears a different finding in the same file.
  const onlyTruncate = structuredClone(reconciliation);
  onlyTruncate.knownPending.find((k) => k.localVersion === '20261002010000').scannerOverrides =
    onlyTruncate.knownPending.find((k) => k.localVersion === '20261002010000').scannerOverrides.filter((o) => o.findingId === 'TRUNCATE');
  const partial = evaluateScannerForMigration({ version: '20261002010000', sql: sqlOf('20261002010000'), reconciliation: onlyTruncate, allowDestructive: false });
  assert.deepEqual(ids(partial.blocked), ['DESTRUCTIVE_ALTER']);
});

// D. a different migration using the same pattern -> FAIL
test('scanner D: a different migration with the same pattern is not covered', async () => {
  const { evaluateScannerForMigration } = await loadApply();
  const { reconciliation } = await world();
  // (i) a never-approved version carrying another version's pattern.
  assert.deepEqual(ids(evaluateScannerForMigration({ version: '20261004231628', sql: sqlOf('20261004221500'), reconciliation }).blocked), ['DESTRUCTIVE_ALTER']);
  // (ii) an approved version cannot launder another file with the same finding.
  assert.deepEqual(ids(evaluateScannerForMigration({ version: '20261002010000', sql: sqlOf('20261003195716'), reconciliation }).blocked), ['TRUNCATE']);
  assert.deepEqual(ids(evaluateScannerForMigration({ version: '20261003195716', sql: sqlOf('20261002010000'), reconciliation }).blocked), ['DESTRUCTIVE_ALTER', 'TRUNCATE']);
  // (iii) identical bytes under another version: the version binding itself must hold.
  assert.deepEqual(ids(evaluateScannerForMigration({ version: '20269999999999', sql: sqlOf('20261004221500'), reconciliation }).blocked), ['DESTRUCTIVE_ALTER']);
  // (iv) renaming the declared version voids the override for the real version.
  const renamed = structuredClone(reconciliation);
  renamed.knownPending.find((k) => k.localVersion === '20261004221500').localVersion = '20269999999998';
  assert.deepEqual(ids(evaluateScannerForMigration({ version: '20261004221500', sql: sqlOf('20261004221500'), reconciliation: renamed }).blocked), ['DESTRUCTIVE_ALTER']);
});

// E / F. versions with no finding need no override
for (const [label, version] of [['E', '20261004184118'], ['F', '20261004231628']]) {
  test(`scanner ${label}: ${version} needs no override`, async () => {
    const { evaluateScannerForMigration } = await loadApply();
    const { reconciliation } = await world();
    const result = evaluateScannerForMigration({ version, sql: sqlOf(version), reconciliation, allowDestructive: false });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.blocked, []);
    assert.deepEqual(result.overridden, []);
    assert.equal(reconciliation.knownPending.find((k) => k.localVersion === version).scannerOverrides, undefined);
  });
}

// G. a global destructive bypass remains impossible
test('scanner G: no global switch clears a blocked pattern', async () => {
  const { evaluateScannerForMigration, applyScannerPolicy } = await loadApply();
  const { scanSqlForProhibited } = await loadHelpers();
  const { reconciliation } = await world();
  const stripped = structuredClone(reconciliation);
  for (const declaration of stripped.knownPending) delete declaration.scannerOverrides;
  // The pre-existing per-invocation flag downgrades DESTRUCTIVE_* only; it cannot clear TRUNCATE.
  for (const version of ['20261002010000', '20261003195716']) {
    const result = evaluateScannerForMigration({ version, sql: sqlOf(version), reconciliation: stripped, allowDestructive: true });
    assert.ok(ids(result.blocked).includes('TRUNCATE'), `${version}: allowDestructive must not clear TRUNCATE`);
  }
  for (const pattern of ['DROP DATABASE x', 'DROP SCHEMA x', 'TRUNCATE t', 'db reset', 'migration repair', 'db push']) {
    assert.ok(scanSqlForProhibited(pattern, { allowDestructive: true }).some((f) => f.severity === 'BLOCK'), pattern);
  }
  // Overrides are never wildcard: no hash, a malformed hash or an empty reason clears nothing.
  const sql = sqlOf('20261003195716');
  const finding = [{ id: 'TRUNCATE', severity: 'BLOCK' }];
  for (const override of [{ findingId: 'TRUNCATE', reason: 'x'.repeat(50) }, { findingId: 'TRUNCATE', sha256: '*', reason: 'x'.repeat(50) },
    { findingId: 'TRUNCATE', sha256: '', reason: 'x'.repeat(50) }, { findingId: 'TRUNCATE', sha256: 'A'.repeat(64), reason: 'x'.repeat(50) }, { sha256: 'a'.repeat(64), reason: 'x' }]) {
    assert.equal(applyScannerPolicy({ findings: finding, declaration: { scannerOverrides: [override] }, sql }).blocked.length, 1, JSON.stringify(override).slice(0, 60));
  }
  // The governed workflow never sets the per-invocation flag, and the apply script reads no other bypass.
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'staging-controlled-deploy.yml'), 'utf8');
  assert.doesNotMatch(workflow, /ALLOW_DESTRUCTIVE|ALLOW_[A-Z_]*MIGRATION|SKIP_[A-Z_]*SCAN/);
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'), 'utf8');
  const envNames = [...new Set([...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(envNames, ['ALLOW_DESTRUCTIVE_MIGRATION', 'APPROVE_STAGING_MIGRATION', 'MIGRATION_FILE', 'MIGRATION_VERSION']);
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

test('runner atomicity: no October migration commits internally or uses a non-transactional statement', () => {
  // The runner executes the whole file as ONE transaction (measured with SET LOCAL
  // against Staging). That conclusion only holds while a file contains no internal
  // COMMIT/ROLLBACK/SAVEPOINT and no statement that cannot run inside a transaction.
  const control = /^\s*(?:begin(?:\s+(?:work|transaction))?|start\s+transaction)\s*;|^\s*(?:commit|rollback)\b|^\s*(?:savepoint|release\s+savepoint)\b/im;
  const nonTransactional = /\b(?:create\s+(?:unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|reindex\s+.*concurrently|vacuum|alter\s+system|create\s+database|drop\s+database|alter\s+type\s+\S+\s+add\s+value)\b/i;
  for (const version of OCTOBER) {
    const sql = sqlOf(version);
    assert.doesNotMatch(sql, control, `${version} must not contain transaction control`);
    assert.doesNotMatch(sql, nonTransactional, `${version} must not contain a non-transactional statement`);
  }
  // Negative control: the detector does flag what it claims to.
  for (const bad of ['begin;\nselect 1;', 'select 1;\ncommit;', 'rollback;', 'savepoint a;', 'create index concurrently i on t(a);', 'vacuum t;']) {
    assert.ok(control.test(bad) || nonTransactional.test(bad), bad);
  }
  // And plpgsql BEGIN ... END blocks are not mistaken for transaction control.
  assert.doesNotMatch('create function f() returns int as $$\nbegin\n  return 1;\nend;\n$$ language plpgsql;', control);
  // The SQL still runs through the single-file runner and the ledger is a separate, explicit step.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'), 'utf8');
  assert.match(source, /'db', 'query', '--linked', '-f', migration\.path/);
  assert.match(source, /'migration', 'repair', version, '--status', 'applied', '--linked'/);
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
