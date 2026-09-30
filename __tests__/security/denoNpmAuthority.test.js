'use strict';

/**
 * Guards the single npm-dependency authority for governed Deno commands.
 *
 *   npm ci -> package-lock.json exact graph -> local node_modules
 *          -> governed Deno consumes that graph
 *
 * WHY THIS EXISTS. deno.json used to say `"nodeModulesDir": "auto"`. Under
 * Deno 2 that lets Deno install and resolve npm packages from the registry
 * itself at startup - the whole package.json tree, not just what the Edge
 * Functions import - producing a second, moving dependency graph beside the
 * one `npm ci` installs from package-lock.json. A fresh npm publication then
 * broke CI with no change to package.json or package-lock.json: Deno resolved
 * the newest react-navigation release, which requires
 * `@react-navigation/elements@^2.9.44`, and Deno's default minimum dependency
 * age refused to install a 2.9.44 that was under a day old. The age policy was
 * working as designed; the resolution authority was the defect.
 *
 * `manual` makes Deno use the existing node_modules and never modify it.
 *
 * These are static configuration assertions on purpose. They do not depend on
 * npm registry contents or publication timing, so they cannot flake, and they
 * fail when someone moves the authority back to a Deno-managed graph.
 *
 * NOT covered here, deliberately: loosening the age policy is also asserted
 * against (a config key or CLI flag on any governed surface fails), because
 * the supported fix for "Deno is too strict" is to stop Deno resolving a moving
 * graph, never to weaken the control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const AGE_POLICY_OVERRIDE = /minimum[-_ ]?dependency[-_ ]?age|min[-_ ]?dep[-_ ]?age/i;
// Any `--node-modules-dir` on a governed surface other than `=manual` (including
// the bare flag, which Deno treats as `auto`) re-creates a Deno-managed graph.
const NON_MANUAL_NODE_MODULES_DIR = /--node-modules-dir(?!=manual\b)/;

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every source that launches a governed Deno process: the workflow that gates
 * PRs, the runner it calls, and the Deno tests that launch nested `deno check`
 * processes of their own (Deno.Command inherits deno.json, not the parent's
 * CLI flags).
 */
function governedSurfaces() {
  const surfaces = [
    { label: '.github/workflows/security-code.yml', content: read('.github', 'workflows', 'security-code.yml') },
    { label: 'scripts/run-backend-tests.js', content: read('scripts', 'run-backend-tests.js') },
  ];
  for (const file of walk(path.join(ROOT, 'supabase', 'functions'), (name) => name.endsWith('.test.ts'))) {
    surfaces.push({ label: path.relative(ROOT, file).replace(/\\/g, '/'), content: fs.readFileSync(file, 'utf8') });
  }
  return surfaces;
}

// Whole-line YAML/shell comments are prose, not commands. A comment that merely
// mentions `npm ci` or `deno check` must never satisfy or trip an assertion.
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

function projectChecksBlock() {
  const content = read('.github', 'workflows', 'security-code.yml');
  const start = content.indexOf('project-checks:');
  assert.notEqual(start, -1, 'security-code.yml must define the project-checks job');
  const end = content.indexOf('\n  gitleaks:', start);
  return withoutComments(content.slice(start, end === -1 ? undefined : end));
}

test('deno.json makes the npm ci node_modules the authority for governed Deno commands', () => {
  const config = JSON.parse(read('deno.json'));
  assert.equal(
    config.nodeModulesDir,
    'manual',
    'deno.json nodeModulesDir must be "manual": "auto"/"none" let Deno resolve its own moving npm graph instead of the one package-lock.json pins',
  );
});

test('the Deno minimum dependency age policy is not configured away in deno.json', () => {
  assert.doesNotMatch(
    read('deno.json'),
    AGE_POLICY_OVERRIDE,
    'deno.json must not override the minimum dependency age; fix resolution authority instead of weakening the supply-chain control',
  );
});

test('no governed Deno surface overrides the node_modules authority or the age policy', () => {
  for (const { label, content } of governedSurfaces()) {
    assert.doesNotMatch(
      content,
      NON_MANUAL_NODE_MODULES_DIR,
      `${label} must not pass --node-modules-dir other than =manual; deno.json is the single authority and nested deno processes only inherit deno.json`,
    );
    assert.doesNotMatch(
      content,
      AGE_POLICY_OVERRIDE,
      `${label} must not disable or loosen the Deno minimum dependency age`,
    );
  }
});

test('security-code.yml installs the locked graph with npm ci before any governed Deno step', () => {
  const block = projectChecksBlock();
  // The whole `run:` value must be exactly the command: `run: echo x # npm ci` is not an install.
  const runIndex = (command) => block.search(new RegExp(`^\\s*run:\\s*${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
  const npmCi = runIndex('npm ci');
  const backendSuite = runIndex('node scripts/run-backend-tests.js');
  const stylechatCheck = runIndex('deno check supabase/functions/stylechat-generate/index.ts');
  assert.notEqual(npmCi, -1, 'project-checks must run `npm ci`');
  assert.notEqual(backendSuite, -1, 'project-checks must run the governed backend Deno suite');
  assert.notEqual(stylechatCheck, -1, 'project-checks must run the StyleChat deno check');
  assert.ok(npmCi < backendSuite, 'npm ci must precede the governed backend Deno suite - manual mode consumes its node_modules');
  assert.ok(npmCi < stylechatCheck, 'npm ci must precede the StyleChat deno check - manual mode consumes its node_modules');
});

test('the deploy source-validation job, which has no npm ci, opts out of manual mode explicitly', () => {
  // nodeModulesDir=manual with no node_modules fails `deno check` outright, so
  // a job that does not install the locked graph must say so on the command.
  // Adding `npm ci` to that job is the deterministic alternative; either is
  // acceptable, silently inheriting manual mode is not.
  const content = read('.github', 'workflows', 'staging-controlled-deploy.yml');
  const start = content.indexOf('  source-validation:');
  assert.notEqual(start, -1, 'staging-controlled-deploy.yml must define source-validation');
  const end = content.indexOf('\n  deploy-one-function:', start);
  const job = withoutComments(content.slice(start, end === -1 ? undefined : end));

  const denoChecks = job.split('\n').filter((line) => /\bdeno check\b/.test(line));
  assert.ok(denoChecks.length > 0, 'source-validation must still run deno check');

  if (!/\bnpm ci\b/.test(job)) {
    for (const line of denoChecks) {
      assert.match(
        line,
        /--node-modules-dir=auto/,
        `source-validation has no npm ci, so its deno check needs an explicit --node-modules-dir=auto: ${line.trim()}`,
      );
    }
  }
});
