'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runContractControls, contractPassed } = require('./runContract');

const LAB_ROOT = path.join(__dirname, '..');

/**
 * NETWORK SAFETY (spec section 29): contract/offline modes must make no
 * network calls, no Supabase writes, and incur no provider calls. This is
 * checked two ways: (1) contract mode runs and passes purely from local
 * computation (no mocked network needed - if it required one, the test
 * setup itself would prove a violation), and (2) a static source scan
 * confirms no lab module outside l1/ (which only shells out to a local
 * `deno` binary with no network permission flag) references a network API.
 */

test('NETWORK SAFETY: contract mode runs and passes with zero network setup', () => {
  const controls = runContractControls();
  assert.equal(contractPassed(controls), true, JSON.stringify(controls.filter((c) => c.verdict !== 'PASS')));
});

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'generated') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listJsFiles(full, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

test('NETWORK SAFETY: no lab module (outside the Deno subprocess wrapper) calls fetch/http/https/net directly', () => {
  const files = listJsFiles(LAB_ROOT);
  const offenders = [];
  for (const file of files) {
    // l1/runL1.js intentionally spawns a local `deno` subprocess (no
    // network permission flag is ever passed to it) - that is the one
    // permitted "process boundary" in the lab and is checked separately.
    if (file.endsWith(`${path.sep}l1${path.sep}runL1.js`)) continue;
    // runContract.js's l1_harness_source_has_no_network_call control
    // contains the literal detection strings ('fetch(', 'Deno.connect') as
    // part of its OWN regex - that is this same check running one layer
    // up, not a real network call site, so it is excluded from this scan.
    if (file.endsWith(`${path.sep}contract${path.sep}runContract.js`)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\bfetch\s*\(/.test(source) || /require\(['"]https?['"]\)/.test(source) || /require\(['"]net['"]\)/.test(source)) {
      offenders.push(path.relative(LAB_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('NETWORK SAFETY: l1 subprocess wrapper never passes a network permission flag to deno', () => {
  const source = fs.readFileSync(path.join(LAB_ROOT, 'l1', 'runL1.js'), 'utf8');
  assert.doesNotMatch(source, /--allow-net/);
  assert.doesNotMatch(source, /--allow-all/);
  assert.doesNotMatch(source, /-A\b/);
});

test('NETWORK SAFETY: no lab module references Supabase client construction (no Supabase writes possible from this tree)', () => {
  const files = listJsFiles(LAB_ROOT);
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (/createClient\s*\(/.test(source) || /@supabase\/supabase-js/.test(source)) {
      offenders.push(path.relative(LAB_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});
