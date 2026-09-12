'use strict';

/**
 * EXECUTION IDENTITY (spec sections 6 and 13).
 *
 * "Do not reduce 'real execution' to one boolean."
 *
 * The failure mode this module exists to make impossible: a harness that ran
 * a stub embedder end-to-end, produced a plausible-looking ranking report,
 * and stamped `REAL_FASHIONCLIP_EXECUTED: true` on it because one variable
 * somewhere was set optimistically. A single boolean is exactly the shape of
 * claim that drifts from reality without anyone noticing, because nothing
 * about the number it sits next to changes when it becomes wrong.
 *
 * So real execution is decomposed into five INDEPENDENTLY OBSERVED facts,
 * each recorded by the component that actually observed it:
 *
 *   MODEL_WEIGHTS_LOADED      - the adapter reported loading real weights and
 *                               named the revision it loaded.
 *   MODEL_EMBEDDINGS_PRODUCED - at least one embedding came back tagged with
 *                               the real-model provider.
 *   EMBEDDINGS_USED_IN_RERANK - those embeddings are the ones the ranking was
 *                               actually computed from (not produced, logged,
 *                               and then quietly ignored in favour of a
 *                               fallback path).
 *   RUN_ARTIFACT_MODEL_REVISION - the emitted artifact carries an immutable
 *                               revision, not a mutable ref like 'main'.
 *   CACHE_REVISION_VALIDATED  - every embedding served from cache was stored
 *                               under that same real revision AND the real
 *                               provider (see embeddingCache.js's provider
 *                               boundary).
 *
 * `REAL_FASHIONCLIP_EXECUTED` is then a DERIVED conjunction - it is never
 * assignable. `deriveExecutionIdentity()` is the only way to obtain it, and
 * it computes it from the five observations rather than accepting it.
 *
 * NEGATIVE CONTROL (spec section 13): `assertRealModelEvidence()` is the
 * guard a report generator calls before claiming real-model efficacy. Feeding
 * it harness-stub evidence must fail loudly. That is proved permanently in
 * tests/executionIdentity.test.js, which attempts precisely that fraud and
 * asserts the guard rejects it.
 */

const stub = require('../harnessStubEmbedder');

/** Providers that are, by definition, NOT the real model. Anything appearing
 * here can never satisfy a real-execution claim, no matter what other fields
 * a caller sets. */
const NON_MODEL_PROVIDERS = Object.freeze([
  stub.PROVIDER, // 'HARNESS_STUB_NOT_FASHIONCLIP'
  'HARNESS_VISUAL_DESCRIPTOR_NOT_FASHIONCLIP',
]);

const REAL_PROVIDER = 'FASHIONCLIP';

/** A mutable git ref is not a pin. Spec section 5 asks for an IMMUTABLE
 * revision; 'main' moves under you and would make a run unreproducible. */
const MUTABLE_REFS = Object.freeze(['main', 'master', 'HEAD', 'refs/heads/main']);

function isImmutableRevision(revision) {
  if (typeof revision !== 'string' || revision.length === 0) return false;
  if (MUTABLE_REFS.includes(revision)) return false;
  // huggingface_hub resolves a ref to a 40-hex git commit SHA.
  return /^[0-9a-f]{40}$/.test(revision);
}

function isRealProvider(provider) {
  return provider === REAL_PROVIDER;
}

/**
 * Derive the full execution-identity block from independently observed facts.
 *
 * @param {object} observations
 * @param {string} observations.provider          - provider tag the embeddings actually carry
 * @param {string|null} observations.modelRevision - revision the embeddings were produced under
 * @param {boolean} observations.weightsLoaded     - adapter reported real weights loaded
 * @param {number} observations.embeddingsProduced - count of embeddings produced this run
 * @param {number} observations.embeddingsUsedInRerank - count actually consumed by the ranking
 * @param {boolean} observations.cacheRevisionValidated - cache entries verified against provider+revision
 */
function deriveExecutionIdentity({
  provider,
  modelRevision,
  weightsLoaded = false,
  embeddingsProduced = 0,
  embeddingsUsedInRerank = 0,
  cacheRevisionValidated = false,
} = {}) {
  const realProvider = isRealProvider(provider);

  const MODEL_WEIGHTS_LOADED = Boolean(weightsLoaded) && realProvider;
  const MODEL_EMBEDDINGS_PRODUCED = realProvider && embeddingsProduced > 0;
  const EMBEDDINGS_USED_IN_RERANK = realProvider && embeddingsUsedInRerank > 0;
  const RUN_ARTIFACT_MODEL_REVISION = realProvider && isImmutableRevision(modelRevision) ? modelRevision : null;
  const CACHE_REVISION_VALIDATED = Boolean(cacheRevisionValidated) && realProvider;

  const REAL_FASHIONCLIP_EXECUTED =
    MODEL_WEIGHTS_LOADED &&
    MODEL_EMBEDDINGS_PRODUCED &&
    EMBEDDINGS_USED_IN_RERANK &&
    RUN_ARTIFACT_MODEL_REVISION !== null &&
    CACHE_REVISION_VALIDATED;

  // Why it is not YES - enumerated, so a blocked run explains itself instead
  // of leaving a reader to guess which precondition failed.
  const unmetPreconditions = [];
  if (!realProvider) unmetPreconditions.push(`PROVIDER_IS_NOT_REAL_MODEL:${provider}`);
  if (!MODEL_WEIGHTS_LOADED) unmetPreconditions.push('MODEL_WEIGHTS_NOT_LOADED');
  if (!MODEL_EMBEDDINGS_PRODUCED) unmetPreconditions.push('NO_REAL_MODEL_EMBEDDINGS_PRODUCED');
  if (!EMBEDDINGS_USED_IN_RERANK) unmetPreconditions.push('NO_REAL_MODEL_EMBEDDINGS_USED_IN_RERANK');
  if (RUN_ARTIFACT_MODEL_REVISION === null) {
    unmetPreconditions.push(
      isImmutableRevision(modelRevision) ? 'REVISION_PRESENT_BUT_PROVIDER_NOT_REAL' : `MODEL_REVISION_NOT_IMMUTABLE:${modelRevision}`,
    );
  }
  if (!CACHE_REVISION_VALIDATED) unmetPreconditions.push('CACHE_REVISION_NOT_VALIDATED');

  return {
    provider,
    MODEL_WEIGHTS_LOADED,
    MODEL_EMBEDDINGS_PRODUCED,
    EMBEDDINGS_USED_IN_RERANK,
    RUN_ARTIFACT_MODEL_REVISION,
    CACHE_REVISION_VALIDATED,
    REAL_FASHIONCLIP_EXECUTED,
    unmetPreconditions: REAL_FASHIONCLIP_EXECUTED ? [] : unmetPreconditions,
  };
}

/**
 * THE NEGATIVE-CONTROL GUARD (spec section 13).
 *
 * Call this immediately before any code path that would present a result as
 * real-model evidence. It throws - deliberately, rather than returning a
 * falsy value a caller could ignore - when the evidence is not real.
 *
 * @throws {Error} with a message naming the exact reason the claim is refused
 */
function assertRealModelEvidence(executionIdentity, context = 'real-model evidence') {
  if (!executionIdentity || typeof executionIdentity !== 'object') {
    throw new Error(`STUB_REAL_BOUNDARY_VIOLATION: ${context} requires an execution identity block, got ${typeof executionIdentity}`);
  }
  if (NON_MODEL_PROVIDERS.includes(executionIdentity.provider)) {
    throw new Error(
      `STUB_REAL_BOUNDARY_VIOLATION: ${context} was claimed from provider '${executionIdentity.provider}', ` +
        'which is explicitly not FashionCLIP. Harness-stub output may never be presented as real-model evidence.',
    );
  }
  if (executionIdentity.REAL_FASHIONCLIP_EXECUTED !== true) {
    throw new Error(
      `STUB_REAL_BOUNDARY_VIOLATION: ${context} was claimed without REAL_FASHIONCLIP_EXECUTED. ` +
        `Unmet preconditions: ${(executionIdentity.unmetPreconditions || []).join(', ') || 'unspecified'}`,
    );
  }
  return true;
}

module.exports = {
  REAL_PROVIDER,
  NON_MODEL_PROVIDERS,
  MUTABLE_REFS,
  isImmutableRevision,
  isRealProvider,
  deriveExecutionIdentity,
  assertRealModelEvidence,
};
