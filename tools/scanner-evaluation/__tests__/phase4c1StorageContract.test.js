'use strict';

/**
 * Phase 4C.1 — storage-root semantics.
 *
 * KSCAN_EVAL_STORAGE_ROOT is the root that CONTAINS the governed children; it is
 * never one of them. The two children are checked independently, so "both happen
 * to sit under a common parent" is not accepted as containment.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gs = require('../lib/governedStorage');
const live = require('../lib/liveAdapter');

const STORAGE_ROOT = 'C:/Users/jsmit/KScan-eval-storage-private';
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(gs.ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json'), 'utf8')
);

test('the parent storage root resolves all 56 governed images', () => {
  const refs = MANIFEST.cases.flatMap((c) => c.imageReferences.map((r) => r.refValue));
  assert.strictEqual(refs.length, 56);
  let resolved = 0;
  for (const ref of refs) {
    const p = gs.resolveImageRef(ref, { storageRoot: STORAGE_ROOT });
    if (fs.existsSync(p)) resolved += 1;
  }
  assert.strictEqual(resolved, 56, 'PARENT STORAGE ROOT RESOLVES must be 56/56');
});

test('a root pointing at tier-a is rejected with an actionable message', () => {
  // Silently accepting both spellings is how the ambiguity survived.
  assert.throws(
    () => gs.requireStorageRoot(path.join(STORAGE_ROOT, 'tier-a')),
    /must be the storage root that CONTAINS/
  );
});

test('an absent storage root fails closed and never falls back to a repo path', () => {
  const previous = process.env.KSCAN_EVAL_STORAGE_ROOT;
  delete process.env.KSCAN_EVAL_STORAGE_ROOT;
  try {
    assert.throws(() => gs.requireStorageRoot(), /is not set/);
    assert.throws(() => gs.requireStorageRoot('  '), /is not set/);
    // A governed ref must never silently become a repo-relative path.
    assert.throws(
      () => gs.resolveImageRef('storage://bucket/tier-a/x/primary'),
      /is not set/
    );
  } finally {
    if (previous === undefined) delete process.env.KSCAN_EVAL_STORAGE_ROOT;
    else process.env.KSCAN_EVAL_STORAGE_ROOT = previous;
  }
});

test('the two governed child roots are explicit and distinct', () => {
  const images = gs.governedImageRoot(STORAGE_ROOT);
  const results = gs.privateResultsRoot('run-1', STORAGE_ROOT);
  assert.strictEqual(path.basename(images), 'tier-a');
  assert.strictEqual(path.basename(path.dirname(results)), 'results');
  assert.notStrictEqual(images, results);
  assert.ok(!results.startsWith(images + path.sep), 'IMAGE/RESULT ROOT COLLISION must be NO');
  assert.ok(!images.startsWith(results + path.sep));
});

test('image path escape is blocked', () => {
  for (const evil of [
    'storage://bucket/tier-a/../../escape/x',
    'storage://bucket/tier-a/../results/x',
  ]) {
    assert.throws(() => gs.resolveImageRef(evil, { storageRoot: STORAGE_ROOT }), /traversal|escapes/);
  }
});

test('a run id containing a separator or traversal is rejected', () => {
  for (const evil of ['../escape', 'a/b', 'a\\b', '..']) {
    assert.throws(() => gs.privateResultsRoot(evil, STORAGE_ROOT), /path separator or traversal/);
  }
});

test('result path escape is blocked', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-escape-'));
  try {
    assert.throws(
      () => live.verifyPrivateOutputRoot(outside, { storageRoot: STORAGE_ROOT }),
      (e) => e instanceof live.PreflightRefused && e.gate === 'containment'
    );
    // The common parent is NOT sufficient: a sibling of results is still refused.
    assert.throws(
      () => live.verifyPrivateOutputRoot(path.join(STORAGE_ROOT, 'not-results'), { storageRoot: STORAGE_ROOT }),
      (e) => e instanceof live.PreflightRefused && e.gate === 'containment'
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a result can never be written into the governed image corpus', () => {
  const insideCorpus = path.join(gs.governedImageRoot(STORAGE_ROOT), 'run-output');
  assert.throws(
    () => live.verifyPrivateOutputRoot(insideCorpus, { storageRoot: STORAGE_ROOT }),
    (e) => e instanceof live.PreflightRefused && (e.gate === 'containment' || e.gate === 'root_collision')
  );
  assert.ok(!fs.existsSync(insideCorpus), 'RESULT WRITTEN INTO TIER-A must be NO');
});

test('an approved per-run results root is accepted and isolated', () => {
  const runRoot = gs.privateResultsRoot('selftest-run', STORAGE_ROOT);
  fs.rmSync(runRoot, { recursive: true, force: true });
  try {
    const report = live.verifyPrivateOutputRoot(runRoot, { storageRoot: STORAGE_ROOT, retentionDays: 90 });
    assert.ok(fs.existsSync(report.retentionPath));
    assert.ok(!path.resolve(runRoot).startsWith(path.resolve(gs.governedImageRoot(STORAGE_ROOT)) + path.sep));
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test('no governed image resolves outside the image root', () => {
  const imageRoot = path.resolve(gs.governedImageRoot(STORAGE_ROOT));
  for (const c of MANIFEST.cases) {
    for (const ref of c.imageReferences) {
      const p = path.resolve(gs.resolveImageRef(ref.refValue, { storageRoot: STORAGE_ROOT }));
      assert.ok(p.startsWith(imageRoot + path.sep), `${ref.refValue} escaped the image root`);
    }
  }
});
