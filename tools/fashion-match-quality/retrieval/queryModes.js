'use strict';

/**
 * Query modes (spec section 11).
 *
 * IMAGE -> IMAGE is the primary K Scan experiment: embed a garment query
 * image, retrieve the nearest product images from the index. This is the
 * mode Scanner would actually use if this lab is ever promoted.
 *
 * TEXT -> IMAGE uses ONLY canonical ontology terms from
 * `tools/fashion-ontology/` (verified real vocabulary members, not invented
 * strings - see CANONICAL_TEXT_QUERIES below) or FMQ's own controlled
 * fashion vocabulary. Free-form customer text is explicitly out of scope
 * (spec section 11) - this mode exists only to sanity-check whether the
 * embedder's semantic space is fashion-consistent at all, e.g. whether
 * "burgundy leather bomber jacket" retrieves fashion-consistent candidates.
 *
 * IMPORTANT LIMITATION, stated once here rather than at every call site:
 * text->image semantic alignment is a property of a TRAINED joint
 * image/text embedding space. The harness stub embedder
 * (harnessStubEmbedder.js) has no such space - it is expanded hash output,
 * so a text query and an unrelated image's embedding are uncorrelated by
 * construction. Running this mode against the stub proves the QUERY PATH
 * works mechanically (embed text, search the index, return ranked results);
 * it proves NOTHING about semantic retrieval quality, which requires the
 * real FashionCLIP model this session cannot reach (see
 * fashionClipAdapter.js's header). The evaluation report's `limitations`
 * field says this explicitly.
 */

const { embedImageBuffer, embedTextString } = require('./buildIndex');
const { syntheticImageFor } = require('./syntheticImageSource');
const { query } = require('./vectorIndex');
const modelManifest = require('./modelManifest');
const { embedWithCache, DEFAULT_CACHE_DIR } = require('./embeddingCache');

// Verified against tools/fashion-ontology's real canonical vocabulary
// (colors.js / materials.js / categories.js), never invented:
//   burgundy  -> colors.js value 'burgundy' (family 'red')
//   navy      -> colors.js value 'navy' (family 'blue')
//   black     -> colors.js value 'black' (family 'black')
//   leather   -> materials.js value 'leather'
//   wool      -> materials.js value 'wool'
//   bomber jacket -> categories.js subtype 'bomber_jacket' (outerwear)
//   blazer    -> categories.js subtype 'blazer' (outerwear)
//   sneaker   -> categories.js subtype 'sneaker' (footwear)
const CANONICAL_TEXT_QUERIES = Object.freeze([
  'burgundy leather bomber jacket',
  'navy wool blazer',
  'black leather sneaker',
]);

function imageToImageQuery(index, queryImageId, embedderChoice, { cacheDir = DEFAULT_CACHE_DIR, topK = 10 } = {}) {
  const imageBytes = syntheticImageFor(queryImageId);
  const embedResult = embedWithCache({
    cacheDir,
    input: imageBytes,
    modelRevision: embedderChoice.modelRevision,
    preprocessingVersion: modelManifest.IMAGE_PREPROCESSING_VERSION,
    embedFn: (buf) => embedImageBuffer(buf, embedderChoice),
  });
  if (!embedResult.ok) return embedResult;
  return { ok: true, mode: 'image_to_image', queryId: queryImageId, results: query(index, embedResult.embedding, { topK }) };
}

function textToImageQuery(index, text, embedderChoice, { cacheDir = DEFAULT_CACHE_DIR, topK = 10 } = {}) {
  const embedResult = embedWithCache({
    cacheDir,
    input: text,
    modelRevision: embedderChoice.modelRevision,
    preprocessingVersion: modelManifest.TEXT_PREPROCESSING_VERSION,
    embedFn: (t) => embedTextString(t, embedderChoice),
  });
  if (!embedResult.ok) return embedResult;
  return { ok: true, mode: 'text_to_image', query: text, results: query(index, embedResult.embedding, { topK }) };
}

module.exports = { imageToImageQuery, textToImageQuery, CANONICAL_TEXT_QUERIES };
