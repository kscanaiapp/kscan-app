'use strict';

/**
 * FashionCLIP retrieval lab - end-to-end evaluation orchestration
 * (spec section 19/20). Ties together every other module in this package
 * into one machine-readable report:
 *
 *   1. Build the R&D index from FMQ's fixture universe (buildIndex.js).
 *   2. For every fixture, run BOTH arms and score both with the identical
 *      FMQ evaluator (controlArm.js / queryModes.js / retrievalEvaluator.js):
 *        CONTROL     - the real production L1 ranker, via Deno (honestly
 *                      blocked in this sandbox - see controlArm.js).
 *        CHALLENGER  - FashionCLIP image-to-image retrieval over the local
 *                      vector index (honestly running the harness stub
 *                      embedder in this sandbox - see buildIndex.js).
 *   3. Run the controlled text->image sanity queries (queryModes.js).
 *   4. Aggregate metrics, timing, and the (currently all-zero, structurally
 *      complete) Real Fashion Corpus V2 failure-taxonomy breakdown.
 *   5. Decide HARNESS_READY/NOT_READY and the real-world-efficacy /
 *      runtime-promotion verdicts (spec section 20) - kept separate on
 *      purpose: engineering readiness is not product-quality evidence.
 */

const { performance } = require('node:perf_hooks');

const { loadFullCorpus } = require('../corpus/corpusLoader');
const { loadCorpus: loadRfcCorpus, buildCorpusManifest, realCasesOnly } = require('../../real-fashion-corpus/lib/corpusStore');
const { ONTOLOGY_VERSION } = require('../../real-fashion-corpus/lib/ontology');

const modelManifest = require('./modelManifest');
const { buildRetrievalIndex } = require('./buildIndex');
const { runControlArm } = require('./controlArm');
const { imageToImageQuery, textToImageQuery, CANONICAL_TEXT_QUERIES } = require('./queryModes');
const { evaluateRanking, aggregateRetrievalMetrics, buildFailureTaxonomyBreakdown } = require('./retrievalEvaluator');
const { summarize, recordEnvironment } = require('./timing');
const { DEFAULT_CACHE_DIR } = require('./embeddingCache');

const EVALUATION_VERSION = 'fashionclip-retrieval-eval-v1';
const TOP_K = 5;

function buildLimitations({ built, controlBlockedSample, realCaseCount }) {
  const limitations = [];

  limitations.push(
    `Model provider actually used this run: ${built.embedder.provider}. FashionCLIP itself ` +
      `(${modelManifest.MODEL_ID}) is unavailable in this session: ${built.embedder.availability.reasons.join(', ')} - ` +
      'huggingface.co is explicitly organization-policy-denied by this sandbox\'s egress proxy (see modelManifest.js\'s header). ' +
      'Challenger metrics below reflect the harness stub embedder (harnessStubEmbedder.js) unless provider says FASHIONCLIP.',
  );

  if (controlBlockedSample) {
    limitations.push(
      `Control arm blocked: ${controlBlockedSample.blocker} - ${controlBlockedSample.detail} This mirrors FMQ's own ` +
        'pre-existing "4 skip" L1 test results in this exact sandbox (tools/fashion-match-quality/l1/runL1.test.js) and is ' +
        'not something this workstream introduced.',
    );
  }

  limitations.push(
    'No real garment photographs exist anywhere in the offline fixture universe this run indexes: FMQ\'s synthetic ' +
      'fixtures carry only placeholder imageUrl strings, and Real Fashion Corpus V2 has 0 real cases on this checkout. ' +
      'Every "image" embedded is a deterministic, candidateId-seeded synthetic PNG (syntheticImageSource.js) - real for ' +
      'decode/hash/dimension purposes, never a photograph.',
  );

  limitations.push(
    'text->image results are mechanical-plumbing proof only. The harness stub embedder has no learned joint ' +
      'image/text embedding space (it is expanded SHA-256 hash output), so its text->image ranking carries no semantic ' +
      'signal by construction. Whether FashionCLIP\'s real embeddings retrieve fashion-consistent candidates for a query ' +
      'like "burgundy leather bomber jacket" is unproven in this session.',
  );

  limitations.push(
    'wrongColorRate reflects a pre-existing FMQ synthetic-fixture-corpus characteristic, not a challenger defect: ' +
      'candidateProducts in tools/fashion-match-quality/fixtures/synthetic/*.json carry `color`/`color_normalized`, ' +
      'never `color_family`, while FASHION_COMPONENTS scoring (evaluator/rubric.js) reads `color_family` - so ' +
      'color_family scores 0 even for the exact-match candidate. Verified by calling FMQ\'s own unmodified ' +
      'scoreFashionComponents() directly against its own fixture. This affects control and challenger identically ' +
      '(both are scored by the same unmodified FMQ function), so it does not bias the comparison, but the absolute ' +
      'wrongColorRate number is not a literal color-accuracy measurement against this particular fixture corpus.',
  );

  limitations.push(
    'wrongSubtypeRate is UNAVAILABLE: FMQ fixture ground truth carries `category` only, never an ontology `subtype` ' +
      'field, and no ontology canonicalization was run against these candidates (see buildIndex.js header) - reported ' +
      'as unavailable rather than guessed, per spec section 14.',
  );

  limitations.push(
    `realCaseCount is ${realCaseCount} (Real Fashion Corpus V2's actual current state - see ` +
      'tools/real-fashion-corpus/docs/DESIGN.md DM-12). Every metric above is HARNESS / FIXTURE EVIDENCE against FMQ\'s ' +
      'constructed synthetic corpus, never REAL-WORLD QUALITY PROOF, per spec section 13.',
  );

  limitations.push(
    'Curiosity Gap integration (spec section 16): this report adopts that lab\'s reporting conventions (P50/P95/MAX ' +
      'percentile summaries, an explicit non-production benchmark-status label) rather than injecting these R&D ' +
      'embedding/index timings into its TTFAR structural model - these timings are not part of the Scanner\'s actual ' +
      'analyze pipeline (spec section 21: zero customer-path change), and injecting them would misrepresent TTFAR ' +
      'rather than extend it.',
  );

  return limitations;
}

function decideOutcome({ realCaseCount }) {
  const realWorldEfficacyDecision = realCaseCount > 0 ? 'REQUIRES_MANUAL_REVIEW' : 'INSUFFICIENT_REAL_CORPUS';
  const runtimePromotion = realCaseCount > 0 ? 'REQUIRES_MANUAL_REVIEW' : 'NOT_YET_EVALUABLE';
  return { realWorldEfficacyDecision, runtimePromotion };
}

/**
 * Run the full harness end to end and produce the evaluation report.
 * Never throws for an ordinary blocked-provider outcome (that is recorded
 * as HARNESS_READY with documented limitations, per spec section 20's
 * "keep engineering readiness separate from product-quality evidence") -
 * only an actual internal harness defect produces HARNESS_NOT_READY, via
 * the try/catch below.
 */
function runFullEvaluation({ cacheDir = DEFAULT_CACHE_DIR, topK = TOP_K } = {}) {
  try {
    const fixtures = loadFullCorpus();
    const rfcCorpus = loadRfcCorpus({ validate: false });
    const rfcManifest = buildCorpusManifest(rfcCorpus);
    const realCaseCount = realCasesOnly(rfcCorpus.cases).length;

    const built = buildRetrievalIndex({ cacheDir });

    const controlResults = [];
    const challengerResults = [];
    let controlBlockedSample = null;
    const queryTimingMs = [];
    const fmqEvalTimingMs = [];

    for (const fixture of fixtures) {
      const control = runControlArm(fixture);
      if (control.ok) {
        const t0 = performance.now();
        controlResults.push(evaluateRanking(fixture, control.rankedCandidateIds, { topK }));
        fmqEvalTimingMs.push(performance.now() - t0);
      } else if (!controlBlockedSample) {
        controlBlockedSample = control;
      }

      const tQ = performance.now();
      const challengerQuery = imageToImageQuery(built.index, fixture.fixtureId, built.embedder, { cacheDir, topK });
      queryTimingMs.push(performance.now() - tQ);
      if (challengerQuery.ok) {
        const t1 = performance.now();
        challengerResults.push(evaluateRanking(fixture, challengerQuery.results.map((r) => r.candidateId), { topK }));
        fmqEvalTimingMs.push(performance.now() - t1);
      }
    }

    const textQueryResults = CANONICAL_TEXT_QUERIES.map((text) => ({
      text,
      result: textToImageQuery(built.index, text, built.embedder, { cacheDir, topK }),
    }));

    const timing = {
      imagePreprocessing: summarize(built.timing.imagePreprocessingMs),
      embeddingGeneration: summarize(built.timing.embeddingMs),
      indexQuery: summarize(queryTimingMs),
      topKMaterialization: summarize(queryTimingMs), // materialization is part of query() itself - see vectorIndex.js
      fmqEvaluation: summarize(fmqEvalTimingMs),
    };

    const { realWorldEfficacyDecision, runtimePromotion } = decideOutcome({ realCaseCount });

    return {
      evaluationVersion: EVALUATION_VERSION,
      corpusVersion: rfcCorpus.config.corpusVersion,
      corpusManifestHash: rfcManifest.corpusHash,
      ontologyVersion: ONTOLOGY_VERSION,
      modelId: modelManifest.MODEL_ID,
      modelRevision: built.embedder.modelRevision,
      modelProvider: built.embedder.provider,
      controlDescription:
        'K Scan production-identical ranking (normalizeIdentification/rankRecommendedProducts via the real L1 Deno ' +
        'harness, unmodified), scored by FMQ\'s identity/substitute axes - see controlArm.js.',
      challengerDescription:
        `FashionCLIP (${modelManifest.MODEL_ID}) image-to-image retrieval over a local cosine-similarity vector index ` +
        'built from the same fixture candidate universe, scored by the identical FMQ axes - see buildIndex.js / ' +
        `queryModes.js. Embedder actually used this run: ${built.embedder.provider}.`,
      fixtureCaseCount: fixtures.length,
      realCaseCount,
      metrics: {
        control: aggregateRetrievalMetrics(controlResults),
        controlBlocked: controlResults.length === 0 && fixtures.length > 0,
        controlBlocker: controlBlockedSample,
        challenger: aggregateRetrievalMetrics(challengerResults),
        failureTaxonomyBreakdown: buildFailureTaxonomyBreakdown(rfcCorpus.cases),
        textToImageSanityQueries: textQueryResults.map(({ text, result }) => ({
          query: text,
          ok: result.ok,
          topResultIds: result.ok ? result.results.map((r) => r.candidateId) : null,
          blocker: result.ok ? null : result.blocker,
        })),
      },
      timing,
      environment: recordEnvironment(),
      limitations: buildLimitations({ built, controlBlockedSample, realCaseCount }),
      harnessReady: 'HARNESS_READY',
      realWorldEfficacyDecision,
      runtimePromotion,
    };
  } catch (err) {
    return {
      evaluationVersion: EVALUATION_VERSION,
      harnessReady: 'HARNESS_NOT_READY',
      harnessFailure: { message: err.message, stack: err.stack },
      realWorldEfficacyDecision: 'INSUFFICIENT_REAL_CORPUS',
      runtimePromotion: 'NOT_YET_EVALUABLE',
    };
  }
}

if (require.main === module) {
  const report = runFullEvaluation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.harnessReady === 'HARNESS_READY' ? 0 : 1);
}

module.exports = { runFullEvaluation, EVALUATION_VERSION, TOP_K };
