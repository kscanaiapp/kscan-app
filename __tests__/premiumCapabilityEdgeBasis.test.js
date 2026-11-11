'use strict';
// Deployed Edge identity for Premium Value proofs (2026-11-11).
//
// Production does not run this repository's supabase/functions copy, and two
// deployed functions run DIFFERENT versions of a shared file
// (scan-identify/shoppingProvider.ts in stylechat-generate vs
// commerce-watch-refresh). A proof earned on Production can only be recorded
// truthfully against the identity of what Production runs, so an Edge entry's
// identity comes from config/premium-capability-edge-basis.json, captured from
// the deployed bundle and cross-checked against a backend commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const lib = require('../scripts/premium-capability-fingerprint-lib.js');

const ROOT = path.resolve(__dirname, '..');
const reader = lib.fsReader(ROOT);
const BASIS = lib.loadEdgeBasis(reader);
const EDGE_ENTRIES = [...new Set(Object.values(lib.DOMAINS).flatMap((d) => d.edgeEntries))].sort();
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Full in-memory snapshot: governed client files, the basis, and the working-copy Edge closures. */
const snapshot = (() => {
  const files = {};
  for (const type of Object.keys(lib.DOMAINS)) {
    for (const rel of lib.governedFiles(type, reader)) files[rel] = reader.read(rel);
    for (const entry of lib.DOMAINS[type].edgeEntries) for (const rel of lib.edgeClosure(entry, reader)) files[rel] = reader.read(rel);
  }
  return files;
})();
const ids = (files) => lib.computeAllFingerprints(lib.memoryReader(files));
const withBasis = (mutateDoc) => {
  const doc = JSON.parse(snapshot[lib.EDGE_BASIS_RELATIVE_PATH]);
  mutateDoc(doc);
  return { ...snapshot, [lib.EDGE_BASIS_RELATIVE_PATH]: JSON.stringify(doc) };
};
const CURRENT = ids(snapshot);

test('the committed basis is well-formed and records exactly the governed Edge entries', () => {
  assert.ok(BASIS, 'config/premium-capability-edge-basis.json must exist');
  assert.equal(BASIS.version, lib.EDGE_BASIS_VERSION);
  assert.deepEqual(Object.keys(BASIS.entries).sort(), EDGE_ENTRIES);
  for (const [entry, record] of Object.entries(BASIS.entries)) {
    assert.equal(record.environment, 'production', entry);
    assert.equal(record.projectRef, 'wyyuqfdxucjksghsmhry', entry);
    assert.ok(record.files.some((f) => f.path === entry), `${entry} lists its entrypoint`);
  }
});

const revisionAvailable = (rev) => { try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${rev}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };
for (const [entry, record] of Object.entries(BASIS?.entries ?? {})) {
  const skip = revisionAvailable(record.basisCommit) ? false : 'basis commit is not in this clone (shallow checkout)';
  test(`${record.function}: every recorded deployed file reproduces from basisCommit`, { skip }, () => {
    for (const file of record.files) {
      const atBasis = execFileSync('git', ['-C', ROOT, 'show', `${record.basisCommit}:${file.path}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
      assert.equal(sha256(lib.normalise(atBasis)), file.sha256, file.path);
    }
  });
}

test('editing this repository\'s Edge copy does NOT change identity: Production\'s bundle defines it', () => {
  for (const entry of EDGE_ENTRIES) {
    const after = ids({ ...snapshot, [entry]: `${snapshot[entry]}\n// local copy edit\n` });
    assert.deepEqual(after, CURRENT, entry);
  }
});

test('a changed recorded hash (a redeploy) changes every identity bound to that function', () => {
  const after = ids(withBasis((doc) => { doc.entries['supabase/functions/stylechat-generate/index.ts'].files[0].sha256 = 'a'.repeat(64); }));
  assert.notEqual(after.packing_generation_and_refinement, CURRENT.packing_generation_and_refinement);
  assert.equal(after.watch_tracking, CURRENT.watch_tracking);
  const watchAfter = ids(withBasis((doc) => { doc.entries['supabase/functions/commerce-watch-refresh/index.ts'].files[0].sha256 = 'a'.repeat(64); }));
  assert.notEqual(watchAfter.watch_tracking, CURRENT.watch_tracking);
  assert.notEqual(watchAfter.watch_provider_entitlement_boundary, CURRENT.watch_provider_entitlement_boundary);
});

test('client files still hash from this tree', () => {
  const after = ids({ ...snapshot, 'services/packing/packingClient.ts': `${snapshot['services/packing/packingClient.ts']} ` });
  assert.notEqual(after.packing_generation_and_refinement, CURRENT.packing_generation_and_refinement);
});

test('NC: a malformed or partial basis fails closed instead of yielding an identity', () => {
  const stylechat = 'supabase/functions/stylechat-generate/index.ts';
  const cases = {
    'invalid JSON': { ...snapshot, [lib.EDGE_BASIS_RELATIVE_PATH]: '{ not json' },
    'wrong version': withBasis((d) => { d.version = 'v0'; }),
    'missing entry': withBasis((d) => { delete d.entries[stylechat]; }),
    'staging environment': withBasis((d) => { d.entries[stylechat].environment = 'staging'; }),
    'other project': withBasis((d) => { d.entries[stylechat].projectRef = 'yzqjvdfgefveprobvvyw'; }),
    'abbreviated commit': withBasis((d) => { d.entries[stylechat].basisCommit = d.entries[stylechat].basisCommit.slice(0, 10); }),
    'bad bundle hash': withBasis((d) => { d.entries[stylechat].ezbrSha256 = 'x'; }),
    'entrypoint absent': withBasis((d) => { d.entries[stylechat].files = d.entries[stylechat].files.filter((f) => f.path !== stylechat); }),
    'path traversal': withBasis((d) => { d.entries[stylechat].files[0].path = 'supabase/functions/../../secrets.ts'; }),
    'test file': withBasis((d) => { d.entries[stylechat].files[0].path = 'supabase/functions/x/a.test.ts'; }),
    'duplicate file': withBasis((d) => { d.entries[stylechat].files.push({ ...d.entries[stylechat].files[0] }); }),
    'malformed hash': withBasis((d) => { d.entries[stylechat].files[0].sha256 = 'abc'; }),
    'function mismatch': withBasis((d) => { d.entries[stylechat].function = 'scan-identify'; }),
  };
  for (const [name, files] of Object.entries(cases)) assert.throws(() => ids(files), /basis|JSON|Edge/i, name);
});

test('a revision without the basis keeps the original working-copy identity (historical proofs stay reproducible)', () => {
  const { [lib.EDGE_BASIS_RELATIVE_PATH]: _basis, ...legacy } = snapshot;
  const legacyIds = ids(legacy);
  assert.deepEqual(Object.keys(legacyIds).sort(), Object.keys(CURRENT).sort());
  for (const value of Object.values(legacyIds)) assert.match(value, /^[0-9a-f]{64}$/);
  // Domains without Edge entries are untouched by the basis.
  assert.equal(legacyIds.closet_outbound_sync, CURRENT.closet_outbound_sync);
  assert.equal(legacyIds.closet_cross_device_restore, CURRENT.closet_cross_device_restore);
});
