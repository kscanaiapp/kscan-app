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
    { label: '.github/workflows/staging-controlled-deploy.yml', content: read('.github', 'workflows', 'staging-controlled-deploy.yml') },
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

function sourceValidationBlock() {
  const content = read('.github', 'workflows', 'staging-controlled-deploy.yml');
  const start = content.indexOf('  source-validation:');
  assert.notEqual(start, -1, 'staging-controlled-deploy.yml must define source-validation');
  const end = content.indexOf('\n  deploy-one-function:', start);
  assert.notEqual(end, -1, 'source-validation must precede deploy-one-function');
  return withoutComments(content.slice(start, end));
}

function deployOneFunctionBlock() {
  const content = read('.github', 'workflows', 'staging-controlled-deploy.yml');
  const start = content.indexOf('  deploy-one-function:');
  assert.notEqual(start, -1, 'staging-controlled-deploy.yml must define deploy-one-function');
  const end = content.indexOf('\n  health-check:', start);
  assert.notEqual(end, -1, 'deploy-one-function must precede health-check');
  return withoutComments(content.slice(start, end));
}

function stepIndex(job, name) {
  return job.search(new RegExp(`^\\s+- name: ${name}\\s*$`, 'm'));
}

function setupDenoStep(job, label) {
  const start = stepIndex(job, 'Setup Deno');
  assert.notEqual(start, -1, `${label} must set up Deno`);
  const followingStep = job.indexOf('\n      - name:', start + 1);
  return job.slice(start, followingStep === -1 ? undefined : followingStep);
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
  const stagingHealthCheck = runIndex('deno check supabase/functions/staging-health/index.ts');
  assert.notEqual(npmCi, -1, 'project-checks must run `npm ci`');
  assert.notEqual(backendSuite, -1, 'project-checks must run the governed backend Deno suite');
  assert.notEqual(stylechatCheck, -1, 'project-checks must run the StyleChat deno check');
  assert.notEqual(stagingHealthCheck, -1, 'project-checks must run the staging-health deno check');
  assert.ok(npmCi < backendSuite, 'npm ci must precede the governed backend Deno suite - manual mode consumes its node_modules');
  assert.ok(npmCi < stylechatCheck, 'npm ci must precede the StyleChat deno check - manual mode consumes its node_modules');
  assert.ok(npmCi < stagingHealthCheck, 'npm ci must precede the staging-health deno check - manual mode consumes its node_modules');
});

test('release-critical Deno setup pins the same exact runtime in all three jobs', () => {
  for (const [label, job] of [
    ['security project-checks', projectChecksBlock()],
    ['staging source-validation', sourceValidationBlock()],
    ['staging deploy-one-function', deployOneFunctionBlock()],
  ]) {
    const step = setupDenoStep(job, label);
    assert.match(step, /^\s*uses: denoland\/setup-deno@[a-f0-9]{40}(?:\s+#.*)?$/m, `${label} must use a SHA-pinned setup action`);
    assert.match(step, /^\s*deno-version: ["']?2\.9\.7["']?\s*$/m, `${label} must pin Deno 2.9.7`);
  }
});

test('controlled deploy installs the locked graph and requires its internal pinned Deno check', () => {
  const job = deployOneFunctionBlock();
  const checkout = stepIndex(job, 'Checkout');
  const node = stepIndex(job, 'Setup Node');
  const install = stepIndex(job, 'Install dependencies');
  const deno = stepIndex(job, 'Setup Deno');
  const cli = stepIndex(job, 'Setup Supabase CLI');
  const deploy = stepIndex(job, 'Deploy function');
  assert.ok(checkout >= 0 && checkout < node && node < install && install < deno && deno < cli && cli < deploy,
    'deploy-one-function must establish Node, locked dependencies, and pinned Deno before invoking the deploy script');
  assert.match(job.slice(install, deno), /^\s*run: npm ci\s*$/m,
    'deploy-one-function must run npm ci before its internal Deno check');
  const deployStep = job.slice(deploy);
  assert.match(deployStep, /^\s*REQUIRE_DENO_CHECK:\s*['"]?true['"]?\s*$/m,
    'controlled deployment must fail closed when Deno is absent');
  assert.match(deployStep, /^\s*node scripts\/deploy-staging-function\.mjs \| tee deploy-result\.json\s*$/m,
    'controlled deployment must still invoke the checked deploy script');
});

test('staging source-validation installs the locked graph before pinned Deno and checks with manual mode', () => {
  const job = sourceValidationBlock();
  const checkout = stepIndex(job, 'Checkout');
  const node = stepIndex(job, 'Setup Node');
  const install = stepIndex(job, 'Install dependencies');
  const deno = stepIndex(job, 'Setup Deno');
  const check = stepIndex(job, 'Deno check');
  assert.ok(checkout >= 0 && checkout < node && node < install && install < deno && deno < check,
    'source-validation must run checkout, Node setup, locked install, pinned Deno setup, then Deno check in order');
  const installStep = job.slice(install, deno);
  assert.match(installStep, /^\s*run: npm ci\s*$/m, 'source-validation must run npm ci in the install step');
  const checkStep = job.slice(check);
  assert.match(checkStep, /^\s*deno check "supabase\/functions\/\$\{FN\}\/index\.ts"\s*$/m,
    'source-validation must check the selected function with deno.json manual mode');
  assert.doesNotMatch(checkStep, /--node-modules-dir(?:=|\s|$)/m,
    'source-validation must not override the root nodeModulesDir authority');
  assert.doesNotMatch(checkStep, /deno\.land\/install\.sh/,
    'source-validation must use the pinned setup action rather than a floating installer');
});
