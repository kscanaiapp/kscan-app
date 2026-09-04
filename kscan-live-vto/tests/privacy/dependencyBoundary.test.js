'use strict';

/**
 * Section 8.3 ("No sandbox analytics") and Section 32 (third-party SDK
 * privacy audit) mechanical guardrail, applied at the dependency-manifest
 * level: nothing in any packages/<name>/package.json may depend on a package
 * outside this workspace's own @kscan-live-vto/* scope without a human
 * deliberately reviewing it here. A new dependency shows up as a failing
 * test, not a silent addition — that review is the point.
 *
 * This is necessarily an allow-list, not a real network audit (Section 32
 * also requires inspecting live traffic during a device Live session,
 * which this cloud sandbox cannot do — see docs/vto-phase1-status.md).
 * Treat a green result here as "no dependency was added carelessly," not
 * as "the network boundary has been verified on-device."
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGES_DIR = path.join(WORKSPACE_ROOT, 'packages');

// Every external (non-@kscan-live-vto) package name any workspace
// package.json is currently allowed to depend on. Empty on purpose: the
// pure-logic packages built so far (contract, garment-contract,
// body-model, asset-pipeline, evaluation) need zero runtime dependencies
// beyond each other. Adding a real entry here is the reviewed way to
// bring in a new SDK — see Section 32's per-SDK record requirement,
// which should be added to docs/vto-risk-register.md alongside any
// change to this list.
const ALLOWED_EXTERNAL_RUNTIME_DEPENDENCIES = [];

function listPackageManifests() {
  return fs
    .readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PACKAGES_DIR, entry.name, 'package.json'))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}

test('every workspace package dependency is internal (@kscan-live-vto/*) or explicitly allow-listed', () => {
  const manifests = listPackageManifests();
  assert.ok(manifests.length > 0, 'expected at least one package manifest to check');

  const violations = [];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const deps = { ...manifest.dependencies };
    for (const depName of Object.keys(deps)) {
      const isInternal = depName.startsWith('@kscan-live-vto/');
      const isAllowListed = ALLOWED_EXTERNAL_RUNTIME_DEPENDENCIES.includes(depName);
      if (!isInternal && !isAllowListed) {
        violations.push(`${path.relative(WORKSPACE_ROOT, manifestPath)}: unreviewed dependency "${depName}"`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('no workspace package declares a devDependency outside the pinned toolchain', () => {
  // devDependencies live only at the workspace root (typescript, @types/node) — see package.json.
  const manifests = listPackageManifests();
  const violations = [];
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.devDependencies && Object.keys(manifest.devDependencies).length > 0) {
      violations.push(path.relative(WORKSPACE_ROOT, manifestPath));
    }
  }
  assert.deepEqual(violations, []);
});
