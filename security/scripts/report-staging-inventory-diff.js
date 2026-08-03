#!/usr/bin/env node
'use strict';

/**
 * Compares a "before" and "after" Edge Function inventory snapshot (as
 * returned by `supabase functions list --project-ref <ref>`, parsed to
 * JSON) and reports which functions were newly deployed as a side effect —
 * i.e. present after but not before. Used to make an unintended deployment
 * (such as a CI loop deploying every function directory instead of only the
 * changed ones) an explicit, auditable finding rather than something that
 * has to be reconstructed by memory after the fact.
 *
 * Node built-ins only. Pure function of two arrays — no network calls.
 *
 * Usage:
 *   node security/scripts/report-staging-inventory-diff.js <before.json> <after.json>
 */

const fs = require('node:fs');

// before/after: arrays of {slug|name, version, ...} as returned by
// `supabase functions list`. Returns the functions present in `after` but
// not `before` (by slug), each annotated with its post-run version — the
// exact set a rollback would need to remove to restore the prior inventory.
function diffInventory(before, after) {
  const beforeSlugs = new Set(before.map((f) => f.slug || f.name));
  const unintended = after
    .filter((f) => !beforeSlugs.has(f.slug || f.name))
    .map((f) => ({ slug: f.slug || f.name, version: f.version, verifyJwt: f.verify_jwt }));
  return {
    beforeCount: before.length,
    afterCount: after.length,
    unintendedlyDeployed: unintended,
    restoresInventoryIfRemoved: unintended.length > 0,
  };
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('Usage: report-staging-inventory-diff.js <before.json> <after.json>');
    process.exit(2);
  }
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  console.log(JSON.stringify(diffInventory(before.functions || before, after.functions || after), null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { diffInventory };
