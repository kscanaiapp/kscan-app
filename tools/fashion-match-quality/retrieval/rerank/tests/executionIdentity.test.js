'use strict';

/**
 * Spec sections 6 and 13: real execution must be provable in parts, and the
 * stub/real boundary must reject an attempt to pass harness output off as
 * real-model evidence.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  deriveExecutionIdentity,
  assertRealModelEvidence,
  isImmutableRevision,
  NON_MODEL_PROVIDERS,
  REAL_PROVIDER,
} = require('../executionIdentity');
const stub = require('../../harnessStubEmbedder');
const descriptor = require('../visualDescriptorProbe');

const REAL_SHA = 'a'.repeat(40);

test('EXECUTION IDENTITY: a real run reports all five observations and derives REAL_FASHIONCLIP_EXECUTED', () => {
  const id = deriveExecutionIdentity({
    provider: REAL_PROVIDER,
    modelRevision: REAL_SHA,
    weightsLoaded: true,
    embeddingsProduced: 50,
    embeddingsUsedInRerank: 50,
    cacheRevisionValidated: true,
  });
  assert.strictEqual(id.MODEL_WEIGHTS_LOADED, true);
  assert.strictEqual(id.MODEL_EMBEDDINGS_PRODUCED, true);
  assert.strictEqual(id.EMBEDDINGS_USED_IN_RERANK, true);
  assert.strictEqual(id.RUN_ARTIFACT_MODEL_REVISION, REAL_SHA);
  assert.strictEqual(id.CACHE_REVISION_VALIDATED, true);
  assert.strictEqual(id.REAL_FASHIONCLIP_EXECUTED, true);
  assert.deepStrictEqual(id.unmetPreconditions, []);
});

test('EXECUTION IDENTITY: each precondition alone is enough to withhold the real-execution claim', () => {
  const base = {
    provider: REAL_PROVIDER,
    modelRevision: REAL_SHA,
    weightsLoaded: true,
    embeddingsProduced: 10,
    embeddingsUsedInRerank: 10,
    cacheRevisionValidated: true,
  };
  const mutations = [
    ['weightsLoaded', { weightsLoaded: false }],
    ['embeddingsProduced', { embeddingsProduced: 0 }],
    ['embeddingsUsedInRerank', { embeddingsUsedInRerank: 0 }],
    ['cacheRevisionValidated', { cacheRevisionValidated: false }],
    ['mutable revision', { modelRevision: 'main' }],
  ];
  for (const [label, mutation] of mutations) {
    const id = deriveExecutionIdentity({ ...base, ...mutation });
    assert.strictEqual(id.REAL_FASHIONCLIP_EXECUTED, false, `${label} should withhold the real-execution claim`);
    assert.ok(id.unmetPreconditions.length > 0, `${label} should name why`);
  }
});

test('IMMUTABLE REVISION: a mutable ref is never accepted as a pin', () => {
  assert.strictEqual(isImmutableRevision(REAL_SHA), true);
  for (const ref of ['main', 'master', 'HEAD', 'harness-stub-v1', '', null, undefined, 'abc123']) {
    assert.strictEqual(isImmutableRevision(ref), false, `${JSON.stringify(ref)} must not count as an immutable revision`);
  }
});

test('NEGATIVE CONTROL ANCHOR: harness-stub output cannot be presented as real-model evidence', () => {
  // The fraud this guard exists to stop: every optimistic flag set to true,
  // only the provider betraying that no model ran.
  const forged = deriveExecutionIdentity({
    provider: stub.PROVIDER,
    modelRevision: stub.STUB_REVISION,
    weightsLoaded: true,
    embeddingsProduced: 50,
    embeddingsUsedInRerank: 50,
    cacheRevisionValidated: true,
  });

  assert.strictEqual(forged.REAL_FASHIONCLIP_EXECUTED, false, 'a stub provider must never derive a real-execution claim');
  assert.throws(
    () => assertRealModelEvidence(forged, 'forged FashionCLIP efficacy claim'),
    /STUB_REAL_BOUNDARY_VIOLATION/,
    'the guard must refuse stub evidence',
  );
});

test('NEGATIVE CONTROL ANCHOR: the labelled visual descriptor is equally barred from real-model claims', () => {
  const forged = deriveExecutionIdentity({
    provider: descriptor.PROVIDER,
    modelRevision: REAL_SHA, // even paired with a real-looking revision
    weightsLoaded: true,
    embeddingsProduced: 50,
    embeddingsUsedInRerank: 50,
    cacheRevisionValidated: true,
  });
  assert.strictEqual(forged.REAL_FASHIONCLIP_EXECUTED, false);
  assert.throws(() => assertRealModelEvidence(forged), /STUB_REAL_BOUNDARY_VIOLATION/);
  assert.ok(NON_MODEL_PROVIDERS.includes(descriptor.PROVIDER));
  assert.ok(NON_MODEL_PROVIDERS.includes(stub.PROVIDER));
});

test('STUB/REAL BOUNDARY: the guard accepts genuine real-model evidence', () => {
  const genuine = deriveExecutionIdentity({
    provider: REAL_PROVIDER,
    modelRevision: REAL_SHA,
    weightsLoaded: true,
    embeddingsProduced: 1,
    embeddingsUsedInRerank: 1,
    cacheRevisionValidated: true,
  });
  assert.strictEqual(assertRealModelEvidence(genuine), true);
});
