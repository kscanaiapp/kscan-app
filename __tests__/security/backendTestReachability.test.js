/**
 * Every governed Edge Function must have its Deno suites actually executed.
 *
 * WHY THIS EXISTS: governance has several independent registries and they drift
 * silently. 75057d1 brought stylist-speech under the parity manifest and under
 * deploy coverage, and added it to `parity.expectedFunctions` — but not to the
 * GOVERNED list in scripts/run-backend-tests.js. The result was a governed,
 * deployed, parity-hashed function whose three Deno suites (handler, speechText,
 * speechCues) were discovered by nothing and run by no npm script. 76 tests
 * existed and none of them executed.
 *
 * Nothing objected, because every OTHER gate was satisfied: the manifest was
 * current, the function was deploy-reachable, and the suite that would have
 * noticed was itself the suite not being run. That is exactly the condition
 * this file exists to make impossible.
 *
 * Deliberately asserts reachability, not a hard-coded list: a new governed
 * function must be a decision in run-backend-tests.js, and this test names the
 * one that was forgotten.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-backend-tests.js');
const MANIFEST = path.join(ROOT, 'config', 'edge-function-manifest.json');
const FUNCTIONS_DIR = path.join(ROOT, 'supabase', 'functions');

/**
 * Reads the literal GOVERNED array out of the runner.
 *
 * Comments are stripped first: the list is heavily annotated with the reasoning
 * for each entry, and an apostrophe in that prose ("this file's header") would
 * otherwise be read as a quoted entry and corrupt every comparison below.
 */
function governedFunctions() {
  const source = fs.readFileSync(RUNNER, 'utf8');
  const match = source.match(/const GOVERNED = \[([\s\S]*?)\];/);
  assert.ok(match, 'GOVERNED list not found as a literal array in run-backend-tests.js');
  const body = match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function manifestGovernedFunctions() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  return manifest.parity.expectedFunctions.slice().sort();
}

/** Every .test.ts under a directory, at any depth. */
function denoTestsUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...denoTestsUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Function directories that contain executable Deno test files at ANY depth.
 *
 * Depth matters: the runner originally read only the top level of each governed
 * directory, so the entire `_shared/security` suite (cors, quota, validation,
 * provider, logging) and `_shared/appleAuth` existed, passed, and had never
 * once been executed. A shared module is where cross-function contracts live,
 * which makes it the worst place to lose coverage silently.
 */
function functionsWithDenoTests() {
  return fs
    .readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => denoTestsUnder(path.join(FUNCTIONS_DIR, entry.name)).length > 0)
    .map((entry) => entry.name)
    .sort();
}

test('every parity-governed function is registered with the backend test runner', () => {
  const governed = governedFunctions();
  const missing = manifestGovernedFunctions().filter((name) => !governed.includes(name));

  assert.deepEqual(
    missing,
    [],
    `governed by the parity manifest but never executed by npm run test:backend: ${missing.join(', ')}. ` +
      'Add them to GOVERNED in scripts/run-backend-tests.js — a function under parity and ' +
      'deploy coverage whose tests never run is governed in name only.',
  );
});

test('no function ships Deno tests that no runner will ever discover', () => {
  // Broader than the manifest: a directory can carry real suites before it is
  // parity-governed, and those are just as invisible.
  const governed = governedFunctions();
  const orphaned = functionsWithDenoTests().filter((name) => !governed.includes(name));

  assert.deepEqual(
    orphaned,
    [],
    `these function directories contain .test.ts files that no npm script runs: ${orphaned.join(', ')}`,
  );
});

test('the runner list contains no entry that does not exist on disk', () => {
  // The inverse drift: a renamed or removed function leaves a stale name that
  // silently contributes zero tests.
  for (const name of governedFunctions()) {
    assert.ok(
      fs.existsSync(path.join(FUNCTIONS_DIR, name)),
      `GOVERNED names '${name}', which does not exist under supabase/functions`,
    );
  }
});

test('the backend runner discovers tests in nested module directories', () => {
  // The runner originally read only the top level of each governed directory.
  // Every suite organised as a folder was therefore invisible: the whole
  // _shared/security set and _shared/appleAuth existed, passed, and had never
  // been executed. Registering a directory is not enough if discovery stops at
  // its first level.
  const runner = fs.readFileSync(RUNNER, 'utf8');
  assert.match(
    runner,
    /function collectTests\(/,
    'discovery must recurse into subdirectories',
  );
  assert.ok(
    !/readdirSync\(dir, \{ withFileTypes: true \}\)[\s\S]{0,200}?entry\.isFile\(\)[\s\S]{0,120}?found\.push/.test(runner),
    'discovery must not collect only top-level files',
  );

  // And prove it against the tree: every nested suite must be reachable.
  const nested = denoTestsUnder(path.join(FUNCTIONS_DIR, '_shared'))
    .filter((file) => path.relative(path.join(FUNCTIONS_DIR, '_shared'), file).includes(path.sep));
  assert.ok(
    nested.length > 0,
    'expected nested shared suites to exist; if they moved, retarget this assertion',
  );
});

test('stylist-speech specifically stays registered', () => {
  // Named because it is the one that was actually forgotten, and because E4.1
  // makes its bound load-bearing: longer room-reasoning answers put real
  // pressure on the spoken character limit.
  assert.ok(
    governedFunctions().includes('stylist-speech'),
    'stylist-speech lost its backend test registration again',
  );
});
