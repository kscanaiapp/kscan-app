'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildRetrievalIndex, selectEmbedder } = require('../buildIndex');
const { PROVIDER: STUB_PROVIDER } = require('../harnessStubEmbedder');
const { query } = require('../vectorIndex');

function tempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-buildindex-test-'));
}

test('BUILD INDEX: selectEmbedder returns the stub in this sandbox (FashionCLIP is genuinely unavailable here)', () => {
  const choice = selectEmbedder();
  // This assertion documents the actual sandbox state rather than assuming
  // it - if a future environment has FashionCLIP available, this test
  // should be revisited, not silently left asserting a stale fact.
  assert.equal(choice.usingRealModel, false);
  assert.equal(choice.provider, STUB_PROVIDER);
});

test('BUILD INDEX: indexes every candidate across every FMQ fixture with no blockers under the stub embedder', () => {
  const cacheDir = tempCacheDir();
  try {
    const result = buildRetrievalIndex({ cacheDir });
    assert.ok(result.fixtureCount > 0, 'expected at least one FMQ fixture');
    assert.equal(result.candidateCount, result.entries.length);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.index.size, result.candidateCount);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('BUILD INDEX: every entry carries the required per-candidate metadata contract (spec section 7)', () => {
  const cacheDir = tempCacheDir();
  try {
    const result = buildRetrievalIndex({ cacheDir });
    for (const entry of result.entries) {
      assert.equal(typeof entry.candidateId, 'string');
      assert.equal(typeof entry.sourceFixtureId, 'string');
      assert.equal(typeof entry.corpusTier, 'string');
      assert.equal(typeof entry.imageIdentity.sha256, 'string');
      assert.equal(typeof entry.provider, 'string');
      assert.equal(typeof entry.modelRevision, 'string');
      assert.ok(Array.isArray(entry.embedding) && entry.embedding.length > 0);
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('BUILD INDEX: binds the Real Fashion Corpus V2 manifest hash and ontology version into the build record (spec section 12)', () => {
  const cacheDir = tempCacheDir();
  try {
    const result = buildRetrievalIndex({ cacheDir });
    assert.equal(typeof result.corpusV2.manifestHash, 'string');
    assert.ok(result.corpusV2.manifestHash.length > 0);
    assert.equal(result.corpusV2.ontologyVersion, 'canonical-fashion-attributes-v1');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('REPRODUCIBILITY: rebuilding from the same frozen inputs produces identical embeddings and is a 100% cache hit', () => {
  const cacheDir = tempCacheDir();
  try {
    const first = buildRetrievalIndex({ cacheDir });
    const second = buildRetrievalIndex({ cacheDir });

    assert.deepEqual(
      first.entries.map((e) => e.embedding),
      second.entries.map((e) => e.embedding),
    );
    assert.ok(second.entries.every((e) => e.fromCache === true), 'a second build must hit the cache for every candidate');
    assert.ok(first.entries.some((e) => e.fromCache === false), 'the first build must actually compute, not accidentally reuse a pre-seeded cache');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('BUILD INDEX: the resulting index is queryable end to end (a query against a known candidate ranks it first)', () => {
  const cacheDir = tempCacheDir();
  try {
    const result = buildRetrievalIndex({ cacheDir });
    const target = result.entries[0];
    const ranked = query(result.index, target.embedding, { topK: 5 });
    assert.equal(ranked[0].candidateId, target.candidateId, 'querying with a candidate\'s own embedding must rank that candidate first');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
