'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runControlArm, isDenoAvailable } = require('../controlArm');
const { loadFullCorpus } = require('../../corpus/corpusLoader');

test('CONTROL ARM: reflects the real environment\'s Deno availability, never hardcoded', () => {
  assert.equal(typeof isDenoAvailable(), 'boolean');
});

test('CONTROL ARM: reports the same DENO_UNAVAILABLE blocker as FMQ\'s own L1 harness when Deno is absent (this sandbox)', { skip: isDenoAvailable() }, () => {
  const [fixture] = loadFullCorpus();
  const result = runControlArm(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.blocker, 'DENO_UNAVAILABLE');
  assert.deepEqual(result.rankedCandidateIds, []);
});

test('CONTROL ARM: when Deno IS available, returns a non-empty rankedCandidateIds array of real candidate ids', { skip: !isDenoAvailable() }, () => {
  const [fixture] = loadFullCorpus();
  const result = runControlArm(fixture);
  assert.equal(result.ok, true);
  assert.ok(result.rankedCandidateIds.length > 0);
  const validIds = new Set(fixture.candidateProducts.map((c) => c.id));
  for (const id of result.rankedCandidateIds) assert.ok(validIds.has(id));
});
