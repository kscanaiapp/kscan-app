'use strict';

/**
 * THE PAIRED EXPERIMENT (spec sections 8, 14, 16, 17).
 *
 *   CONTROL     = the existing K Scan L1 candidate list, in L1's own ordering
 *   CHALLENGER  = the EXACT same candidate list, re-ordered by visual similarity
 *
 * Both arms are scored by the SAME FMQ evaluator, at the same evaluator
 * version, in the same process. The only thing that differs between the arms
 * is the order of the list. Everything structural about this module exists to
 * keep that true:
 *
 *   - The control ordering comes from `../controlArm.js`, which shells out to
 *     the REAL production L1 module unmodified. It is not a re-implementation
 *     and not the fixture's declaration order.
 *   - The challenger consumes the control's output directly, so it cannot
 *     silently evaluate a different or easier candidate set.
 *   - Both arms' universes are independently fingerprinted and compared
 *     (candidateUniverse.js). A mismatch marks the case INVALID rather than
 *     reporting a flattering number.
 *   - A case whose control arm is blocked is recorded as NOT_RUN and excluded
 *     from both arms' metrics, never silently scored on one side only.
 *
 * EMBEDDER PROVENANCE. Which embedder ran is decided once, up front, and
 * carried through every artifact. Real FashionCLIP is preferred whenever the
 * adapter reports it available; otherwise the run is explicitly a non-model
 * run and `executionIdentity` says so in five separate fields. No metric
 * produced here can assert real-model execution - see executionIdentity.js.
 */

const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const { loadFullCorpus } = require('../../corpus/corpusLoader');
const { inspectImage } = require('../../../real-fashion-corpus/lib/imageIntegrity');
const { runControlArm, isDenoAvailable } = require('../controlArm');
const { evaluateRanking, aggregateRetrievalMetrics } = require('../retrievalEvaluator');
const { COMPONENT_FIELD_RESOLUTION_VERSION } = require('../../evaluator/substituteAxis');
const { RUBRIC_VERSION } = require('../../evaluator/rubric');

const modelManifest = require('../modelManifest');
const fashionClip = require('../fashionClipAdapter');
const stub = require('../harnessStubEmbedder');
const { syntheticImageFor } = require('../syntheticImageSource');
const { embedWithCache, DEFAULT_CACHE_DIR } = require('../embeddingCache');

const descriptor = require('./visualDescriptorProbe');
const attributeImages = require('./attributeImageSource');
const { rerank, describeMovement, STRATEGY_PURE_VISUAL } = require('./visualReranker');
const { fingerprintUniverse, assertSameUniverse } = require('./candidateUniverse');
const { deriveExecutionIdentity } = require('./executionIdentity');

const EXPERIMENT_VERSION = 'fashionclip-rerank-experiment-v1';

/** Image sources, in decreasing fidelity to what a real run would embed. */
const IMAGE_SOURCE_ATTRIBUTE = 'ATTRIBUTE_RENDERED_PLACEHOLDER';
const IMAGE_SOURCE_IDHASH = 'ID_HASHED_PLACEHOLDER';

/**
 * Choose the embedder once, synchronously. Real model first, always.
 *
 * `imageSource` only affects which placeholder bytes are embedded; it never
 * affects which embedder runs, so a real-model run and a harness run embed
 * the identical byte stream and remain directly comparable.
 */
function selectEmbedder({ preferDescriptor = true } = {}) {
  const availability = fashionClip.checkFashionClipAvailability();
  if (availability.available) {
    const revision = fashionClip.resolveLocalCachedRevision();
    return {
      usingRealModel: true,
      provider: 'FASHIONCLIP',
      modelRevision: revision,
      preprocessingVersion: modelManifest.IMAGE_PREPROCESSING_VERSION,
      availability,
      embed: (buffer) => {
        const tmp = path.join(os.tmpdir(), `fclip-rr-${crypto.randomBytes(8).toString('hex')}.png`);
        fs.writeFileSync(tmp, buffer);
        try {
          const r = fashionClip.embedImages([tmp]);
          if (!r.ok) return r;
          return { ok: true, embedding: r.embeddings[0], provider: 'FASHIONCLIP' };
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* best-effort */
          }
        }
      },
    };
  }

  if (preferDescriptor) {
    return {
      usingRealModel: false,
      provider: descriptor.PROVIDER,
      modelRevision: descriptor.DESCRIPTOR_REVISION,
      preprocessingVersion: descriptor.DESCRIPTOR_PREPROCESSING_VERSION,
      availability,
      embed: (buffer) => {
        const r = descriptor.embedImages([buffer]);
        return { ok: true, embedding: r.embeddings[0], provider: r.provider };
      },
    };
  }

  return {
    usingRealModel: false,
    provider: stub.PROVIDER,
    modelRevision: stub.STUB_REVISION,
    preprocessingVersion: modelManifest.IMAGE_PREPROCESSING_VERSION,
    availability,
    embed: (buffer) => {
      const r = stub.embedImages([buffer]);
      return { ok: true, embedding: r.embeddings[0], provider: r.provider };
    },
  };
}

function imageBytesForCandidate(candidate, imageSource) {
  if (imageSource === IMAGE_SOURCE_ATTRIBUTE) {
    return attributeImages.renderGarmentImage(attributeImages.attributesFromCandidate(candidate));
  }
  return syntheticImageFor(candidate.id);
}

function imageBytesForQuery(fixture, imageSource) {
  if (imageSource === IMAGE_SOURCE_ATTRIBUTE) {
    return attributeImages.renderGarmentImage(attributeImages.attributesFromGroundTruth(fixture.groundTruth));
  }
  return syntheticImageFor(`QUERY::${fixture.fixtureId}`);
}

/** Run one fixture through both arms. */
function runCase(fixture, { embedder, cacheDir, imageSource, strategy, visualWeight, topK }) {
  // ---- CONTROL: the real production L1 ordering -------------------------
  const tControl0 = performance.now();
  const control = runControlArm(fixture);
  const controlMs = performance.now() - tControl0;

  if (!control.ok) {
    return {
      fixtureId: fixture.fixtureId,
      status: 'NOT_RUN',
      blocker: control.blocker,
      detail: control.detail,
    };
  }

  const candidateById = new Map(fixture.candidateProducts.map((c) => [c.id, c]));
  const l1Order = control.rankedCandidateIds;

  // ---- Candidate embeddings (the challenger's only extra input) ---------
  const candidateEmbedMs = [];
  const imageIdentityById = new Map();
  const embedBlockers = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let providerVerifiedAll = true;

  const rerankInput = l1Order.map((candidateId, i) => {
    const candidate = candidateById.get(candidateId);
    const bytes = imageBytesForCandidate(candidate, imageSource);
    imageIdentityById.set(candidateId, inspectImage(bytes));

    const t0 = performance.now();
    const result = embedWithCache({
      cacheDir,
      input: bytes,
      modelRevision: embedder.modelRevision,
      preprocessingVersion: embedder.preprocessingVersion,
      expectedProvider: embedder.provider,
      embedFn: embedder.embed,
    });
    candidateEmbedMs.push(performance.now() - t0);

    if (!result.ok) {
      embedBlockers.push({ candidateId, blocker: result.blocker, detail: result.detail });
      return { candidateId, embedding: null, l1Rank: i + 1 };
    }
    if (result.fromCache) cacheHits += 1;
    else cacheMisses += 1;
    if (!result.providerVerified) providerVerifiedAll = false;

    return { candidateId, embedding: result.embedding, l1Rank: i + 1 };
  });

  // ---- Query embedding --------------------------------------------------
  const queryBytes = imageBytesForQuery(fixture, imageSource);
  const tQuery0 = performance.now();
  const queryResult = embedWithCache({
    cacheDir,
    input: queryBytes,
    modelRevision: embedder.modelRevision,
    preprocessingVersion: embedder.preprocessingVersion,
    expectedProvider: embedder.provider,
    embedFn: embedder.embed,
  });
  const queryEmbeddingMs = performance.now() - tQuery0;

  if (!queryResult.ok) {
    return {
      fixtureId: fixture.fixtureId,
      status: 'NOT_RUN',
      blocker: queryResult.blocker,
      detail: `query image could not be embedded: ${queryResult.detail}`,
    };
  }
  if (queryResult.fromCache) cacheHits += 1;
  else cacheMisses += 1;

  // ---- CHALLENGER: same candidates, visually re-ordered ----------------
  const tRerank0 = performance.now();
  const reranked = rerank({
    queryEmbedding: queryResult.embedding,
    candidates: rerankInput,
    strategy,
    visualWeight,
  });
  const rerankMs = performance.now() - tRerank0;

  // ---- Universe identity (spec section 8) ------------------------------
  const controlUniverse = fingerprintUniverse(
    l1Order.map((id) => ({ candidate: candidateById.get(id), imageIdentity: imageIdentityById.get(id) })),
  );
  const challengerUniverse = fingerprintUniverse(
    reranked.rankedCandidateIds.map((id) => ({ candidate: candidateById.get(id), imageIdentity: imageIdentityById.get(id) })),
  );
  const universeCheck = assertSameUniverse(controlUniverse, challengerUniverse, l1Order, reranked.rankedCandidateIds);

  // ---- Score BOTH arms through the identical evaluator ------------------
  const tEval0 = performance.now();
  const controlEval = evaluateRanking(fixture, l1Order, { topK });
  const challengerEval = evaluateRanking(fixture, reranked.rankedCandidateIds, { topK });
  const evaluationMs = performance.now() - tEval0;

  return {
    fixtureId: fixture.fixtureId,
    archetype: fixture.archetype,
    corpusTier: fixture.corpusTier,
    status: universeCheck.identical ? 'OK' : 'INVALID_UNIVERSE_MISMATCH',
    universe: {
      controlHash: controlUniverse.hash,
      challengerHash: challengerUniverse.hash,
      identical: universeCheck.identical,
      reasons: universeCheck.reasons,
      memberCount: controlUniverse.memberCount,
    },
    control: { order: l1Order, evaluation: controlEval },
    challenger: {
      order: reranked.rankedCandidateIds,
      evaluation: challengerEval,
      scored: reranked.scored,
      strategy: reranked.strategy,
      visualWeight: reranked.visualWeight,
      scorableCount: reranked.scorableCount,
      unscorableCount: reranked.unscorableCount,
    },
    movement: describeMovement(l1Order, reranked.rankedCandidateIds),
    embedding: {
      provider: embedder.provider,
      modelRevision: embedder.modelRevision,
      cacheHits,
      cacheMisses,
      providerVerifiedAll,
      blockers: embedBlockers,
      embeddingsUsed: reranked.embeddingsUsed,
    },
    timing: { controlMs, queryEmbeddingMs, candidateEmbedMs, rerankMs, evaluationMs },
  };
}

/**
 * DEGRADED-ORDER RECOVERY PROBE - A MECHANISM CHECK, NOT A QUALITY RESULT.
 *
 * The paired experiment above compares the re-ranker against the REAL L1
 * ordering. On this corpus that comparison is structurally unable to show an
 * improvement, because L1 already places the exact-SKU match at rank 1 in
 * every case - there is no headroom for any re-ranker to recover. That is a
 * fact about the corpus, not about FashionCLIP, and it is reported as such.
 *
 * But it leaves one engineering question unanswered: does the re-ranking
 * layer actually RESPOND to visual evidence, or does it merely pass L1's
 * order through? This probe answers exactly that, and nothing else. It feeds
 * the re-ranker a DELIBERATELY DEGRADED ordering (L1's ranking reversed, so
 * the correct product starts last) and measures how far the re-ranker pulls
 * the correct product back up.
 *
 * WHAT THIS IS NOT. The reversed ordering is synthetic and adversarial - no
 * production L1 would emit it. Recovery here says the wiring works; it says
 * nothing about how often real L1 orderings need fixing, and nothing about
 * FashionCLIP, which did not run. Its output is reported under
 * `mechanismProbe` and is never mixed into the control-vs-challenger metrics.
 */
function runDegradedOrderProbe(fixture, { embedder, cacheDir, imageSource, strategy, visualWeight, topK }) {
  const baseline = runCase(fixture, { embedder, cacheDir, imageSource, strategy, visualWeight, topK });
  if (baseline.status !== 'OK') return { fixtureId: fixture.fixtureId, status: baseline.status, blocker: baseline.blocker };

  const candidateById = new Map(fixture.candidateProducts.map((c) => [c.id, c]));
  const degradedOrder = [...baseline.control.order].reverse();

  // Reuse the embeddings the baseline case already computed and cached; only
  // the input ORDER differs, which is the whole point of the probe.
  const embeddingById = new Map(baseline.challenger.scored.map((s) => [s.candidateId, s]));
  const queryBytes = imageBytesForQuery(fixture, imageSource);
  const queryResult = embedWithCache({
    cacheDir,
    input: queryBytes,
    modelRevision: embedder.modelRevision,
    preprocessingVersion: embedder.preprocessingVersion,
    expectedProvider: embedder.provider,
    embedFn: embedder.embed,
  });
  if (!queryResult.ok) return { fixtureId: fixture.fixtureId, status: 'NOT_RUN', blocker: queryResult.blocker };

  const rerankInput = degradedOrder.map((candidateId, i) => {
    const bytes = imageBytesForCandidate(candidateById.get(candidateId), imageSource);
    const r = embedWithCache({
      cacheDir,
      input: bytes,
      modelRevision: embedder.modelRevision,
      preprocessingVersion: embedder.preprocessingVersion,
      expectedProvider: embedder.provider,
      embedFn: embedder.embed,
    });
    return { candidateId, embedding: r.ok ? r.embedding : null, l1Rank: i + 1 };
  });

  const recovered = rerank({ queryEmbedding: queryResult.embedding, candidates: rerankInput, strategy, visualWeight });

  const trueTop1 = baseline.control.order[0]; // what real L1 put first
  const degradedRankOfTruth = degradedOrder.indexOf(trueTop1) + 1;
  const recoveredRankOfTruth = recovered.rankedCandidateIds.indexOf(trueTop1) + 1;

  return {
    fixtureId: fixture.fixtureId,
    status: 'OK',
    degradedOrder,
    recoveredOrder: recovered.rankedCandidateIds,
    trueTop1,
    degradedRankOfTruth,
    recoveredRankOfTruth,
    ranksRecovered: degradedRankOfTruth - recoveredRankOfTruth,
    recoveredToTop1: recoveredRankOfTruth === 1,
    evaluation: evaluateRanking(fixture, recovered.rankedCandidateIds, { topK }),
    degradedEvaluation: evaluateRanking(fixture, degradedOrder, { topK }),
  };
}

/**
 * Run the full paired experiment over the corpus.
 *
 * @param {object} [options]
 * @param {string} [options.cacheDir]
 * @param {string} [options.imageSource]
 * @param {string} [options.strategy]
 * @param {number} [options.visualWeight]
 * @param {number} [options.topK]
 * @param {boolean} [options.preferDescriptor] - use the labelled visual descriptor
 *        rather than the SHA stub when the real model is unavailable
 */
function runRerankExperiment({
  cacheDir = DEFAULT_CACHE_DIR,
  imageSource = IMAGE_SOURCE_ATTRIBUTE,
  strategy = STRATEGY_PURE_VISUAL,
  visualWeight = 0.5,
  topK = 5,
  preferDescriptor = true,
  fixtures = null,
} = {}) {
  const corpus = fixtures || loadFullCorpus();
  const embedder = selectEmbedder({ preferDescriptor });

  const cases = corpus.map((fixture) => runCase(fixture, { embedder, cacheDir, imageSource, strategy, visualWeight, topK }));
  const mechanismProbe = corpus.map((fixture) =>
    runDegradedOrderProbe(fixture, { embedder, cacheDir, imageSource, strategy, visualWeight, topK }),
  );

  const scored = cases.filter((c) => c.status === 'OK');
  const notRun = cases.filter((c) => c.status === 'NOT_RUN');
  const invalid = cases.filter((c) => c.status === 'INVALID_UNIVERSE_MISMATCH');

  const controlMetrics = aggregateRetrievalMetrics(scored.map((c) => c.control.evaluation));
  const challengerMetrics = aggregateRetrievalMetrics(scored.map((c) => c.challenger.evaluation));

  const totalEmbeddingsUsed = scored.reduce((sum, c) => sum + c.embedding.embeddingsUsed, 0);
  const allProviderVerified = scored.length > 0 && scored.every((c) => c.embedding.providerVerifiedAll);

  const executionIdentity = deriveExecutionIdentity({
    provider: embedder.provider,
    modelRevision: embedder.modelRevision,
    weightsLoaded: embedder.usingRealModel,
    embeddingsProduced: totalEmbeddingsUsed,
    embeddingsUsedInRerank: totalEmbeddingsUsed,
    cacheRevisionValidated: allProviderVerified,
  });

  return {
    experimentVersion: EXPERIMENT_VERSION,
    evaluator: { rubricVersion: RUBRIC_VERSION, componentFieldResolutionVersion: COMPONENT_FIELD_RESOLUTION_VERSION },
    embedder: {
      provider: embedder.provider,
      modelRevision: embedder.modelRevision,
      preprocessingVersion: embedder.preprocessingVersion,
      usingRealModel: embedder.usingRealModel,
      availabilityReasons: embedder.availability.reasons,
    },
    executionIdentity,
    configuration: { imageSource, strategy, visualWeight, topK, cacheDir },
    control: { description: 'K Scan production L1 ranking (runL1.deno.ts, unmodified)', metrics: controlMetrics },
    challenger: { description: `L1 candidates re-ordered by visual similarity (${strategy})`, metrics: challengerMetrics },
    universeIdentical: scored.length > 0 && scored.every((c) => c.universe.identical) && invalid.length === 0,
    denoAvailable: isDenoAvailable(),
    cases,
    mechanismProbe: {
      label: 'MECHANISM_CHECK_NOT_QUALITY_EVIDENCE',
      description:
        'Re-ranker fed a deliberately reversed L1 ordering, to test whether the layer responds to visual evidence at all. ' +
        'Says nothing about FashionCLIP (which did not run) and nothing about how often real L1 orderings need correcting.',
      results: mechanismProbe,
    },
    counts: { total: cases.length, scored: scored.length, notRun: notRun.length, invalid: invalid.length },
  };
}

module.exports = {
  EXPERIMENT_VERSION,
  runDegradedOrderProbe,
  IMAGE_SOURCE_ATTRIBUTE,
  IMAGE_SOURCE_IDHASH,
  selectEmbedder,
  runCase,
  runRerankExperiment,
};
