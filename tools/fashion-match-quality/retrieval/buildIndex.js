'use strict';

/**
 * Build the R&D retrieval index (spec sections 7, 8, 12).
 *
 * Candidate universe: FMQ's own deterministic fixture corpus
 * (`corpus/corpusLoader.js#loadFullCorpus()` - the committed synthetic
 * fixtures plus any approved-real ones, currently none). This is "the
 * candidate-product universe already available through the deterministic
 * FMQ/Corpus replay fixtures" the spec asks for - Real Fashion Corpus V2
 * itself has 0 real cases on this checkout (see
 * tools/real-fashion-corpus/docs/DESIGN.md DM-12), so it contributes no
 * candidates, but its manifest hash and ontology version are still bound
 * into every artifact this module produces, per spec section 12.
 *
 * Reproducibility: every candidate's "image" is a deterministic,
 * candidateId-seeded synthetic PNG (syntheticImageSource.js - see its own
 * header for why no real photographs exist to use instead), so rebuilding
 * the index from the same frozen fixture files always produces the same
 * embeddings (given the same embedder) - proven by
 * tests/buildIndex.test.js's reproducibility test, which also proves a
 * second build is a 100% cache hit (spec section 8).
 *
 * Metadata contract per indexed candidate (spec section 7 - this is the
 * shape a future governed vector layer would need if this is ever
 * promoted): candidateId, sourceFixtureId, corpusTier, imageIdentity
 * (sha256/dimensions/byteSize), provider, modelRevision, embedding,
 * candidateAttributes (category/colorFamily/material/silhouette/pattern -
 * see below for why this is not a full CanonicalFashionAttributesV1 block).
 *
 * Ontology note: FMQ's synthetic fixtures predate
 * tools/fashion-ontology/CanonicalFashionAttributesV1 (Workstream 01) and
 * carry their own flat attribute vocabulary (`color_normalized`,
 * `silhouette`, `material`, `pattern`, `canonical_category`), not an
 * `ontology` block. Rather than inventing a guessed mapping into the
 * canonical taxonomy for candidates the ontology was never run against,
 * `candidateAttributes` below preserves FMQ's own raw fields verbatim and
 * `ontology` is left `null` - honest "not available" per spec section 14,
 * not a fabricated canonicalization.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const { loadFullCorpus } = require('../corpus/corpusLoader');
const { inspectImage } = require('../../real-fashion-corpus/lib/imageIntegrity');
const { loadCorpus: loadRfcCorpus, buildCorpusManifest: buildRfcManifest } = require('../../real-fashion-corpus/lib/corpusStore');

const { syntheticImageFor } = require('./syntheticImageSource');
const modelManifest = require('./modelManifest');
const fashionClip = require('./fashionClipAdapter');
const stub = require('./harnessStubEmbedder');
const { embedWithCache, DEFAULT_CACHE_DIR } = require('./embeddingCache');
const { buildIndex: buildVectorIndex } = require('./vectorIndex');

/** Which embedder this build will use, decided once, synchronously, no network call (spec section 4/8). */
function selectEmbedder() {
  const availability = fashionClip.checkFashionClipAvailability();
  if (availability.available) {
    const revision = fashionClip.resolveLocalCachedRevision() || 'fashionclip-revision-unresolved-despite-local-cache';
    return { usingRealModel: true, provider: 'FASHIONCLIP', modelRevision: revision, availability };
  }
  return { usingRealModel: false, provider: stub.PROVIDER, modelRevision: stub.STUB_REVISION, availability };
}

function embedImageBuffer(buffer, embedderChoice) {
  if (!embedderChoice.usingRealModel) {
    const result = stub.embedImages([buffer]);
    return { ok: true, embedding: result.embeddings[0], provider: result.provider };
  }
  const tmpFile = path.join(os.tmpdir(), `fclip-idx-img-${crypto.randomBytes(8).toString('hex')}.png`);
  fs.writeFileSync(tmpFile, buffer);
  try {
    const result = fashionClip.embedImages([tmpFile]);
    if (!result.ok) return result;
    return { ok: true, embedding: result.embeddings[0], provider: 'FASHIONCLIP' };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

function embedTextString(text, embedderChoice) {
  if (!embedderChoice.usingRealModel) {
    const result = stub.embedTexts([text]);
    return { ok: true, embedding: result.embeddings[0], provider: result.provider };
  }
  const result = fashionClip.embedTexts([text]);
  if (!result.ok) return result;
  return { ok: true, embedding: result.embeddings[0], provider: 'FASHIONCLIP' };
}

/**
 * @param {object} [options]
 * @param {string} [options.cacheDir]
 * @returns full build record: { index, entries, blockers, embedder, corpusV2, timing, fixtureCount, candidateCount }
 */
function buildRetrievalIndex({ cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const fixtures = loadFullCorpus();
  const rfcCorpus = loadRfcCorpus({ validate: false });
  const rfcManifest = buildRfcManifest(rfcCorpus);

  const embedderChoice = selectEmbedder();

  const entries = [];
  const blockers = [];
  const imagePreprocessingMs = [];
  const embeddingMs = [];

  for (const fixture of fixtures) {
    for (const candidate of fixture.candidateProducts) {
      if (!candidate.id) continue;

      const t0 = performance.now();
      const imageBytes = syntheticImageFor(candidate.id);
      const inspected = inspectImage(imageBytes);
      imagePreprocessingMs.push(performance.now() - t0);

      const t1 = performance.now();
      const embedResult = embedWithCache({
        cacheDir,
        input: imageBytes,
        modelRevision: embedderChoice.modelRevision,
        preprocessingVersion: modelManifest.IMAGE_PREPROCESSING_VERSION,
        embedFn: (buf) => embedImageBuffer(buf, embedderChoice),
      });
      embeddingMs.push(performance.now() - t1);

      if (!embedResult.ok) {
        blockers.push({ candidateId: candidate.id, blocker: embedResult.blocker, detail: embedResult.detail });
        continue;
      }

      entries.push({
        candidateId: candidate.id,
        sourceFixtureId: fixture.fixtureId,
        corpusTier: fixture.corpusTier,
        imageIdentity: {
          sha256: inspected.sha256,
          byteSize: inspected.byteSize,
          dimensions: inspected.dimensions,
          syntheticPlaceholder: true,
        },
        provider: embedResult.provider,
        modelRevision: embedderChoice.modelRevision,
        fromCache: embedResult.fromCache,
        embedding: embedResult.embedding,
        ontology: null,
        candidateAttributes: {
          category: candidate.canonical_category || candidate.category || null,
          colorFamily: candidate.color_normalized || candidate.color || null,
          material: candidate.material || null,
          silhouette: candidate.silhouette || null,
          pattern: candidate.pattern || null,
        },
      });
    }
  }

  const index = buildVectorIndex(
    entries.map((e) => ({ candidateId: e.candidateId, embedding: e.embedding, modelRevision: e.modelRevision })),
  );

  return {
    index,
    entries,
    blockers,
    embedder: embedderChoice,
    corpusV2: { manifestHash: rfcManifest.corpusHash, ontologyVersion: rfcManifest.ontologyVersion },
    fixtureCount: fixtures.length,
    candidateCount: entries.length,
    timing: { imagePreprocessingMs, embeddingMs },
  };
}

module.exports = {
  buildRetrievalIndex,
  selectEmbedder,
  embedImageBuffer,
  embedTextString,
};
