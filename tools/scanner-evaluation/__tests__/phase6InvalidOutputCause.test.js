'use strict';

/**
 * Phase 6 — invalid-output cause attribution.
 *
 * Before this repair every failed case landed in `provider_output_invalid` with
 * `validation: null`, which made two opposite defects indistinguishable: a
 * response the model completed but shaped wrongly (a prompt defect) and a
 * response cut off at the output ceiling (a budget defect). A prompt-only
 * candidate can repair the first and can only worsen the second, so a benchmark
 * that cannot separate them cannot attribute a candidate's effect.
 *
 * These tests pin the classifier to the provider's own `finishReason` and prove
 * it refuses to guess when that field is absent.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { classifyInvalidOutputCause, buildCaseRecord } = require('../lib/liveAdapter');

const VALIDATION = { status: 'provider_output_invalid', stage: 'validation' };

function attempt(overrides = {}) {
  return {
    model: 'gemini-3.6-flash',
    httpStatus: 200,
    latencyMs: 9000,
    promptTokenCount: 1700,
    candidatesTokenCount: 70,
    totalTokenCount: 3733,
    thoughtsTokenCount: 1963,
    finishReason: null,
    errorCategory: null,
    certifiedFailureKind: null,
    ...overrides,
  };
}

test('MAX_TOKENS is attributed to the output budget, not to the prompt', () => {
  const cause = classifyInvalidOutputCause(VALIDATION, [attempt({ finishReason: 'MAX_TOKENS' })]);
  assert.equal(cause, 'output_budget_exhausted');
});

test('a completed generation that still fails validation is a prompt-side defect', () => {
  const cause = classifyInvalidOutputCause(VALIDATION, [attempt({ finishReason: 'STOP' })]);
  assert.equal(cause, 'malformed_despite_complete_generation');
});

test('safety and recitation terminations are never blamed on the prompt shape', () => {
  for (const reason of ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT']) {
    assert.equal(
      classifyInvalidOutputCause(VALIDATION, [attempt({ finishReason: reason })]),
      'provider_safety_block',
      `${reason} must classify as a safety block`,
    );
  }
  assert.equal(
    classifyInvalidOutputCause(VALIDATION, [attempt({ finishReason: 'RECITATION' })]),
    'provider_recitation_block',
  );
});

test('an absent finishReason degrades to unclassified rather than inferring truncation', () => {
  // Token accounting alone LOOKS like exhaustion here: 70 + 1963 = 2033 against
  // a 2048 certified ceiling. The classifier must still refuse, because
  // maxOutputTokens is a certified constant this module does not own and a
  // future certified change would silently turn the inference into a lie.
  const cause = classifyInvalidOutputCause(VALIDATION, [attempt({ finishReason: null })]);
  assert.equal(cause, 'unclassified');
});

test('a transport failure never acquires a parse-side cause', () => {
  const transport = { status: 'provider_timeout', stage: 'transport' };
  assert.equal(classifyInvalidOutputCause(transport, [attempt({ finishReason: 'MAX_TOKENS' })]), null);
});

test('an unknown finish reason is bucketed, not silently treated as malformed', () => {
  const cause = classifyInvalidOutputCause(VALIDATION, [attempt({ finishReason: 'OTHER' })]);
  assert.equal(cause, 'other_finish_reason');
});

test('the last attempt decides, so a retried case is attributed to what actually failed', () => {
  const attempts = [attempt({ finishReason: 'STOP' }), attempt({ finishReason: 'MAX_TOKENS' })];
  assert.equal(classifyInvalidOutputCause(VALIDATION, attempts), 'output_budget_exhausted');
});

test('finishReason and invalidOutputCause reach the persisted case record', () => {
  const record = buildCaseRecord({
    caseId: 'unit-case',
    report: {
      handlerLatencyMs: 9100,
      providerAttempts: [attempt({ finishReason: 'MAX_TOKENS' })],
      v2Present: false,
      observed: null,
      counters: { modelCalls: 1 },
    },
    runIdentityRecord: {
      runId: 'unit-run',
      datasetVersion: '0.3.1',
      datasetManifestSha256: 'x',
      holdoutSealSha256: null,
      sourceCommit: 'y',
      certifiedCommit: 'z',
      certifiedBundleHash: 'b',
      modelConfigurationId: 'certified-v140',
    },
    outcome: VALIDATION,
    attemptsUsed: 1,
    costUsd: 0.003,
  });

  assert.equal(record.providerAttempts[0].finishReason, 'MAX_TOKENS');
  assert.equal(record.invalidOutputCause, 'output_budget_exhausted');
  assert.equal(record.parseStatus, 'invalid');
});

test('the case record still carries no prompt, image, or raw provider text', () => {
  const record = buildCaseRecord({
    caseId: 'unit-case',
    report: {
      handlerLatencyMs: 1,
      providerAttempts: [attempt({ finishReason: 'MAX_TOKENS' })],
      v2Present: false,
      observed: null,
      counters: {},
    },
    runIdentityRecord: {
      runId: 'r', datasetVersion: '0.3.1', datasetManifestSha256: 'x',
      holdoutSealSha256: null, sourceCommit: 'y', certifiedCommit: 'z',
      certifiedBundleHash: 'b', modelConfigurationId: 'certified-v140',
    },
    outcome: VALIDATION,
    attemptsUsed: 1,
    costUsd: 0,
  });
  const serialized = JSON.stringify(record);
  for (const forbidden of ['rawModelText', 'imageBase64', 'apiKey', 'GEMINI_API_KEY']) {
    assert.ok(!serialized.includes(forbidden), `case record must not carry ${forbidden}`);
  }
});

test('the Deno harness captures finishReason on the live path', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'adapter', 'deno', 'certifiedHarness.ts'),
    'utf8',
  );
  assert.match(
    source,
    /finishReason\s*=\s*typeof rawFinishReason === 'string'/,
    'the live interceptor must read candidates[0].finishReason',
  );
  assert.match(source, /finishReason: string \| null;/, 'the attempt type must declare finishReason');
});
