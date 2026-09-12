'use strict';

/**
 * HARNESS STUB EMBEDDER - THIS IS NOT FASHIONCLIP.
 *
 * This module exists for exactly one reason: `fashionClipAdapter.js` cannot
 * run in this R&D session (huggingface.co is network-policy-blocked here -
 * see modelManifest.js's header), so there is no way to produce a real
 * visual-similarity embedding in this environment. Without SOME embedder,
 * embeddingCache.js, vectorIndex.js, retrievalEvaluator.js, the determinism
 * proof, and both negative controls would be untestable, which is worse than
 * testing them against an honestly-labeled stand-in.
 *
 * What this produces is a DETERMINISTIC, CONTENT-DERIVED, unit-norm vector -
 * same dimensionality as real FashionCLIP output (modelManifest.js's
 * EMBEDDING_DIMENSION) so downstream code is dimension-compatible - built
 * from a SHA-256 hash stream over the raw input bytes/text. It carries NO
 * visual or semantic understanding whatsoever: it is expanded hash output,
 * not a trained model's representation. Retrieval quality numbers produced
 * against this embedder measure ONLY whether the harness plumbing (cache,
 * index, ranking, tie-breaking, evaluator wiring) behaves correctly. They
 * are not evidence, weak or strong, about FashionCLIP's actual retrieval
 * quality, and must never be reported as such.
 *
 * Every output is stamped `provider: 'HARNESS_STUB_NOT_FASHIONCLIP'` and
 * `modelRevision: STUB_REVISION` specifically so a downstream report, cache
 * entry, or index record can never be mistaken for real model output - and
 * so that a genuine FashionCLIP run (different revision string) invalidates
 * every cache entry a stub run produced, per embeddingCache.js's cache-key
 * contract.
 */

const crypto = require('node:crypto');
const { EMBEDDING_DIMENSION } = require('./modelManifest');

const PROVIDER = 'HARNESS_STUB_NOT_FASHIONCLIP';
const STUB_REVISION = 'harness-stub-v1';

/** Expand `seed` into `dimension` pseudo-random floats in [-1, 1] via a SHA-256 hash stream (a simple, fully deterministic, dependency-free PRNG). */
function expandSeed(seed, dimension) {
  const values = [];
  let counter = 0;
  while (values.length < dimension) {
    const block = crypto.createHash('sha256').update(seed).update(Buffer.from([counter & 0xff, (counter >> 8) & 0xff])).digest();
    for (let i = 0; i + 4 <= block.length && values.length < dimension; i += 4) {
      const int = block.readUInt32BE(i);
      values.push((int / 0xffffffff) * 2 - 1);
    }
    counter += 1;
  }
  return values;
}

function l2Normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector.slice();
  return vector.map((v) => v / norm);
}

/** @param {Buffer|string} input @returns {number[]} unit-norm vector, length EMBEDDING_DIMENSION */
function stubEmbed(input) {
  const seed = crypto.createHash('sha256').update(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')).digest();
  return l2Normalize(expandSeed(seed, EMBEDDING_DIMENSION));
}

function embedBatch(inputs) {
  return { ok: true, provider: PROVIDER, modelRevision: STUB_REVISION, embeddings: inputs.map(stubEmbed) };
}

function embedImages(imageBuffers) {
  return embedBatch(imageBuffers);
}

function embedTexts(texts) {
  return embedBatch(texts);
}

function isStubAvailable() {
  return true;
}

module.exports = {
  PROVIDER,
  STUB_REVISION,
  isStubAvailable,
  embedImages,
  embedTexts,
  stubEmbed,
};
