'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// B34-DEF-009: the migration provenance gate must catch an undeclared
// duplicate logical migration, a tampered aliased file, and a manifest
// pointing at the wrong hash -- and must pass on the real, current tree.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-migration-provenance.js');
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'migration-provenance-manifest.json');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

// Which of the two historical aliases exists depends on platform (Android
// carries the un-prefixed filename, iOS the ledger-prefixed one) -- resolve
// whichever is actually present in this checkout rather than hardcoding one.
const manifestForAliases = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const presentAlias = manifestForAliases.logicalMigrations[0].aliases
  .map((alias) => path.join(MIGRATIONS_DIR, alias.filename))
  .find((absolutePath) => fs.existsSync(absolutePath));
if (!presentAlias) {
  throw new Error('No declared alias for add_purchase_options_to_saved_scans exists in this checkout.');
}
const CANONICAL_FILE = presentAlias;

function runGate(root = REPO_ROOT) {
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'check-migration-provenance.js')],
      { cwd: root, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

/** Negatives must NEVER modify the real migration tree; full CI runs tests concurrently. */
function isolatedMigrationFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-migration-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const migrationDir = path.join(root, 'supabase', 'migrations');
  const scriptDir = path.join(root, 'scripts');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.cpSync(MIGRATIONS_DIR, migrationDir, { recursive: true });
  fs.copyFileSync(GATE_SCRIPT, path.join(scriptDir, 'check-migration-provenance.js'));
  fs.copyFileSync(MANIFEST_PATH, path.join(configDir, 'migration-provenance-manifest.json'));
  return {
    root,
    migrationDir,
    manifestPath: path.join(configDir, 'migration-provenance-manifest.json'),
    canonical: path.join(migrationDir, path.basename(CANONICAL_FILE)),
  };
}

test('B34-DEF-009: gate passes against the current, real migration tree', () => {
  assert.equal(runGate(), 0);
});

test('B34-DEF-009 negative control: an undeclared copy of an aliased migration fails the gate', (t) => {
  const fixture = isolatedMigrationFixture(t);
  const duplicatePath = path.join(fixture.migrationDir, '99990101000000_undeclared_duplicate_negctrl.sql');
  fs.copyFileSync(fixture.canonical, duplicatePath);
  assert.equal(runGate(fixture.root), 1, 'gate must fail on an undeclared duplicate logical migration');
  assert.equal(fs.existsSync(path.join(MIGRATIONS_DIR, path.basename(duplicatePath))), false,
    'negative control must never create an untracked file in the real migration directory');
});

test('B34-DEF-009 negative control: tampering with a declared alias fails the gate', (t) => {
  const fixture = isolatedMigrationFixture(t);
  fs.appendFileSync(fixture.canonical, '\n-- tampered for negative control\n');
  assert.equal(runGate(fixture.root), 1, 'gate must fail once a declared alias no longer matches its canonical hash');
  assert.notEqual(fs.readFileSync(fixture.canonical, 'utf8'), fs.readFileSync(CANONICAL_FILE, 'utf8'));
});

test('B34-DEF-009 negative control: manifest pointing at the wrong hash fails the gate', (t) => {
  const fixture = isolatedMigrationFixture(t);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  manifest.logicalMigrations[0].canonicalNormalizedHash = '0'.repeat(64);
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2));
  assert.equal(runGate(fixture.root), 1, 'gate must fail when the manifest declares a hash the tree does not match');
});
