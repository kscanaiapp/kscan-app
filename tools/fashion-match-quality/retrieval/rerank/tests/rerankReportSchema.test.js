'use strict';

/**
 * The report schema's job is to make an overclaiming report structurally
 * impossible, not merely discouraged (spec sections 4, 6, 8, 13, 20).
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateRerankReport } = require('../rerankReportSchema');

const REAL_SHA = 'c'.repeat(40);

function baseReport(overrides = {}) {
  return {
    reportVersion: 'fashionclip-rerank-report-v1',
    generatedAt: new Date().toISOString(),
    conclusion: 'ENVIRONMENT_BLOCKED',
    evidenceClass: 'MECHANISM_CHECK',
    executionIdentity: {
      provider: 'HARNESS_STUB_NOT_FASHIONCLIP',
      MODEL_WEIGHTS_LOADED: false,
      MODEL_EMBEDDINGS_PRODUCED: false,
      EMBEDDINGS_USED_IN_RERANK: false,
      RUN_ARTIFACT_MODEL_REVISION: null,
      CACHE_REVISION_VALIDATED: false,
      REAL_FASHIONCLIP_EXECUTED: false,
      unmetPreconditions: ['MODEL_WEIGHTS_NOT_LOADED'],
    },
    candidateUniverse: { CONTROL_UNIVERSE_HASH: 'aaa', CHALLENGER_UNIVERSE_HASH: 'aaa', identical: true },
    corpusCensus: { REAL: 0, SANITIZED_REAL: 0, SYNTHETIC: 10 },
    evaluatorStatus: { COLOR_METRIC: 'REPAIRED_AND_DISCRIMINATIVE' },
    limitations: ['no real model executed'],
    ...overrides,
  };
}

test('REPORT SCHEMA: an honest environment-blocked report validates', () => {
  const { valid, errors } = validateRerankReport(baseReport());
  assert.strictEqual(valid, true, errors.join('; '));
});

test('NEGATIVE CONTROL ANCHOR: a model-claiming conclusion is refused without a real model run', () => {
  for (const conclusion of ['PROMISING_CONTINUE_R&D', 'NO_USEFUL_SIGNAL']) {
    const { valid, errors } = validateRerankReport(baseReport({ conclusion }));
    assert.strictEqual(valid, false, `${conclusion} must not be reachable without real execution`);
    assert.ok(errors.some((e) => e.includes('is a claim about FashionCLIP')), errors.join('; '));
  }
});

test('REPORT SCHEMA: INSUFFICIENT_EVIDENCE and ENVIRONMENT_BLOCKED remain available without a real model run', () => {
  for (const conclusion of ['INSUFFICIENT_EVIDENCE', 'ENVIRONMENT_BLOCKED']) {
    assert.strictEqual(validateRerankReport(baseReport({ conclusion })).valid, true);
  }
});

test('NEGATIVE CONTROL ANCHOR: harness output cannot be labelled RETRIEVAL_QUALITY_EVIDENCE', () => {
  const { valid, errors } = validateRerankReport(baseReport({ evidenceClass: 'RETRIEVAL_QUALITY_EVIDENCE' }));
  assert.strictEqual(valid, false);
  assert.ok(errors.some((e) => e.includes('may not be presented as retrieval-quality evidence')));
});

test('NEGATIVE CONTROL ANCHOR: REAL_FASHIONCLIP_EXECUTED cannot be asserted while its components are false', () => {
  const forged = baseReport({
    conclusion: 'PROMISING_CONTINUE_R&D',
    evidenceClass: 'RETRIEVAL_QUALITY_EVIDENCE',
    executionIdentity: {
      provider: 'FASHIONCLIP',
      MODEL_WEIGHTS_LOADED: false,
      MODEL_EMBEDDINGS_PRODUCED: false,
      EMBEDDINGS_USED_IN_RERANK: false,
      RUN_ARTIFACT_MODEL_REVISION: null,
      CACHE_REVISION_VALIDATED: false,
      REAL_FASHIONCLIP_EXECUTED: true, // the lie
    },
  });
  const { valid, errors } = validateRerankReport(forged);
  assert.strictEqual(valid, false);
  assert.ok(errors.some((e) => e.includes('MODEL_WEIGHTS_LOADED')));
  assert.ok(errors.some((e) => e.includes('RUN_ARTIFACT_MODEL_REVISION')));
});

test('REPORT SCHEMA: a real run with a mutable ref is refused - a pin must be immutable', () => {
  const report = baseReport({
    executionIdentity: {
      provider: 'FASHIONCLIP',
      MODEL_WEIGHTS_LOADED: true,
      MODEL_EMBEDDINGS_PRODUCED: true,
      EMBEDDINGS_USED_IN_RERANK: true,
      RUN_ARTIFACT_MODEL_REVISION: 'main',
      CACHE_REVISION_VALIDATED: true,
      REAL_FASHIONCLIP_EXECUTED: true,
    },
  });
  const { valid, errors } = validateRerankReport(report);
  assert.strictEqual(valid, false);
  assert.ok(errors.some((e) => e.includes('immutable 40-hex commit SHA')));
});

test('REPORT SCHEMA: a fully genuine real-model report validates and may claim quality evidence', () => {
  const report = baseReport({
    conclusion: 'PROMISING_CONTINUE_R&D',
    evidenceClass: 'RETRIEVAL_QUALITY_EVIDENCE',
    corpusCensus: { REAL: 40, SANITIZED_REAL: 0, SYNTHETIC: 10 },
    executionIdentity: {
      provider: 'FASHIONCLIP',
      MODEL_WEIGHTS_LOADED: true,
      MODEL_EMBEDDINGS_PRODUCED: true,
      EMBEDDINGS_USED_IN_RERANK: true,
      RUN_ARTIFACT_MODEL_REVISION: REAL_SHA,
      CACHE_REVISION_VALIDATED: true,
      REAL_FASHIONCLIP_EXECUTED: true,
    },
  });
  const { valid, errors } = validateRerankReport(report);
  assert.strictEqual(valid, true, errors.join('; '));
});

test('NEGATIVE CONTROL ANCHOR: mismatched universe hashes cannot be reported as a valid comparison', () => {
  const { valid, errors } = validateRerankReport(
    baseReport({ candidateUniverse: { CONTROL_UNIVERSE_HASH: 'aaa', CHALLENGER_UNIVERSE_HASH: 'bbb', identical: true } }),
  );
  assert.strictEqual(valid, false);
  assert.ok(errors.some((e) => e.includes('invalid until repaired')));
});

test('REPORT SCHEMA: an empty limitations list is refused', () => {
  const { valid, errors } = validateRerankReport(baseReport({ limitations: [] }));
  assert.strictEqual(valid, false);
  assert.ok(errors.some((e) => e.includes('limitations must not be an empty list')));
});

test('REPORT SCHEMA: unknown conclusions and evidence classes are refused', () => {
  assert.strictEqual(validateRerankReport(baseReport({ conclusion: 'SHIP_IT' })).valid, false);
  assert.strictEqual(validateRerankReport(baseReport({ evidenceClass: 'PROOF' })).valid, false);
  assert.strictEqual(validateRerankReport(null).valid, false);
});
