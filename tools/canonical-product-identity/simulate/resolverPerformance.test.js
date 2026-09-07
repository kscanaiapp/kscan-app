'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { synthesizeOfferSet, benchmarkSize, runResolverPerformanceSuite } = require('./resolverPerformance');

// spec section 43#23 (resolver determinism) applied specifically at
// realistic candidate-set sizes, plus section 30 P50/P95/memory/determinism.
test('RESOLVER PERFORMANCE: synthesizeOfferSet is deterministic for a fixed seed', () => {
  const a = synthesizeOfferSet(20, 'perf-test-seed');
  const b = synthesizeOfferSet(20, 'perf-test-seed');
  assert.equal(JSON.stringify(a.offers), JSON.stringify(b.offers));
});

test('RESOLVER PERFORMANCE: benchmarkSize reports P50/P95/memory and confirms determinism across repetitions', () => {
  const result = benchmarkSize(20, { repetitions: 3 });
  assert.equal(result.candidateSetSize, 20);
  assert.ok(result.p50Ms >= 0);
  assert.ok(result.p95Ms >= result.p50Ms);
  assert.equal(result.deterministic, true);
  assert.equal(result.timingClass, "OBSERVED - offline wall-clock time on this lab's own run, not a production latency measurement");
});

test('RESOLVER PERFORMANCE: pairCount matches C(n,2) for the requested candidate-set size', () => {
  const result = benchmarkSize(10, { repetitions: 2 });
  assert.equal(result.pairCount, (10 * 9) / 2);
});

// spec section 30: candidate-set sizes 10/50/200/500.
test('RESOLVER PERFORMANCE: the full suite covers every required candidate-set size and stays deterministic at each', () => {
  const results = runResolverPerformanceSuite({ sizes: [10, 50, 200, 500], repetitions: 3 });
  assert.equal(results.length, 4);
  assert.deepEqual(results.map((r) => r.candidateSetSize), [10, 50, 200, 500]);
  for (const r of results) assert.equal(r.deterministic, true);
});
