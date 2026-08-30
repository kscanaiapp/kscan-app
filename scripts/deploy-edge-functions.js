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
 *   1. this checkout declares itself the canonical backend deployment
 *      authority (config/backend-authority.json) -- B34-DEF-001
 *   2. the committed manifest exists and is current for this working tree
 *   3. supabase/config.toml declares the approved project reference
 *   4. every governed function tree and deployable bundle matches the manifest
 *   5. the working tree has no uncommitted changes under supabase/functions
 *   6. the current Git SHA and per-function tree/bundle hashes are reported
 *   7. an explicit --confirm-deploy flag naming the function is supplied
 *
 * Without step 7 this script is a dry run and never spawns the CLI. That is the
 * intended default: seeing what WOULD deploy must never be able to deploy.
 *
 * B34-DEF-001: this mobile integration branch's copy of supabase/functions is
 * NOT the canonical backend deployment authority -- see
 * docs/BACKEND_DEPLOYMENT_AUTHORITY.md. Step 1 fails here by design; this
 * branch intentionally has no config/backend-authority.json declaring
 * itself authoritative.
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

/**
 * B34-DEF-001: refuses to proceed unless this checkout is the declared
 * canonical backend deployment authority (config/backend-authority.json with
 * role "backend-deployment-authority"). This is what makes it impossible for
 * a mobile integration branch's copy of supabase/functions -- which carries
 * no such marker -- to be mistaken for the real deploy authority: it fails
 * here before Step 1 even runs, regardless of whether its manifest happens
 * to be internally consistent.
 */
function assertDeploymentAuthority() {
  const authorityPath = path.join(REPO_ROOT, 'config', 'backend-authority.json');
  if (!fs.existsSync(authorityPath)) {
    console.error(
      'FAIL  config/backend-authority.json is missing from this checkout.\n' +
        '      This wrapper only deploys from the declared canonical backend authority.\n' +
        '      See docs/BACKEND_DEPLOYMENT_AUTHORITY.md (or its equivalent) for where that is.',
    );
    return false;
  }
  let authority;
  try {
    authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
  } catch (error) {
    console.error(`FAIL  config/backend-authority.json is not valid JSON: ${error.message}`);
    return false;
  }
  if (authority.role !== 'backend-deployment-authority') {
    console.error(
      `FAIL  config/backend-authority.json declares role "${authority.role}", not ` +
        '"backend-deployment-authority". This checkout is explicitly marked non-authoritative.',
    );
    return false;
  }
  console.log(`PASS  This checkout declares itself the backend deployment authority (${authority.canonicalBranch}).`);
  return true;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log('── Step 1/7  deployment authority ──────────────────────────────');
  if (!assertDeploymentAuthority()) {
    console.error('\nABORTED  Nothing was deployed.');
    process.exit(1);
  }

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

  console.log('\n── Step 2/7  manifest currency ─────────────────────────────────');
  if (!runGate('generate-edge-function-manifest.js', ['--check'])) {
    console.error('\nABORTED  Manifest is stale. Nothing was deployed.');
    process.exit(1);
  }

  console.log('\n── Step 3/7  project reference ─────────────────────────────────');
  const projectRef = readProjectRef(REPO_ROOT);
  if (projectRef !== manifest.parity.approvedProjectRef) {
    console.error(
      `FAIL  config.toml project_id "${projectRef}" is not the approved project reference ` +
        `"${manifest.parity.approvedProjectRef}".\n\nABORTED  Nothing was deployed.`,
    );
    process.exit(1);
  }
  console.log(`PASS  Target project ${projectRef} matches the approved project reference.`);

  console.log('\n── Step 4/7  function tree parity ──────────────────────────────');
  if (!runGate('check-edge-function-parity.js')) {
    console.error('\nABORTED  Deployable source drifted from canonical. Nothing was deployed.');
    process.exit(1);
  }

  console.log('\n── Step 5/7  working tree cleanliness ──────────────────────────');
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

  console.log('\n── Step 6/7  provenance report ─────────────────────────────────');
  console.log(`  Git SHA    : ${gitOutput(['rev-parse', 'HEAD'], 'unknown')}`);
  console.log(`  Git branch : ${gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown')}`);
  console.log(`  Project    : ${projectRef}`);
  for (const name of targets) {
    const fn = manifest.parity.functions.find((entry) => entry.name === name);
    console.log(`  ${name}`);
    console.log(`    tree   hash ${fn.treeHash}  (${fn.treeFileCount} files)`);
    console.log(`    bundle hash ${fn.bundleHash}  (${fn.bundleFileCount} files)`);
  }

  console.log('\n── Step 7/7  explicit deployment confirmation ──────────────────');
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
