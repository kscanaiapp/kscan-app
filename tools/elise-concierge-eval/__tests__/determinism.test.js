'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCorpus } = require('../metrics/corpusRunner');
const { hashCorpus, generateReport } = require('../reports/generateReport');
const { buildCoverageMatrix } = require('../metrics/coverageMatrix');
const { getFixtures } = require('../fixtures');

test('required test 2: corpus generation is deterministic', () => {
  const run1 = buildCorpus();
  const run2 = buildCorpus();
  assert.equal(hashCorpus(run1.cases), hashCorpus(run2.cases));
  assert.equal(run1.cases.length, run2.cases.length);
  assert.equal(run1.skipped.length, run2.skipped.length);
});

test('coverage matrix hash is deterministic across runs', () => {
  const fixtures = getFixtures();
  const { cases } = buildCorpus();
  const m1 = buildCoverageMatrix(cases, fixtures.scenariosById);
  const m2 = buildCoverageMatrix(cases, fixtures.scenariosById);
  assert.equal(m1.coverageMatrixHash, m2.coverageMatrixHash);
});

test('required test 29: two full report runs are canonical-hash identical', async () => {
  const r1 = await generateReport();
  const r2 = await generateReport();
  assert.equal(r1.reportContentHash, r2.reportContentHash);
  assert.notEqual(r1.generatedAt, undefined); // timestamp exists but is excluded from the hash
});
