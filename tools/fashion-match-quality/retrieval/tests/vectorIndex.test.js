'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cosineSimilarity, buildIndex, query } = require('../vectorIndex');

function candidate(id, embedding, modelRevision = 'rev-1') {
  return { candidateId: id, embedding, modelRevision };
}

test('VECTOR INDEX: cosineSimilarity is 1 for identical vectors and 0 for orthogonal vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test('VECTOR INDEX: rejects duplicate candidateId at build time', () => {
  assert.throws(() => buildIndex([candidate('A', [1, 0]), candidate('A', [0, 1])]), /duplicate candidateId/);
});

test('VECTOR INDEX: rejects a candidate with no embedding', () => {
  assert.throws(() => buildIndex([{ candidateId: 'A', embedding: [] }]), /no embedding/);
});

test('VECTOR INDEX: ranks candidates by similarity, best first', () => {
  const index = buildIndex([
    candidate('far', [0, 1]),
    candidate('close', [0.99, 0.14]),
    candidate('exact', [1, 0]),
  ]);
  const results = query(index, [1, 0], { topK: 3 });
  assert.deepEqual(results.map((r) => r.candidateId), ['exact', 'close', 'far']);
  assert.deepEqual(results.map((r) => r.rank), [1, 2, 3]);
});

test('VECTOR INDEX: Top-1/Top-5/Top-10 all supported via topK', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(`c${String(i).padStart(2, '0')}`, [1 - i * 0.01, i * 0.01]));
  const index = buildIndex(candidates);
  assert.equal(query(index, [1, 0], { topK: 1 }).length, 1);
  assert.equal(query(index, [1, 0], { topK: 5 }).length, 5);
  assert.equal(query(index, [1, 0], { topK: 10 }).length, 10);
});

test('VECTOR INDEX: every result carries candidateId, rank, similarityScore, and modelRevision', () => {
  const index = buildIndex([candidate('A', [1, 0], 'rev-xyz')]);
  const [result] = query(index, [1, 0], { topK: 1 });
  assert.equal(result.candidateId, 'A');
  assert.equal(result.rank, 1);
  assert.equal(typeof result.similarityScore, 'number');
  assert.equal(result.modelRevision, 'rev-xyz');
});

/* ==================================================================== *
 * NEGATIVE CONTROL ANCHOR (spec section 18, "Ranking determinism mutant")
 *
 * This test is the permanent regression anchor for the ranking-determinism
 * negative control recorded in the PR evidence: the stable secondary sort
 * key (`return a.candidateId < b.candidateId ? -1 : ...` in vectorIndex.js's
 * `query()`) was temporarily replaced with `return 0` (an unstable
 * comparator that lets Array.prototype.sort leave tied entries in
 * insertion order, which V8 preserves for small arrays - the mutation is
 * only reliably caught because this test constructs an input whose
 * insertion order disagrees with candidateId order). This suite was rerun
 * and shown to fail on exactly the assertion below, then the mutation was
 * reverted and the suite rerun green. See the PR description's NEGATIVE
 * CONTROL section.
 * ==================================================================== */

test('NEGATIVE CONTROL ANCHOR: tied similarity scores break stably by candidateId ascending, regardless of insertion order', () => {
  const tiedEmbedding = [1, 0];
  const index = buildIndex([
    candidate('zeta', tiedEmbedding),
    candidate('alpha', tiedEmbedding),
    candidate('mike', tiedEmbedding),
  ]);
  const results = query(index, [1, 0], { topK: 3 });
  assert.deepEqual(
    results.map((r) => r.candidateId),
    ['alpha', 'mike', 'zeta'],
    'tied candidates must sort by candidateId ascending, not by insertion order',
  );
});

test('DETERMINISM: repeated identical queries against the same index return identical ranked output', () => {
  const index = buildIndex([
    candidate('A', [0.7, 0.3]),
    candidate('B', [0.2, 0.8]),
    candidate('C', [0.5, 0.5]),
  ]);
  const first = query(index, [0.6, 0.4], { topK: 3 });
  const second = query(index, [0.6, 0.4], { topK: 3 });
  assert.deepEqual(first, second);
});
