// WL02-02: the two Watchlist migrations applied to staging under wall-clock
// ledger versions are declared as EQUIVALENT_RENUMBER aliases.
//
// WHY THIS EXISTS. Backend Readiness 02 had to apply two migrations to staging
// through the Supabase MCP surface, because the governed path
// (scripts/deploy-staging-function.mjs) needs the supabase CLI and
// SUPABASE_ACCESS_TOKEN, neither of which that session had. That surface
// assigns its OWN wall-clock ledger version, so:
//
//   source 20260909115726_watchlist_push_receipts.sql        -> staging 20260909171001
//   source 20260909170000_..._reconciliation.sql             -> staging 20260909171017
//
// Names match; versions do not. Left undeclared, scripts/staging-deploy-preflight.mjs
// compares bare version strings and reports BOTH sides wrongly: the two source
// versions as pending (not applied) and the two staging versions as drift. That
// is the same ledger-vs-filename split F-03 repaired in source, so it is
// recorded through the mechanism the repo already has for it —
// migration-authority-manifest.json's ledgerReconciliation — and never by
// renaming a source file or editing the remote ledger.
//
// These assertions pin the source-side half of that contract. The remote half
// (that staging really carries those two versions, and the preflight really
// stops misclassifying them) needs live ledger access and is proven in
// docs/watchlist-backend-readiness-02-staging-certification.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'migration-authority-manifest.json'), 'utf8'),
);
const env = manifest.ledgerReconciliation.environments[STAGING_REF];
const byLocal = new Map(env.reconciled.map((e) => [e.localVersion, e]));

const ALIASES = [
  {
    localVersion: '20260909115726',
    logicalName: 'watchlist_push_receipts',
    remoteVersion: '20260909171001',
    sourceFile: '20260909115726_watchlist_push_receipts.sql',
  },
  {
    localVersion: '20260909170000',
    logicalName: 'watchlist_f03_push_token_actor_isolation_reconciliation',
    remoteVersion: '20260909171017',
    sourceFile: '20260909170000_watchlist_f03_push_token_actor_isolation_reconciliation.sql',
  },
];

for (const alias of ALIASES) {
  test(`${alias.logicalName}: declared as a staging ledger alias`, () => {
    const entry = byLocal.get(alias.localVersion);
    assert.ok(entry, `no ledgerReconciliation entry for local version ${alias.localVersion}`);
    assert.equal(entry.logicalName, alias.logicalName);
    assert.deepEqual(entry.remoteVersions, [alias.remoteVersion]);
  });

  test(`${alias.logicalName}: classified EQUIVALENT_RENUMBER, not EXACT`, () => {
    // The executed statement is the source body with its comment header
    // omitted, so the SQL is semantically identical but not byte-identical.
    // Claiming EXACT_CONTENT_RENUMBER here would be an overclaim.
    const entry = byLocal.get(alias.localVersion);
    assert.equal(entry.classification, 'EQUIVALENT_RENUMBER');
    assert.ok(
      manifest.ledgerReconciliation.classifications.includes(entry.classification),
      'classification must be one of the manifest-declared vocabulary',
    );
  });

  test(`${alias.logicalName}: the source migration still exists and was NOT renamed`, () => {
    // The whole point of an alias is that the source file keeps its own
    // version. If this file were renamed to the staging ledger version the
    // alias would be unnecessary — and an applied identity would have been
    // rewritten, which the F-03 lane established this repo does not do.
    assert.ok(
      fs.existsSync(path.join(MIGRATIONS_DIR, alias.sourceFile)),
      `${alias.sourceFile} is missing — was the source migration renamed?`,
    );
    assert.ok(
      !fs.existsSync(path.join(MIGRATIONS_DIR, `${alias.remoteVersion}_${alias.logicalName}.sql`)),
      'a source file named for the STAGING ledger version exists; the alias should not have been resolved by renaming',
    );
  });

  test(`${alias.logicalName}: evidence records why the versions diverged`, () => {
    const entry = byLocal.get(alias.localVersion);
    assert.match(entry.evidence, /apply_migration/, 'evidence must name the surface that assigned the version');
    assert.match(entry.evidence, /2026-09-09/, 'evidence must carry the date it was confirmed');
  });
}

test('the two aliases do not collide with any other declared reconciliation', () => {
  const locals = env.reconciled.map((e) => e.localVersion);
  const remotes = env.reconciled.flatMap((e) => e.remoteVersions ?? []);
  assert.equal(new Set(locals).size, locals.length, 'duplicate localVersion in reconciled[]');
  assert.equal(new Set(remotes).size, remotes.length, 'duplicate remoteVersion in reconciled[]');
});

test('every reconciled localVersion still names a migration present in the tree', () => {
  // Guards the stale-authority case the preflight itself blocks on: an entry
  // whose local file was later removed would silently excuse a real gap.
  const present = new Set(
    fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).map((f) => f.split('_')[0]),
  );
  for (const entry of env.reconciled) {
    assert.ok(
      present.has(entry.localVersion),
      `reconciled entry ${entry.localVersion} (${entry.logicalName}) has no migration file`,
    );
  }
});

test('declaring an alias did not add an entries[] row (that gate requires version == filename)', () => {
  // verify-migration-authority.js check 5 hard-requires canonicalFilename's
  // version prefix to equal ledgerVersion, so entries[] structurally cannot
  // express a renumber. These aliases belong in ledgerReconciliation only.
  for (const alias of ALIASES) {
    assert.ok(
      !manifest.entries.some((e) => e.ledgerVersion === alias.remoteVersion),
      `${alias.remoteVersion} must not appear in entries[] — that gate cannot represent a renumber`,
    );
  }
});
