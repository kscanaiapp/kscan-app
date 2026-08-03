#!/usr/bin/env node
'use strict';

/**
 * Perimeter-drift detection: compares a live Edge Function inventory
 * snapshot (as returned by `supabase functions list --output-format json`
 * or the equivalent MCP/API read) against the held-function allowlist and
 * the public ingress manifest (security/perimeter/public-ingress-manifest.json).
 *
 * Pure functions only — no network/CLI calls here. A CI step collects the
 * live snapshot and passes it in; see docs/security/public-ingress-inventory.md
 * for how this pass collected it.
 */

const path = require('node:path');

const HELD_FUNCTIONS = ['search-vinted-secondhand', 'tryon-clothes-pro', 'nike-shoe-details'];

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

function assertNotProductionRef(projectRef) {
  if (projectRef === PRODUCTION_REF) {
    throw new Error(`refused: production project ref (${PRODUCTION_REF})`);
  }
}

// Flags any held function that has become deployed — the single highest-
// severity perimeter regression this guard checks for.
function detectHeldFunctionsDeployed(liveFunctionSlugs, heldFunctions = HELD_FUNCTIONS) {
  const liveSet = new Set(liveFunctionSlugs);
  return heldFunctions.filter((name) => liveSet.has(name));
}

// Flags any live, deployed function whose slug has no entry in the ingress
// manifest at all — i.e. a new function shipped without ever being
// classified. Report-only by default (a brand-new function directory
// should be classified promptly, not silently block a deploy).
function detectUnclassifiedFunctions(liveFunctionSlugs, manifestSurfaces) {
  const classified = new Set(
    manifestSurfaces.filter((s) => s.type === 'supabase_edge_function').map((s) => s.name),
  );
  return liveFunctionSlugs.filter((slug) => !classified.has(slug));
}

// Flags any live function whose verify_jwt no longer matches what the
// manifest documents. `liveFunctions` is [{slug, verify_jwt}], manifest
// entries encode verify_jwt as free text in `deploymentStatus` /
// `accessControl` today (see notes) — this checks the specific case that
// matters most: a documented-true function silently flipping to false.
function detectVerifyJwtDrift(liveFunctions, expectedVerifyJwtBySlug) {
  const drift = [];
  for (const fn of liveFunctions) {
    const expected = expectedVerifyJwtBySlug[fn.slug];
    if (expected === undefined) continue; // unclassified case handled separately
    if (expected !== fn.verify_jwt) {
      drift.push({ slug: fn.slug, expected, actual: fn.verify_jwt });
    }
  }
  return drift;
}

module.exports = {
  HELD_FUNCTIONS,
  PRODUCTION_REF,
  assertNotProductionRef,
  detectHeldFunctionsDeployed,
  detectUnclassifiedFunctions,
  detectVerifyJwtDrift,
};

if (require.main === module) {
  // Local/manual invocation: reads a live snapshot JSON path from argv and
  // the checked-in manifest, prints a report. CI wires this to a collected
  // snapshot rather than calling the network itself.
  const fs = require('node:fs');
  const [snapshotPath] = process.argv.slice(2);
  if (!snapshotPath) {
    console.error('Usage: perimeter-manifest-guard.js <live-functions-snapshot.json>');
    process.exit(2);
  }
  const manifestPath = path.join(__dirname, '..', 'perimeter', 'public-ingress-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const live = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const slugs = live.map((f) => f.slug || f.name);

  const heldDeployed = detectHeldFunctionsDeployed(slugs);
  const unclassified = detectUnclassifiedFunctions(slugs, manifest.surfaces);

  console.log(JSON.stringify({ heldDeployed, unclassified }, null, 2));
  if (heldDeployed.length > 0) process.exit(1);
}
