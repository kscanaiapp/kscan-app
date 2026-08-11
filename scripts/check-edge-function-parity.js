#!/usr/bin/env node
/**
 * Edge Function source-parity gate (IMG-006).
 *
 * Verifies that THIS checkout's deployable Edge Function source is identical to
 * the committed canonical manifest. Because the same manifest is committed on
 * every platform branch, "matches the manifest" transitively means "matches the
 * other platform branch" — which is the property Phase 2A found missing when the
 * iOS branch carried an independently deployable copy of `scan-identify` and
 * `stylechat-generate`.
 *
 * Failure conditions (each is a hard fail, never a warning):
 *   - the manifest is absent or unparseable
 *   - the governed function list differs from the manifest
 *   - a governed file is missing, added, or has a different SHA-256
 *   - a file moved between the bundle set and the non-deployed tree
 *   - a required local module cannot be resolved from a function entry point
 *   - the aggregate bundle or tree hash differs
 *   - `supabase/config.toml` is missing, or its project_id is not a known
 *     K Scan environment (this gate proves the checkout HAS an environment
 *     identity; it does not require a particular one — the artifact inventory
 *     is environment-neutral, and choosing a deploy target is enforced at
 *     deploy time by scripts/deploy-edge-functions.js)
 *   - the manifest is stale with respect to the working tree
 *
 * Usage:
 *   node scripts/check-edge-function-parity.js
 *   node scripts/check-edge-function-parity.js --report-ungoverned
 *
 * Exit codes:
 *   0  parity verified
 *   1  drift detected — do NOT deploy
 *   2  manifest missing / usage error
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG_RELATIVE_PATH,
  FUNCTIONS_ROOT,
  buildParity,
  resolveCheckoutEnvironment,
} = require('./edge-function-manifest-lib.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_RELATIVE_PATH = 'config/edge-function-manifest.json';
const MANIFEST_ABSOLUTE_PATH = path.join(REPO_ROOT, 'config', 'edge-function-manifest.json');

/**
 * Verifies the checkout against the committed manifest.
 * Returns a list of human-readable failure strings; empty means parity holds.
 */
function verifyParity() {
  const failures = [];

  if (!fs.existsSync(MANIFEST_ABSOLUTE_PATH)) {
    return [`${MANIFEST_RELATIVE_PATH} not found — the canonical manifest must be committed.`];
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_ABSOLUTE_PATH, 'utf8'));
  } catch (error) {
    return [`${MANIFEST_RELATIVE_PATH} is not valid JSON: ${error.message}`];
  }

  const expected = manifest.parity;
  if (!expected || !Array.isArray(expected.functions)) {
    return [`${MANIFEST_RELATIVE_PATH} has no usable "parity" section.`];
  }

  // Environment identity: this checkout must be able to PROVE which Supabase
  // project it targets. It is not required to be any particular one — the
  // artifact inventory below is environment-neutral, and this manifest is
  // committed identically on branches that legitimately target staging and on
  // branches that legitimately target production. Requiring a single ref here
  // is what made this gate fail on the staging line for a non-drift reason.
  //
  // Choosing an environment is a deploy-time decision, enforced by
  // scripts/deploy-edge-functions.js. Proving one is a parity-time
  // precondition, enforced here, and it fails closed.
  const checkout = resolveCheckoutEnvironment(REPO_ROOT);
  if (!checkout.ok) {
    const configPath = CONFIG_RELATIVE_PATH.split(path.sep).join('/');
    if (checkout.code === 'MISSING_ENVIRONMENT_IDENTITY') {
      failures.push(
        `${configPath} is missing — this checkout cannot prove which Supabase project a deploy would reach.`,
      );
    } else {
      failures.push(
        `${configPath} declares project "${checkout.ref}", which is not a known K Scan environment ` +
          `(${checkout.code}). Refusing to certify parity for an unrecognized project.`,
      );
    }
  }

  if (expected.environmentScope !== 'ENVIRONMENT_NEUTRAL') {
    failures.push(
      `${MANIFEST_RELATIVE_PATH} declares environmentScope "${expected.environmentScope}" — ` +
        'this gate only certifies an environment-neutral artifact inventory.',
    );
  }

  // Recompute from the working tree. A resolution error here means a required
  // shared module is missing, which is itself a deploy-blocking condition.
  let actual;
  try {
    actual = buildParity(REPO_ROOT, expected.expectedFunctions);
  } catch (error) {
    failures.push(error.message);
    return failures;
  }

  const expectedNames = [...expected.expectedFunctions].sort().join(',');
  const actualNames = [...actual.expectedFunctions].sort().join(',');
  if (expectedNames !== actualNames) {
    failures.push(`Governed function set differs: manifest [${expectedNames}] vs tree [${actualNames}].`);
  }

  for (const expectedFn of expected.functions) {
    const actualFn = actual.functions.find((fn) => fn.name === expectedFn.name);
    if (!actualFn) {
      failures.push(`Function "${expectedFn.name}" is in the manifest but not resolvable in this tree.`);
      continue;
    }

    const expectedFiles = new Map(expectedFn.files.map((file) => [file.path, file]));
    const actualFiles = new Map(actualFn.files.map((file) => [file.path, file]));

    for (const [filePath, expectedFile] of expectedFiles) {
      const actualFile = actualFiles.get(filePath);
      if (!actualFile) {
        // A shared module can be absent from a function's file set for two very
        // different reasons, and conflating them sends the reader to the wrong
        // place: the file may not exist at all, or it may exist but no longer be
        // reachable from this function's entry point (an import was dropped).
        const existsOnDisk = fs.existsSync(path.join(REPO_ROOT, filePath));
        failures.push(
          existsOnDisk
            ? `${expectedFn.name}: ${filePath} exists but is no longer imported by this function ` +
              '— the deployed bundle would silently lose it.'
            : `${expectedFn.name}: required file is absent from this checkout ${filePath}`,
        );
        continue;
      }
      if (actualFile.sha256 !== expectedFile.sha256) {
        failures.push(
          `${expectedFn.name}: content differs ${filePath}\n` +
            `    manifest ${expectedFile.sha256}\n` +
            `    tree     ${actualFile.sha256}`,
        );
      }
      if (actualFile.bundle !== expectedFile.bundle) {
        failures.push(
          `${expectedFn.name}: ${filePath} changed deployability ` +
            `(manifest bundle=${expectedFile.bundle}, tree bundle=${actualFile.bundle}).`,
        );
      }
    }

    for (const filePath of actualFiles.keys()) {
      if (!expectedFiles.has(filePath)) {
        failures.push(`${expectedFn.name}: unexpected file not in manifest ${filePath}`);
      }
    }

    if (actualFn.bundleHash !== expectedFn.bundleHash) {
      failures.push(
        `${expectedFn.name}: deployable bundle hash differs\n` +
          `    manifest ${expectedFn.bundleHash}\n` +
          `    tree     ${actualFn.bundleHash}`,
      );
    }
    if (actualFn.treeHash !== expectedFn.treeHash) {
      failures.push(
        `${expectedFn.name}: function tree hash differs\n` +
          `    manifest ${expectedFn.treeHash}\n` +
          `    tree     ${actualFn.treeHash}`,
      );
    }

    const expectedRemote = [...expectedFn.remoteSpecifiers].sort().join(',');
    const actualRemote = [...actualFn.remoteSpecifiers].sort().join(',');
    if (expectedRemote !== actualRemote) {
      failures.push(
        `${expectedFn.name}: remote dependency specifiers differ\n` +
          `    manifest ${expectedRemote}\n` +
          `    tree     ${actualRemote}`,
      );
    }
  }

  return failures;
}

/**
 * Lists Edge Functions present in the tree that this gate does NOT govern.
 *
 * Phase 2A.5 deliberately scopes the manifest to the image-identification loop.
 * Other functions — notably the account-lifecycle family — are known to differ
 * between the platform branches. Printing them keeps that an explicit, visible
 * owner decision instead of an unstated gap in coverage.
 */
function reportUngoverned() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_ABSOLUTE_PATH, 'utf8'));
  const governed = new Set(manifest.parity.expectedFunctions);
  const root = path.join(REPO_ROOT, FUNCTIONS_ROOT);
  const all = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .map((entry) => entry.name)
    .sort();

  const ungoverned = all.filter((name) => !governed.has(name));
  console.log('');
  console.log(`Ungoverned Edge Functions (${ungoverned.length}) — not covered by this gate:`);
  for (const name of ungoverned) console.log(`  - ${name}`);
  console.log('  Cross-branch parity for these is an open owner decision (see docs/edge-function-deployment.md).');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const failures = verifyParity();

  if (failures.length > 0) {
    console.error('EDGE FUNCTION PARITY: FAIL');
    console.error('Deployable source does not match the canonical manifest. Do NOT deploy.');
    console.error('');
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('');
    console.error(`  ${failures.length} problem(s) found.`);
    process.exit(failures[0].includes('not found') ? 2 : 1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_ABSOLUTE_PATH, 'utf8'));
  const checkout = resolveCheckoutEnvironment(REPO_ROOT);
  console.log('EDGE FUNCTION PARITY: PASS');
  console.log(`  manifest version : ${manifest.parity.manifestVersion}`);
  console.log(`  artifact scope   : ${manifest.parity.environmentScope}`);
  console.log(`  checkout targets : ${checkout.environment} (${checkout.ref})`);
  for (const fn of manifest.parity.functions) {
    console.log(
      `  ${fn.name.padEnd(20)} bundle ${String(fn.bundleFileCount).padStart(3)} files  ${fn.bundleHash.slice(0, 16)}…`,
    );
  }

  if (args.has('--report-ungoverned')) reportUngoverned();
}

main();
