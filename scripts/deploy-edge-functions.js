#!/usr/bin/env node
/**
 * The approved deployment path for the image-identification Edge Functions.
 *
 * Phase 2A found that any linked checkout could run `supabase functions deploy
 * scan-identify` and ship a tree that differs from production, with nothing in
 * the repository objecting. This wrapper is the sanctioned entry point: it
 * refuses to invoke the Supabase CLI at all until the checkout is proven
 * identical to the canonical manifest.
 *
 * Order of operations (every step must pass before the next runs):
 *   1. the committed manifest exists and is current for this working tree
 *   2. supabase/config.toml declares the approved production project reference
 *   3. every governed function tree and deployable bundle matches the manifest
 *   4. the working tree has no uncommitted changes under supabase/functions
 *   5. the current Git SHA and per-function tree/bundle hashes are reported
 *   6. an explicit --confirm-deploy flag naming the function is supplied
 *
 * Without step 6 this script is a dry run and never spawns the CLI. That is the
 * intended default: seeing what WOULD deploy must never be able to deploy.
 *
 * Usage:
 *   node scripts/deploy-edge-functions.js                       # dry run, all governed functions
 *   node scripts/deploy-edge-functions.js --function scan-identify
 *   node scripts/deploy-edge-functions.js --function scan-identify --confirm-deploy scan-identify
 *
 * Exit codes:
 *   0  verification passed (dry run) or deployment completed
 *   1  drift / dirty tree / verification failure — nothing was deployed
 *   2  usage error
 */

'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { FUNCTIONS_ROOT, readProjectRef } = require('./edge-function-manifest-lib.js');
const { assertExpectedEnvironment } = require('../security/scripts/lib/environment-authority.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_ABSOLUTE_PATH = path.join(REPO_ROOT, 'config', 'edge-function-manifest.json');

function parseArgs(argv) {
  const options = { functions: [], confirm: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--function') {
      const value = argv[index + 1];
      if (!value) {
        console.error('FAIL  --function requires a function name.');
        process.exit(2);
      }
      options.functions.push(value);
      index += 1;
    } else if (arg === '--confirm-deploy') {
      const value = argv[index + 1];
      if (!value) {
        console.error('FAIL  --confirm-deploy requires the function name to deploy.');
        process.exit(2);
      }
      options.confirm.push(value);
      index += 1;
    } else {
      console.error(`FAIL  Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

/** Runs a repository gate script and returns true when it exits 0. */
function runGate(scriptName, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, scriptName), ...args], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  return result.status === 0;
}

function gitOutput(args, fallback) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(MANIFEST_ABSOLUTE_PATH)) {
    console.error('FAIL  config/edge-function-manifest.json is missing. Nothing was deployed.');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_ABSOLUTE_PATH, 'utf8'));
  const governed = manifest.parity.expectedFunctions;

  const targets = options.functions.length > 0 ? options.functions : [...governed];
  const ungoverned = targets.filter((name) => !governed.includes(name));
  if (ungoverned.length > 0) {
    console.error(
      `FAIL  Not governed by the parity manifest: ${ungoverned.join(', ')}.\n` +
        '      This wrapper only deploys functions whose source parity it can prove.',
    );
    process.exit(2);
  }

  console.log('── Step 1/6  manifest currency ─────────────────────────────────');
  if (!runGate('generate-edge-function-manifest.js', ['--check'])) {
    console.error('\nABORTED  Manifest is stale. Nothing was deployed.');
    process.exit(1);
  }

  console.log('\n── Step 2/6  project reference ─────────────────────────────────');
  // This wrapper is the PRODUCTION deploy path, so it asserts the production
  // environment explicitly rather than trusting a ref recorded in the artifact
  // manifest. The manifest is environment-neutral; the deploy target is not.
  //
  // assertExpectedEnvironment fails closed in every direction: a staging ref, an
  // unknown ref, a malformed ref and a missing config.toml all abort here.
  const projectRef = readProjectRef(REPO_ROOT);
  try {
    assertExpectedEnvironment('production', projectRef);
  } catch (error) {
    console.error(
      `FAIL  config.toml project_id "${projectRef}" does not resolve to the production ` +
        `environment (${error.code}).\n\nABORTED  Nothing was deployed.`,
    );
    process.exit(1);
  }
  console.log(`PASS  Target project ${projectRef} resolves to the production environment.`);

  console.log('\n── Step 3/6  function tree parity ──────────────────────────────');
  if (!runGate('check-edge-function-parity.js')) {
    console.error('\nABORTED  Deployable source drifted from canonical. Nothing was deployed.');
    process.exit(1);
  }

  console.log('\n── Step 4/6  working tree cleanliness ──────────────────────────');
  const dirty = gitOutput(['status', '--porcelain', '--', FUNCTIONS_ROOT], null);
  if (dirty === null) {
    console.error('FAIL  Git status unavailable; cannot prove the deployed source is committed.');
    console.error('\nABORTED  Nothing was deployed.');
    process.exit(1);
  }
  if (dirty !== '') {
    console.error('FAIL  Uncommitted changes under supabase/functions:');
    for (const line of dirty.split(/\r?\n/)) console.error(`    ${line}`);
    console.error('\nABORTED  Deployed source must be committed and reviewable. Nothing was deployed.');
    process.exit(1);
  }
  console.log('PASS  No uncommitted changes under supabase/functions.');

  console.log('\n── Step 5/6  provenance report ─────────────────────────────────');
  console.log(`  Git SHA    : ${gitOutput(['rev-parse', 'HEAD'], 'unknown')}`);
  console.log(`  Git branch : ${gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown')}`);
  console.log(`  Project    : ${projectRef}`);
  for (const name of targets) {
    const fn = manifest.parity.functions.find((entry) => entry.name === name);
    console.log(`  ${name}`);
    console.log(`    tree   hash ${fn.treeHash}  (${fn.treeFileCount} files)`);
    console.log(`    bundle hash ${fn.bundleHash}  (${fn.bundleFileCount} files)`);
  }

  console.log('\n── Step 6/6  explicit deployment confirmation ──────────────────');
  const unconfirmed = targets.filter((name) => !options.confirm.includes(name));
  if (unconfirmed.length > 0) {
    console.log('DRY RUN — nothing was deployed.');
    console.log('  Verification passed for: ' + targets.join(', '));
    console.log('  Awaiting explicit confirmation for: ' + unconfirmed.join(', '));
    console.log('');
    console.log('  To deploy, re-run with an explicit confirmation per function, e.g.:');
    for (const name of unconfirmed) {
      console.log(`    node scripts/deploy-edge-functions.js --function ${name} --confirm-deploy ${name}`);
    }
    console.log('');
    console.log('  Deployment is an owner-authorized release action. Verification is not authorization.');
    return;
  }

  for (const name of targets) {
    console.log(`\nDeploying ${name} to ${projectRef} …`);
    const result = spawnSync('supabase', ['functions', 'deploy', name, '--project-ref', projectRef], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      console.error(`FAIL  supabase functions deploy ${name} exited ${result.status}.`);
      process.exit(1);
    }
  }
  console.log('\nDeployment complete.');
}

main();
