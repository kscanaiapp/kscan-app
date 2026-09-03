#!/usr/bin/env node
'use strict';

/**
 * Negative and positive controls for the migration-reconciliation authority
 * consulted by scripts/staging-deploy-preflight.mjs.
 *
 * WHY THIS EXISTS. compareMigrations() used to diff bare version strings, so
 * every migration this project had ever renumbered, consolidated or superseded
 * read as deployment drift and the staging gate was permanently red — which
 * meant the one genuinely unapplied migration
 * (20260902150000_vto_non_billable_attempt_release) was invisible inside 27
 * false positives. The gate now consults
 * config/migration-authority-manifest.json -> ledgerReconciliation.
 *
 * The whole point of these tests is that widening the gate did NOT weaken it:
 * a genuine missing migration, an undeclared remote-only version, a duplicate
 * version collision, a stale declaration and a production target must all still
 * fail. Pure unit tests — no network, no secrets, no database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PREFLIGHT = path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs');
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `file://${normalized}`;
  return `file:///${normalized}`;
}

const loadPreflight = () => import(pathToFileUrl(PREFLIGHT));

/** local migration inventory in the shape listLocalMigrationVersions returns */
function localOf(...versions) {
  return versions.map((version) => ({
    version,
    name: `m_${version}`,
    path: `supabase/migrations/${version}_m_${version}.sql`,
  }));
}

function reconciliation(...items) {
  return {
    reconciled: items.map((item) => ({
      logicalName: item.logicalName || `m_${item.localVersion}`,
      evidence: item.evidence || 'proven by direct object inspection on staging',
      remoteVersions: [],
      ...item,
    })),
    genuinelyUnapplied: [],
  };
}

// ---------------------------------------------------------------- positive

test('exact alias is accepted: a renumbered local version is not drift', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260101000000', '20260808103028'),
    ['20260101000000', '20260808121216'],
    '',
    reconciliation({
      localVersion: '20260808103028',
      remoteVersions: ['20260808121216'],
      classification: 'EXACT_CONTENT_RENUMBER',
    }),
  );
  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.deepEqual(result.remoteOnly, []);
  assert.deepEqual(result.localOnly, []);
  assert.equal(result.reconciledLocal.length, 1);
  assert.equal(result.reconciledRemote.length, 1);
});

test('equivalent approved alias is accepted', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260830060000'),
    ['20260830053104'],
    '',
    reconciliation({
      localVersion: '20260830060000',
      remoteVersions: ['20260830053104'],
      classification: 'EQUIVALENT_RENUMBER',
    }),
  );
  assert.equal(result.ok, true, result.blockers.join('\n'));
});

test('consolidated-in-remote accepts one local mapping to several ledger rows', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260830151500'),
    ['20260830212244', '20260830212316', '20260830212326'],
    '',
    reconciliation({
      localVersion: '20260830151500',
      remoteVersions: ['20260830212244', '20260830212316', '20260830212326'],
      classification: 'CONSOLIDATED_IN_REMOTE',
    }),
  );
  assert.equal(result.ok, true, result.blockers.join('\n'));
  assert.equal(result.reconciledRemote.length, 3);
});

test('superseded migration is accepted only when it is actually declared', async () => {
  const { compareMigrations } = await loadPreflight();
  const local = localOf('20260809120000');
  const remote = ['20260806153233'];

  const declared = compareMigrations(local, remote, '', reconciliation({
    localVersion: '20260809120000',
    remoteVersions: [],
    classification: 'SUPERSEDED_BY_LATER_MIGRATION',
  }));
  assert.equal(declared.ok, false, 'remote-only 20260806153233 is still undeclared');
  assert.deepEqual(declared.localOnly, [], 'the superseded local version is not pending');
  assert.deepEqual(declared.remoteOnly, ['20260806153233']);

  // Undeclared: the same migration must now read as genuinely pending.
  const undeclared = compareMigrations(local, remote, '', reconciliation());
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.localOnly.length, 1);
  assert.equal(undeclared.localOnly[0].version, '20260809120000');
});

// ---------------------------------------------------------------- negative

test('genuine missing migration still fails without an explicit approval', async () => {
  const { compareMigrations } = await loadPreflight();
  const withoutApproval = compareMigrations(
    localOf('20260101000000', '20260902150000'),
    ['20260101000000'],
    '',
    reconciliation(),
  );
  assert.equal(withoutApproval.ok, false);
  assert.equal(withoutApproval.localOnly[0].version, '20260902150000');
  assert.ok(
    withoutApproval.blockers.some((b) => b.includes('APPROVED_MIGRATION_VERSION=20260902150000')),
    withoutApproval.blockers.join('\n'),
  );

  const withApproval = compareMigrations(
    localOf('20260101000000', '20260902150000'),
    ['20260101000000'],
    '20260902150000',
    reconciliation(),
  );
  assert.equal(withApproval.ok, true, withApproval.blockers.join('\n'));
  assert.equal(withApproval.approvedPending.version, '20260902150000');
});

test('a genuinely missing migration cannot be laundered by approving a different version', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260902150000'),
    [],
    '20260101000000',
    reconciliation(),
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('does not match APPROVED_MIGRATION_VERSION')));
});

test('unknown mismatch fails: an undeclared remote-only version still blocks', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260101000000'),
    ['20260101000000', '20260999999999'],
    '',
    reconciliation(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.remoteOnly, ['20260999999999']);
  assert.ok(result.blockers.some((b) => b.includes('no declared reconciliation')));
});

test('duplicate version collision still fails', async () => {
  const { compareMigrations } = await loadPreflight();
  const local = [...localOf('20260101000000'), ...localOf('20260101000000')];
  const result = compareMigrations(local, ['20260101000000'], '', reconciliation());
  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicates, ['20260101000000']);
  assert.ok(result.blockers.some((b) => b.includes('duplicate local versions')));
});

test('stale authority fails: a declaration naming a local file that no longer exists', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260101000000'),
    ['20260101000000'],
    '',
    reconciliation({
      localVersion: '20260707070707',
      remoteVersions: [],
      classification: 'SUPERSEDED_BY_LATER_MIGRATION',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('stale authority')), result.blockers.join('\n'));
});

test('stale authority fails: a declaration claiming a remote version the ledger lacks', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260101000000', '20260202000000'),
    ['20260101000000'],
    '',
    reconciliation({
      localVersion: '20260202000000',
      remoteVersions: ['20260303000000'],
      classification: 'EQUIVALENT_RENUMBER',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.blockers.some((b) => b.includes('which the remote ledger does not contain')),
    result.blockers.join('\n'),
  );
});

test('two declarations may not claim the same remote ledger row', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260202000000', '20260203000000'),
    ['20260303000000'],
    '',
    reconciliation(
      { localVersion: '20260202000000', remoteVersions: ['20260303000000'], classification: 'EQUIVALENT_RENUMBER' },
      { localVersion: '20260203000000', remoteVersions: ['20260303000000'], classification: 'EQUIVALENT_RENUMBER' },
    ),
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('is already claimed by')), result.blockers.join('\n'));
});

test('an unknown classification fails rather than being treated as proven', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260202000000'),
    ['20260303000000'],
    '',
    reconciliation({
      localVersion: '20260202000000',
      remoteVersions: ['20260303000000'],
      classification: 'PROBABLY_FINE',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('unknown classification')));
});

test('a declaration without evidence fails', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260202000000'),
    ['20260303000000'],
    '',
    {
      reconciled: [{
        localVersion: '20260202000000',
        logicalName: 'x',
        remoteVersions: ['20260303000000'],
        classification: 'EQUIVALENT_RENUMBER',
        evidence: '   ',
      }],
    },
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('evidence is required')));
});

test('only SUPERSEDED_BY_LATER_MIGRATION may declare zero remote versions', async () => {
  const { compareMigrations } = await loadPreflight();
  const result = compareMigrations(
    localOf('20260202000000'),
    ['20260101000000'],
    '',
    reconciliation({
      localVersion: '20260202000000',
      remoteVersions: [],
      classification: 'EQUIVALENT_RENUMBER',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.includes('may declare no remoteVersions')));
});

// ------------------------------------------------- environment fail-closed

test('production ref still fails closed: it carries no reconciliation authority', async () => {
  const { loadLedgerReconciliation } = await loadPreflight();
  const prod = loadLedgerReconciliation(PRODUCTION_REF);
  assert.deepEqual(prod.reconciled, []);
  assert.deepEqual(prod.genuinelyUnapplied, []);

  const staging = loadLedgerReconciliation(STAGING_REF);
  assert.ok(staging.reconciled.length > 0, 'staging authority must be populated');
});

test('an unknown project ref resolves to an empty authority', async () => {
  const { loadLedgerReconciliation } = await loadPreflight();
  const unknown = loadLedgerReconciliation('zzzzzzzzzzzzzzzzzzzz');
  assert.deepEqual(unknown.reconciled, []);
});

test('a missing manifest resolves to an empty authority rather than throwing', async () => {
  const { loadLedgerReconciliation } = await loadPreflight();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-manifest-'));
  const result = loadLedgerReconciliation(STAGING_REF, path.join(dir, 'absent.json'));
  assert.deepEqual(result.reconciled, []);
});

test('an unparseable manifest is a hard error, never a silent pass', async () => {
  const { loadLedgerReconciliation } = await loadPreflight();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-manifest-'));
  const file = path.join(dir, 'migration-authority-manifest.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => loadLedgerReconciliation(STAGING_REF, file), /unparseable/);
});

// -------------------------------------------------------- real repo state

test('the committed staging authority is structurally sound against the real tree', async () => {
  const { loadLedgerReconciliation, validateReconciliation } = await loadPreflight();
  const { listLocalMigrationVersions } = await import(
    pathToFileUrl(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs'))
  );
  const local = listLocalMigrationVersions(path.join(ROOT, 'supabase', 'migrations'));
  const localSet = new Set(local.map((m) => m.version));
  const { reconciled } = loadLedgerReconciliation(STAGING_REF);

  // Every declared localVersion must still exist on disk. Remote-side staleness
  // is proven against the live ledger by the preflight itself; here we assert
  // the half that is checkable offline.
  const remoteSet = new Set(reconciled.flatMap((r) => r.remoteVersions));
  const { problems } = validateReconciliation(reconciled, localSet, remoteSet);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the one genuinely unapplied staging migration is declared as such, and is not reconciled away', async () => {
  const { loadLedgerReconciliation } = await loadPreflight();
  const { genuinelyUnapplied, reconciled } = loadLedgerReconciliation(STAGING_REF);

  assert.equal(genuinelyUnapplied.length, 1);
  assert.equal(genuinelyUnapplied[0].localVersion, '20260902150000');
  assert.equal(genuinelyUnapplied[0].logicalName, 'vto_non_billable_attempt_release');
  assert.equal(genuinelyUnapplied[0].classification, 'GENUINELY_UNAPPLIED');

  // It must NOT also appear as reconciled — that would hide it from the gate.
  assert.equal(
    reconciled.some((r) => r.localVersion === '20260902150000'),
    false,
    'a genuinely unapplied migration must never be declared reconciled',
  );

  // And the file it names must exist.
  assert.ok(
    fs.existsSync(
      path.join(ROOT, 'supabase', 'migrations', '20260902150000_vto_non_billable_attempt_release.sql'),
    ),
  );
});
