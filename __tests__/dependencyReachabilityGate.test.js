'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// B34-DEF-014: the reachability gate must fail on an unapproved critical/high
// finding and on reachability-path drift, and pass on the real, current tree.
// These are the exact two negative controls run manually during the patch;
// committed here so they run in CI, not just once by hand.

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-dependency-reachability.js');
const EXCEPTIONS_PATH = path.join(REPO_ROOT, 'config', 'dependency-reachability-exceptions.json');

function runGate() {
  try {
    execFileSync(process.execPath, [GATE_SCRIPT], { cwd: REPO_ROOT, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('B34-DEF-014: gate passes against the current, real dependency tree', () => {
  assert.equal(runGate(), 0);
});

test('B34-DEF-014 negative control: removing an approved exception fails the gate', (t) => {
  const original = fs.readFileSync(EXCEPTIONS_PATH, 'utf8');
  const manifest = JSON.parse(original);
  manifest.exceptions = manifest.exceptions.filter((entry) => !entry.packages.includes('metro'));
  fs.writeFileSync(EXCEPTIONS_PATH, JSON.stringify(manifest, null, 2));
  t.after(() => fs.writeFileSync(EXCEPTIONS_PATH, original));

  assert.equal(runGate(), 1, 'gate must fail once metro has no approved exception');
});

test('B34-DEF-014 negative control: an excepted package imported by app source fails the gate', (t) => {
  const scratchDir = path.join(REPO_ROOT, 'services');
  const scratchFile = path.join(scratchDir, `__negctrl_${path.basename(os.tmpdir())}.ts`);
  fs.writeFileSync(scratchFile, "import { customAlphabet } from 'nanoid';\n");
  t.after(() => fs.rmSync(scratchFile, { force: true }));

  assert.equal(runGate(), 1, 'gate must fail once an excepted build-only package is imported by app source');
});
