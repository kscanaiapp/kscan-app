'use strict';

/**
 * Spec section 12: "Real FashionCLIP embeddings must never reuse stub
 * embeddings... Do not allow HARNESS_STUB_NOT_FASHIONCLIP embeddings to be
 * served under a real-model cache identity. Add a focused test proving this
 * boundary."
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  cacheKey,
  getCached,
  putCached,
  embedWithCache,
  assertProviderRevisionCoherent,
  isImmutableModelRevision,
  NON_MODEL_PROVIDERS,
  REAL_MODEL_PROVIDER,
} = require('../../embeddingCache');
const executionIdentity = require('../executionIdentity');
const modelManifest = require('../../modelManifest');

const REAL_SHA = 'b'.repeat(40);
const STUB_PROVIDER = 'HARNESS_STUB_NOT_FASHIONCLIP';
const PREPROC = modelManifest.IMAGE_PREPROCESSING_VERSION;

function tmpCache() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-cache-boundary-'));
}

test('CACHE BOUNDARY: a stub embedding cannot be WRITTEN under a real model revision', () => {
  const cacheDir = tmpCache();
  assert.throws(
    () =>
      putCached({
        cacheDir,
        inputHash: 'deadbeef',
        modelRevision: REAL_SHA,
        preprocessingVersion: PREPROC,
        embedding: [1, 0, 0],
        provider: STUB_PROVIDER,
      }),
    /CACHE_IDENTITY_VIOLATION/,
    'writing harness-stub bytes under a real model revision must be refused',
  );
  assert.strictEqual(fs.readdirSync(cacheDir).length, 0, 'nothing may be persisted when the boundary is violated');
});

test('CACHE BOUNDARY: a real-model embedding cannot be written under a non-immutable revision', () => {
  const cacheDir = tmpCache();
  assert.throws(
    () =>
      putCached({
        cacheDir,
        inputHash: 'deadbeef',
        modelRevision: 'main',
        preprocessingVersion: PREPROC,
        embedding: [1, 0, 0],
        provider: REAL_MODEL_PROVIDER,
      }),
    /CACHE_IDENTITY_VIOLATION/,
  );
});

test('CACHE BOUNDARY: a stored entry whose provider differs is reported as a MISS, never served', () => {
  const cacheDir = tmpCache();
  putCached({
    cacheDir,
    inputHash: 'abc123',
    modelRevision: 'harness-stub-v1',
    preprocessingVersion: PREPROC,
    embedding: [0.5, 0.5],
    provider: STUB_PROVIDER,
  });

  const honest = getCached({ cacheDir, inputHash: 'abc123', modelRevision: 'harness-stub-v1', preprocessingVersion: PREPROC, expectedProvider: STUB_PROVIDER });
  assert.strictEqual(honest.hit, true, 'the stub may read back its own entry');

  const impostor = getCached({
    cacheDir,
    inputHash: 'abc123',
    modelRevision: 'harness-stub-v1',
    preprocessingVersion: PREPROC,
    expectedProvider: REAL_MODEL_PROVIDER,
  });
  assert.strictEqual(impostor.hit, false, 'a real-model caller must never be served a stub entry');
  assert.deepStrictEqual(impostor.providerMismatch, { expected: REAL_MODEL_PROVIDER, found: STUB_PROVIDER });
});

test('CACHE BOUNDARY: distinct model revisions never collide on one cache entry', () => {
  const a = cacheKey({ inputHash: 'same-input', modelRevision: REAL_SHA, preprocessingVersion: PREPROC });
  const b = cacheKey({ inputHash: 'same-input', modelRevision: 'harness-stub-v1', preprocessingVersion: PREPROC });
  assert.notStrictEqual(a, b, 'the same input under two revisions must occupy two cache entries');
});

test('CACHE BOUNDARY: an embedder that silently falls back to a stub is rejected, not cached', () => {
  const cacheDir = tmpCache();
  // A caller that believes it is running the real model, served by an
  // embedder that quietly returns stub output - the exact substitution the
  // provider boundary exists to catch.
  const result = embedWithCache({
    cacheDir,
    input: Buffer.from('some image bytes'),
    modelRevision: REAL_SHA,
    preprocessingVersion: PREPROC,
    expectedProvider: REAL_MODEL_PROVIDER,
    embedFn: () => ({ ok: true, embedding: [0.1, 0.2], provider: STUB_PROVIDER }),
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocker, 'PROVIDER_MISMATCH');
  assert.strictEqual(fs.readdirSync(cacheDir).length, 0, 'the mismatched embedding must not reach disk');
});

test('CACHE BOUNDARY: the cache and the execution-identity guard agree on which providers are not the model', () => {
  // These two lists live in separate modules by design (embeddingCache.js
  // stays dependency-free). This test is what keeps them from drifting apart.
  assert.deepStrictEqual([...NON_MODEL_PROVIDERS].sort(), [...executionIdentity.NON_MODEL_PROVIDERS].sort());
  assert.strictEqual(REAL_MODEL_PROVIDER, executionIdentity.REAL_PROVIDER);
});

test('CACHE BOUNDARY: coherence helper agrees with the revision-shape rule', () => {
  assert.strictEqual(isImmutableModelRevision(REAL_SHA), true);
  assert.strictEqual(isImmutableModelRevision('harness-stub-v1'), false);
  assert.strictEqual(assertProviderRevisionCoherent(STUB_PROVIDER, 'harness-stub-v1'), true);
  assert.strictEqual(assertProviderRevisionCoherent(REAL_MODEL_PROVIDER, REAL_SHA), true);
});
