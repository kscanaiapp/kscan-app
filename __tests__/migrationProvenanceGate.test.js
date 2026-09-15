'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// B34-DEF-009: the migration provenance gate must catch an undeclared
// duplicate logical migration, a tampered aliased file, and a manifest
// pointing at the wrong hash -- and must pass on the real, current tree.
//
// The negative controls mutate a throwaway copy of what the gate reads, never
// the real checkout. scripts/run-all-tests.js runs every test file in one
// concurrent `node --test` pool, so a mutation of the shared tree -- even one
// restored in t.after() -- is visible to any file reading the same paths at
// that moment. It was: migrationReplayConflicts.test.js listed
// supabase/migrations, the duplicate below was removed before it was read, and
// "no migration references a schema-qualified object in a schema no migration
// creates" failed with ENOENT on push-event Project checks for PR #341
// (483a2743) and PR #417 (d48148b9).

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-migration-provenance.js');
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'migration-provenance-manifest.json');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const DUPLICATE_FILENAME = '99990101000000_undeclared_duplicate_negctrl.sql';

// Which of the two historical aliases exists depends on platform (Android
// carries the un-prefixed filename, iOS the ledger-prefixed one) -- resolve
// whichever is actually present in this checkout rather than hardcoding one.
const manifestForAliases = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const CANONICAL_FILENAME = manifestForAliases.logicalMigrations[0].aliases
  .map((alias) => alias.filename)
  .find((filename) => fs.existsSync(path.join(MIGRATIONS_DIR, filename)));
if (!CANONICAL_FILENAME) {
  throw new Error('No declared alias for add_purchase_options_to_saved_scans exists in this checkout.');
}

function runGate(gateScript = GATE_SCRIPT) {
  try {
    // The gate resolves the root it audits from its own location, so a copied
    // script audits the copy it sits in.
    execFileSync(process.execPath, [gateScript], { cwd: path.resolve(path.dirname(gateScript), '..'), stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Everything a negative control mutates, as it exists in the real checkout. */
function realTreeFingerprint() {
  return {
    migrations: fs.readdirSync(MIGRATIONS_DIR).sort(),
    canonicalAlias: sha256(path.join(MIGRATIONS_DIR, CANONICAL_FILENAME)),
    manifest: sha256(MANIFEST_PATH),
  };
}

const REAL_TREE_AT_LOAD = realTreeFingerprint();

/** A throwaway copy of exactly what the gate reads: its script, the manifest and every migration. */
function createGateFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-migration-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = {
    gateScript: path.join(root, 'scripts', 'check-migration-provenance.js'),
    manifestPath: path.join(root, 'config', 'migration-provenance-manifest.json'),
    migrationsDir: path.join(root, 'supabase', 'migrations'),
  };
  fs.mkdirSync(path.dirname(fixture.gateScript), { recursive: true });
  fs.mkdirSync(path.dirname(fixture.manifestPath), { recursive: true });
  fs.mkdirSync(fixture.migrationsDir, { recursive: true });
  fs.copyFileSync(GATE_SCRIPT, fixture.gateScript);
  fs.copyFileSync(MANIFEST_PATH, fixture.manifestPath);
  for (const entry of fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, entry.name), path.join(fixture.migrationsDir, entry.name));
    }
  }
  // The untouched copy must pass, so each red result below comes from its own
  // mutation rather than from an unfaithful copy.
  assert.equal(runGate(fixture.gateScript), 0, 'the untouched fixture copy must pass the gate');
  return fixture;
}

/** Checked while a negative control's mutation is still live. */
function assertRealTreeUntouched() {
  assert.deepEqual(
    realTreeFingerprint(),
    REAL_TREE_AT_LOAD,
    'a negative control must never mutate the real checkout -- other test files read it concurrently',
  );
}

test('B34-DEF-009: gate passes against the current, real migration tree', () => {
  assert.equal(runGate(), 0);
});

test('B34-DEF-009 negative control: an undeclared copy of an aliased migration fails the gate', (t) => {
  const fixture = createGateFixture(t);
  fs.copyFileSync(
    path.join(fixture.migrationsDir, CANONICAL_FILENAME),
    path.join(fixture.migrationsDir, DUPLICATE_FILENAME),
  );

  assert.equal(runGate(fixture.gateScript), 1, 'gate must fail on an undeclared duplicate logical migration');
  assertRealTreeUntouched();
});

test('B34-DEF-009 negative control: tampering with a declared alias fails the gate', (t) => {
  const fixture = createGateFixture(t);
  const aliasPath = path.join(fixture.migrationsDir, CANONICAL_FILENAME);
  const original = fs.readFileSync(aliasPath, 'utf8');
  fs.writeFileSync(aliasPath, `${original}\n-- tampered for negative control\n`);

  assert.equal(runGate(fixture.gateScript), 1, 'gate must fail once a declared alias no longer matches its canonical hash');
  assertRealTreeUntouched();
});

test('B34-DEF-009 negative control: manifest pointing at the wrong hash fails the gate', (t) => {
  const fixture = createGateFixture(t);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  manifest.logicalMigrations[0].canonicalNormalizedHash = '0'.repeat(64);
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2));

  assert.equal(runGate(fixture.gateScript), 1, 'gate must fail when the manifest declares a hash the tree does not match');
  assertRealTreeUntouched();
});
