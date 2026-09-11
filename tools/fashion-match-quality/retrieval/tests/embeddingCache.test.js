'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeInputHash, cacheKey, getCached, putCached, embedWithCache } = require('../embeddingCache');

function tempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-cache-test-'));
}

test('CACHE: inputHash is deterministic for identical bytes and differs for different bytes', () => {
  assert.equal(computeInputHash('burgundy leather bomber jacket'), computeInputHash('burgundy leather bomber jacket'));
  assert.notEqual(computeInputHash('burgundy leather bomber jacket'), computeInputHash('navy leather bomber jacket'));
});

test('CACHE: cacheKey is deterministic and requires all three components', () => {
  const a = cacheKey({ inputHash: 'h1', modelRevision: 'r1', preprocessingVersion: 'p1' });
  const b = cacheKey({ inputHash: 'h1', modelRevision: 'r1', preprocessingVersion: 'p1' });
  assert.equal(a, b);
  assert.throws(() => cacheKey({ inputHash: 'h1', modelRevision: 'r1' }));
});

test('CACHE: a fresh key is a miss; after put, the same key is a hit with the stored embedding', () => {
  const cacheDir = tempCacheDir();
  try {
    const inputHash = computeInputHash('img-bytes-1');
    const args = { cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1' };
    assert.equal(getCached(args).hit, false);

    putCached({ ...args, embedding: [0.1, 0.2, 0.3], provider: 'TEST_PROVIDER' });
    const hit = getCached(args);
    assert.equal(hit.hit, true);
    assert.deepEqual(hit.embedding, [0.1, 0.2, 0.3]);
    assert.equal(hit.provider, 'TEST_PROVIDER');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('CACHE: a model revision change invalidates the cache entry (different key, miss)', () => {
  const cacheDir = tempCacheDir();
  try {
    const inputHash = computeInputHash('img-bytes-2');
    putCached({ cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1', embedding: [1, 0], provider: 'X' });
    const underNewRevision = getCached({ cacheDir, inputHash, modelRevision: 'rev-2', preprocessingVersion: 'prep-1' });
    assert.equal(underNewRevision.hit, false, 'a new model revision must never see the old revision\'s cached embedding');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('CACHE: a preprocessing version change invalidates the cache entry', () => {
  const cacheDir = tempCacheDir();
  try {
    const inputHash = computeInputHash('img-bytes-3');
    putCached({ cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1', embedding: [1, 0], provider: 'X' });
    const underNewPreprocessing = getCached({ cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-2' });
    assert.equal(underNewPreprocessing.hit, false, 'a preprocessing change must never see the old preprocessing\'s cached embedding');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('CACHE: a corrupt cache file on disk is treated as a miss, not a crash', () => {
  const cacheDir = tempCacheDir();
  try {
    const inputHash = computeInputHash('img-bytes-4');
    const key = cacheKey({ inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1' });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${key}.json`), '{not valid json');
    const result = getCached({ cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1' });
    assert.equal(result.hit, false);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('CACHE: embedWithCache calls embedFn on the first request and never again for the same input/revision/preprocessing', () => {
  const cacheDir = tempCacheDir();
  try {
    let calls = 0;
    const embedFn = (input) => {
      calls += 1;
      return { ok: true, embedding: [input.length, 0], provider: 'TEST_PROVIDER' };
    };
    const args = { cacheDir, input: 'a garment description', modelRevision: 'rev-1', preprocessingVersion: 'prep-1', embedFn };

    const first = embedWithCache(args);
    assert.equal(first.fromCache, false);
    assert.equal(calls, 1);

    const second = embedWithCache(args);
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1, 'embedFn must not be called again for an already-cached (input, revision, preprocessing) triple');
    assert.deepEqual(second.embedding, first.embedding);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('CACHE: embedWithCache propagates an embedFn failure without caching it', () => {
  const cacheDir = tempCacheDir();
  try {
    let calls = 0;
    const embedFn = () => {
      calls += 1;
      return { ok: false, blocker: 'TEST_BLOCKER', detail: 'deliberate failure' };
    };
    const args = { cacheDir, input: 'unembeddable', modelRevision: 'rev-1', preprocessingVersion: 'prep-1', embedFn };

    const first = embedWithCache(args);
    assert.equal(first.ok, false);
    assert.equal(first.blocker, 'TEST_BLOCKER');

    embedWithCache(args);
    assert.equal(calls, 2, 'a failed embed must not be cached, so the next call retries embedFn');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

/* ==================================================================== *
 * NEGATIVE CONTROL ANCHOR (spec section 18, "Model/cache mutant")
 *
 * This test is the permanent regression anchor for the model/cache
 * negative control recorded in the PR evidence: `cacheKey()` in
 * embeddingCache.js was temporarily changed to omit `modelRevision` from
 * the hashed string (`sha256(\`${inputHash}|${preprocessingVersion}\`)`
 * instead of including modelRevision), letting two distinct model
 * revisions collide on the same cache key for the same input. This suite
 * was rerun and shown to fail on exactly the assertion below (a cache
 * entry written under 'rev-1' was incorrectly served back for 'rev-2'),
 * then the mutation was reverted and the suite rerun green. See the PR
 * description's NEGATIVE CONTROL section.
 * ==================================================================== */

test('NEGATIVE CONTROL ANCHOR: two distinct model revisions embedding the identical input must never collide on one cache entry', () => {
  const cacheDir = tempCacheDir();
  try {
    const inputHash = computeInputHash('the same garment image bytes');
    putCached({ cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1', embedding: [1, 0, 0], provider: 'PROVIDER_A' });
    putCached({ cacheDir, inputHash, modelRevision: 'rev-2', preprocessingVersion: 'prep-1', embedding: [0, 1, 0], provider: 'PROVIDER_B' });

    const underRev1 = getCached({ cacheDir, inputHash, modelRevision: 'rev-1', preprocessingVersion: 'prep-1' });
    const underRev2 = getCached({ cacheDir, inputHash, modelRevision: 'rev-2', preprocessingVersion: 'prep-1' });

    assert.deepEqual(underRev1.embedding, [1, 0, 0], 'rev-1 must see only its own cached embedding');
    assert.deepEqual(underRev2.embedding, [0, 1, 0], 'rev-2 must see only its own cached embedding, never rev-1\'s');
    assert.notEqual(underRev1.key, underRev2.key, 'the two revisions must occupy different cache keys');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
