// PR692 Black-Owned Discovery catalog-operations promotion. Older promotion
// controls compare every historical grant; these helpers advance exactly the
// rows this promotion owns, read from the merged canonical commit, never from
// mutable policy metadata.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const canonical = 'd1be51d64b89882324482a7d83dfc0022eeddb1c';
const migrationVersion = '20261103030000';
const guard = 'supabase/functions/scan-identify/phase2b4CrossPath.test.ts';
const fileCount = 64;
const files = [
  'supabase/functions/black-owned-discovery/adminService.ts',
  'supabase/functions/black-owned-discovery/catalog.ts',
  'supabase/functions/black-owned-discovery/engine.ts',
  'supabase/functions/black-owned-discovery/index.ts',
  'supabase/functions/black-owned-discovery/sponsorshipStore.ts',
  'supabase/functions/black-owned-discovery/validation.ts',
  guard,
  'supabase/functions/black-owned-catalog-sync/index.ts',
  'supabase/functions/black-owned-discovery/authorizedJsonAdapter.ts',
  'supabase/functions/black-owned-discovery/catalogWorker.ts',
  'supabase/functions/black-owned-discovery/catalogWorker.test.ts',
  `supabase/migrations/${migrationVersion}_black_owned_catalog_moderation.sql`,
];
const reason = 'Exact canonical PR692 Black-Owned Discovery catalog operations: head-noun subtype matching, accessory alias, worker-secret catalog sync, authorized JSON feed, durable moderation migration 20261103030000 (KNOWN_FUTURE_UNAPPLIED) and governed privilege inventory. Source-only; no deployment, flag, ranking-policy or ownership-policy grant.';
const discoveryFunctions = ['black-owned-catalog-sync', 'black-owned-discovery', 'sponsorship-sandbox'];

const gitBlob = (file, sha = canonical) => execFileSync('git', ['show', `${sha}:${file}`], { cwd: root });
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const row = (file) => ({ file, sha256: sha256(gitBlob(file)), source: canonical, reason });

function discoveryAdvance(rows) {
  const out = rows.map((r) => (files.includes(r.file) ? row(r.file) : r));
  for (const file of files) if (!out.some((r) => r.file === file)) out.push(row(file));
  return out;
}
function discoveryPendingAdvance(rows, ref) {
  const approved = JSON.parse(gitBlob('config/migration-authority-manifest.json')).ledgerReconciliation.environments[ref].knownPending.find((r) => r.localVersion === migrationVersion);
  assert.ok(approved);
  assert.equal(approved.disposition, 'KNOWN_FUTURE_UNAPPLIED');
  return rows.some((r) => r.localVersion === migrationVersion) ? rows : [...rows, approved];
}
/**
 * Discovery runtimes may change only in files this promotion owns; every other
 * closure file must keep the hash it already had in this line. scan-identify may
 * advance only its test-only privilege-inventory guard.
 */
function discoveryFunctionAdvance(rows) {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'config/edge-function-manifest.json'), 'utf8')).parity.functions;
  const known = new Map(rows.flatMap((r) => r.files.map((f) => [f.path, f.sha256])));
  const promoted = new Map(files.map((f) => [f, sha256(gitBlob(f))]));
  const verified = (name) => {
    const r = current.find((c) => c.name === name);
    assert.ok(r, name);
    for (const f of r.files) assert.equal(f.sha256, promoted.has(f.path) ? promoted.get(f.path) : known.get(f.path), `${name}: ${f.path} changed outside PR692`);
    return r;
  };
  const out = rows.filter((r) => r.name !== 'black-owned-catalog-sync').map((r) => {
    if (discoveryFunctions.includes(r.name)) return verified(r.name);
    if (r.name !== 'scan-identify') return r;
    const next = structuredClone(r);
    const file = next.files.find((f) => f.path === guard);
    assert.ok(file);
    assert.equal(file.bundle, false, 'only the reviewed test file may change');
    file.sha256 = promoted.get(guard);
    next.treeHash = require('../../scripts/edge-function-manifest-lib').aggregateHash(next.files);
    return next;
  });
  out.splice(out.findIndex((r) => r.name === 'black-owned-discovery'), 0, verified('black-owned-catalog-sync'));
  return out;
}
const campaignAdvance = (text) => text.replace("'20261103011431'];", `'20261103011431', '${migrationVersion}'];`);
const stagingAdvance = (text) => text.replace("['20261103011431', 'KNOWN_FUTURE_UNAPPLIED'],", `['20261103011431', 'KNOWN_FUTURE_UNAPPLIED'],\n      ['${migrationVersion}', 'KNOWN_FUTURE_UNAPPLIED'],`);

// B004 is a separate exact scan-only advance; discovery source provenance stays fixed.
const scanner=require('./scannerNullBodyPromotion');
const watchlist=require('./watchlistTicketPromotion');
module.exports = { root, canonical, currentCanonical:watchlist.canonical, migrationVersion, guard, files, fileCount, gitBlob, sha256,
  discoveryAdvance:rows=>watchlist.advance(scanner.advance(discoveryAdvance(rows))), discoveryPendingAdvance,
  discoveryFunctionAdvance:rows=>watchlist.functionAdvance(scanner.functionAdvance(discoveryFunctionAdvance(rows))), campaignAdvance, stagingAdvance };
