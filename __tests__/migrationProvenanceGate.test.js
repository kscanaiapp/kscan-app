'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// B34-DEF-009: the migration provenance gate must catch an undeclared
// duplicate logical migration, a tampered aliased file, and a manifest
// pointing at the wrong hash -- and must pass on the real, current tree.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-migration-provenance.js');
const MANIFEST_PATH = path.join(REPO_ROOT, 'config', 'migration-provenance-manifest.json');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const CANONICAL_FILE = path.join(MIGRATIONS_DIR, '20260716035943_add_purchase_options_to_saved_scans.sql');

function runGate() {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT], { cwd: REPO_ROOT, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('B34-DEF-009: gate passes against the current, real migration tree', () => {
  assert.equal(runGate(), 0);
});

test('B34-DEF-009 negative control: an undeclared copy of an aliased migration fails the gate', (t) => {
  const duplicatePath = path.join(MIGRATIONS_DIR, '99990101000000_undeclared_duplicate_negctrl.sql');
  fs.copyFileSync(CANONICAL_FILE, duplicatePath);
  t.after(() => fs.rmSync(duplicatePath, { force: true }));

  assert.equal(runGate(), 1, 'gate must fail on an undeclared duplicate logical migration');
});

test('B34-DEF-009 negative control: tampering with a declared alias fails the gate', (t) => {
  const original = fs.readFileSync(CANONICAL_FILE, 'utf8');
  fs.writeFileSync(CANONICAL_FILE, `${original}\n-- tampered for negative control\n`);
  t.after(() => fs.writeFileSync(CANONICAL_FILE, original));

  assert.equal(runGate(), 1, 'gate must fail once a declared alias no longer matches its canonical hash');
});

test('B34-DEF-009 negative control: manifest pointing at the wrong hash fails the gate', (t) => {
  const original = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(original);
  manifest.logicalMigrations[0].canonicalNormalizedHash = '0'.repeat(64);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  t.after(() => fs.writeFileSync(MANIFEST_PATH, original));

  assert.equal(runGate(), 1, 'gate must fail when the manifest declares a hash the tree does not match');
});
