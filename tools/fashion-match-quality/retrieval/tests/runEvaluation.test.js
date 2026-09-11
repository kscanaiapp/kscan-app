'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runFullEvaluation } = require('../runEvaluation');
const { validateReport } = require('../reportSchema');

function tempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-runeval-test-'));
}

test('RUN EVALUATION: produces a report that validates against reportSchema', () => {
  const cacheDir = tempCacheDir();
  try {
    const report = runFullEvaluation({ cacheDir });
    const result = validateReport(report);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN EVALUATION: is HARNESS_READY in this sandbox even though both arms are provider-blocked', () => {
  const cacheDir = tempCacheDir();
  try {
    const report = runFullEvaluation({ cacheDir });
    assert.equal(report.harnessReady, 'HARNESS_READY');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN EVALUATION: with 0 real cases, the decision fields are exactly the spec-mandated honest defaults', () => {
  const cacheDir = tempCacheDir();
  try {
    const report = runFullEvaluation({ cacheDir });
    assert.equal(report.realCaseCount, 0, 'precondition: this checkout\'s Real Fashion Corpus V2 has 0 real cases');
    assert.equal(report.realWorldEfficacyDecision, 'INSUFFICIENT_REAL_CORPUS');
    assert.equal(report.runtimePromotion, 'NOT_YET_EVALUABLE');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN EVALUATION: binds corpusManifestHash and ontologyVersion from the real Real Fashion Corpus V2 authority', () => {
  const cacheDir = tempCacheDir();
  try {
    const { loadCorpus, buildCorpusManifest } = require('../../../real-fashion-corpus/lib/corpusStore');
    const expectedManifest = buildCorpusManifest(loadCorpus({ validate: false }));

    const report = runFullEvaluation({ cacheDir });
    assert.equal(report.corpusManifestHash, expectedManifest.corpusHash);
    assert.equal(report.ontologyVersion, 'canonical-fashion-attributes-v1');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN EVALUATION: control and challenger arms are both reported, with blockers surfaced honestly rather than hidden', () => {
  const cacheDir = tempCacheDir();
  try {
    const report = runFullEvaluation({ cacheDir });
    assert.ok('control' in report.metrics);
    assert.ok('challenger' in report.metrics);
    // Neither arm's real backend is reachable in this sandbox (Deno / huggingface.co
    // are both unavailable here) - the report must say so, not silently omit it.
    assert.equal(report.metrics.controlBlocked, true);
    assert.equal(report.metrics.controlBlocker.blocker, 'DENO_UNAVAILABLE');
    assert.notEqual(report.modelProvider, 'FASHIONCLIP');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN EVALUATION: failure taxonomy breakdown and text->image sanity queries are both present and structurally complete', () => {
  const cacheDir = tempCacheDir();
  try {
    const report = runFullEvaluation({ cacheDir });
    assert.ok(Object.keys(report.metrics.failureTaxonomyBreakdown.counts).length > 0);
    assert.ok(report.metrics.textToImageSanityQueries.length > 0);
    for (const q of report.metrics.textToImageSanityQueries) assert.equal(typeof q.query, 'string');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN EVALUATION: is reproducible - two runs from the same frozen inputs produce identical metrics and hashes', () => {
  const cacheDir = tempCacheDir();
  try {
    const first = runFullEvaluation({ cacheDir });
    const second = runFullEvaluation({ cacheDir });
    assert.deepEqual(first.metrics, second.metrics);
    assert.equal(first.corpusManifestHash, second.corpusManifestHash);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('REPORT SCHEMA: refuses a report that fabricates real-world efficacy over an empty real corpus', () => {
  const result = validateReport({
    evaluationVersion: 'v',
    harnessReady: 'HARNESS_READY',
    realCaseCount: 0,
    realWorldEfficacyDecision: 'POSITIVE',
    runtimePromotion: 'APPROVED',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /fabricate real-world evidence/.test(e)));
});

test('REPORT SCHEMA: accepts a minimal well-formed HARNESS_NOT_READY report', () => {
  const result = validateReport({
    evaluationVersion: 'v',
    harnessReady: 'HARNESS_NOT_READY',
    realWorldEfficacyDecision: 'INSUFFICIENT_REAL_CORPUS',
    runtimePromotion: 'NOT_YET_EVALUABLE',
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});
