'use strict';

/**
 * Spec sections 7 and 8: the re-ranker must return a PERMUTATION of exactly
 * the candidates L1 handed it, under a stable deterministic sort.
 */

const test = require('node:test');
const assert = require('node:assert');

const { rerank, describeMovement, l1RankScore, STRATEGY_PURE_VISUAL, STRATEGY_BLENDED } = require('../visualReranker');

const QUERY = [1, 0, 0];
function candidate(id, embedding, l1Rank) {
  return { candidateId: id, embedding, l1Rank };
}

test('RERANK: promotes the visually closer candidate above L1 order', () => {
  const result = rerank({
    queryEmbedding: QUERY,
    candidates: [candidate('far', [0, 1, 0], 1), candidate('near', [1, 0, 0], 2)],
  });
  assert.deepStrictEqual(result.rankedCandidateIds, ['near', 'far']);
});

test('RERANK: output is always a permutation of the input set - nothing added, dropped or duplicated', () => {
  const ids = ['e', 'a', 'd', 'b', 'c'];
  const candidates = ids.map((id, i) => candidate(id, [Math.random(), Math.random(), Math.random()], i + 1));
  const result = rerank({ queryEmbedding: QUERY, candidates });
  assert.deepStrictEqual([...result.rankedCandidateIds].sort(), [...ids].sort());
  assert.strictEqual(result.rankedCandidateIds.length, ids.length);
});

test('RERANK: a candidate with no usable image is ranked last, never dropped', () => {
  const result = rerank({
    queryEmbedding: QUERY,
    candidates: [candidate('noimage', null, 1), candidate('far', [0, 1, 0], 2), candidate('near', [1, 0, 0], 3)],
  });
  assert.deepStrictEqual(result.rankedCandidateIds, ['near', 'far', 'noimage']);
  assert.strictEqual(result.unscorableCount, 1);
  assert.strictEqual(result.scorableCount, 2);
});

test('RERANK: several unscorable candidates keep their relative L1 order among themselves', () => {
  const result = rerank({
    queryEmbedding: QUERY,
    candidates: [candidate('z-no', null, 1), candidate('a-no', null, 2), candidate('yes', [1, 0, 0], 3)],
  });
  assert.deepStrictEqual(result.rankedCandidateIds, ['yes', 'z-no', 'a-no']);
});

test('NEGATIVE CONTROL ANCHOR: on a similarity tie the re-ranker preserves L1 order rather than reshuffling', () => {
  // Both candidates are visually identical to the query, so FashionCLIP has
  // no opinion. L1 - which knows brand, stock and retailer trust - must win.
  // A candidateId-only tie-break would wrongly put 'aaa' first.
  const result = rerank({
    queryEmbedding: QUERY,
    candidates: [candidate('zzz', [1, 0, 0], 1), candidate('aaa', [1, 0, 0], 2)],
  });
  assert.deepStrictEqual(result.rankedCandidateIds, ['zzz', 'aaa'], 'L1 order must survive a visual tie');
});

test('DETERMINISM: identical inputs produce byte-identical rankings regardless of input order', () => {
  const base = [candidate('a', [0.9, 0.1, 0], 1), candidate('b', [0.5, 0.5, 0], 2), candidate('c', [0.1, 0.9, 0], 3)];
  const first = rerank({ queryEmbedding: QUERY, candidates: base });
  const again = rerank({ queryEmbedding: QUERY, candidates: base });
  assert.deepStrictEqual(first.rankedCandidateIds, again.rankedCandidateIds);
  assert.strictEqual(JSON.stringify(first.scored), JSON.stringify(again.scored));
});

test('DETERMINISM: a fully tied set is ordered by L1 rank, not by array position', () => {
  const tied = (order) => order.map(([id, rank]) => candidate(id, [1, 0, 0], rank));
  const a = rerank({ queryEmbedding: QUERY, candidates: tied([['x', 3], ['y', 1], ['z', 2]]) });
  const b = rerank({ queryEmbedding: QUERY, candidates: tied([['z', 2], ['x', 3], ['y', 1]]) });
  assert.deepStrictEqual(a.rankedCandidateIds, ['y', 'z', 'x']);
  assert.deepStrictEqual(a.rankedCandidateIds, b.rankedCandidateIds);
});

test('BLENDED STRATEGY: weighting L1 in can hold a marginally-closer candidate below a strong L1 result', () => {
  const candidates = [candidate('l1Favourite', [0.96, 0.28, 0], 1), candidate('slightlyCloser', [1, 0, 0], 2)];

  const pure = rerank({ queryEmbedding: QUERY, candidates, strategy: STRATEGY_PURE_VISUAL });
  assert.deepStrictEqual(pure.rankedCandidateIds, ['slightlyCloser', 'l1Favourite']);

  const blended = rerank({ queryEmbedding: QUERY, candidates, strategy: STRATEGY_BLENDED, visualWeight: 0.2 });
  assert.deepStrictEqual(blended.rankedCandidateIds, ['l1Favourite', 'slightlyCloser']);
});

test('RERANK: invalid inputs are refused rather than silently coerced', () => {
  assert.throws(() => rerank({ queryEmbedding: [], candidates: [] }), /non-empty queryEmbedding/);
  assert.throws(() => rerank({ queryEmbedding: QUERY, candidates: 'nope' }), /candidates array/);
  assert.throws(() => rerank({ queryEmbedding: QUERY, candidates: [], strategy: 'MYSTERY' }), /unknown strategy/);
  assert.throws(
    () => rerank({ queryEmbedding: QUERY, candidates: [], strategy: STRATEGY_BLENDED, visualWeight: 5 }),
    /visualWeight/,
  );
});

test('L1 RANK SCORE: rank 1 scores 1, last rank scores 0, single candidate scores 1', () => {
  assert.strictEqual(l1RankScore(1, 5), 1);
  assert.strictEqual(l1RankScore(5, 5), 0);
  assert.strictEqual(l1RankScore(1, 1), 1);
});

test('MOVEMENT: rank movement is reported per candidate, positive meaning promoted', () => {
  const movement = describeMovement(['a', 'b', 'c'], ['c', 'a', 'b']);
  assert.strictEqual(movement.changedTop1, true);
  assert.strictEqual(movement.identicalOrder, false);
  assert.strictEqual(movement.moves.find((m) => m.candidateId === 'c').movement, 2);
  assert.strictEqual(movement.maxUpwardMovement, 2);
  assert.strictEqual(movement.maxDownwardMovement, -1);
  assert.strictEqual(describeMovement(['a', 'b'], ['a', 'b']).identicalOrder, true);
});
