'use strict';

/**
 * Retrieval quality evaluation (spec sections 6, 14, 15).
 *
 * "FashionCLIP supplies VISUAL SIMILARITY EVIDENCE. It does not supply
 *  CANONICAL PRODUCT IDENTITY... FMQ determines quality."
 *
 * This module is deliberately thin: it never invents its own notion of
 * "correct". Every quality judgment - identity level, substitute level, the
 * individual color/silhouette/material/pattern component scores - calls
 * straight into FMQ's own `evaluator/identityAxis.js` and
 * `evaluator/substituteAxis.js`, exactly the functions the existing control
 * arm uses (see controlArm.js). A ranked candidate list, whether produced by
 * FashionCLIP or by the production L1 ranker, is scored by the identical
 * rule set. What differs between control and challenger is only how the
 * list got ranked, never how it is judged - which is the whole point of
 * section 6's "do not infer high cosine similarity = same product": nothing
 * here ever substitutes similarityScore for a quality verdict.
 *
 * Duplicate detection reuses FMQ's `duplicates/duplicateClassifier.js`
 * unchanged, for the same reuse-not-reinvent reason.
 */

const { scoreIdentity } = require('../evaluator/identityAxis');
const { scoreSubstitute, scoreFashionComponents } = require('../evaluator/substituteAxis');
const { summarizeDuplicatesAndRetailers } = require('../duplicates/duplicateClassifier');
const { FAILURE_TAXONOMY } = require('../../real-fashion-corpus/lib/constants');

const USEFUL_IDENTITY_LEVELS = new Set(['EXACT', 'PROBABLE_EXACT']);
const USEFUL_SUBSTITUTE_LEVELS = new Set(['STRONG_SUBSTITUTE', 'ACCEPTABLE_SUBSTITUTE']);

/**
 * Score one fixture's ranked result against its ground truth.
 *
 * @param {object} fixture - an FMQ fixture (garmentIdentification, groundTruth, candidateProducts)
 * @param {string[]} rankedCandidateIds - candidateIds in rank order (rank 1 first), from either arm
 * @param {{topK?: number}} [options]
 */
function evaluateRanking(fixture, rankedCandidateIds, { topK = 5 } = {}) {
  const candidateById = new Map(fixture.candidateProducts.map((c) => [c.id, c]));
  const rankedCandidates = rankedCandidateIds.map((id) => candidateById.get(id)).filter(Boolean);
  const top1 = rankedCandidates[0] || null;
  const topKSlice = rankedCandidates.slice(0, topK);

  const identityTop1 = scoreIdentity(top1, fixture.groundTruth);
  const substituteTop1 = scoreSubstitute(top1, fixture.groundTruth);
  const componentsTop1 = scoreFashionComponents(top1, fixture.groundTruth).components;

  const identityLevelsTopK = topKSlice.map((c) => scoreIdentity(c, fixture.groundTruth).level);
  const substituteLevelsTopK = topKSlice.map((c) => scoreSubstitute(c, fixture.groundTruth).level);

  const exactTop1 = identityTop1.level === 'EXACT';
  const exactTopK = identityLevelsTopK.includes('EXACT');
  const usefulTop1 = USEFUL_IDENTITY_LEVELS.has(identityTop1.level) || USEFUL_SUBSTITUTE_LEVELS.has(substituteTop1.level);
  const usefulTopK = topKSlice.some(
    (_, i) => USEFUL_IDENTITY_LEVELS.has(identityLevelsTopK[i]) || USEFUL_SUBSTITUTE_LEVELS.has(substituteLevelsTopK[i]),
  );
  const irrelevantTop1 = identityTop1.level === 'WRONG_IDENTITY' && substituteTop1.level === 'UNUSABLE';

  const duplicates = summarizeDuplicatesAndRetailers(topKSlice);
  const hasDuplicateInTopK =
    duplicates.duplicatePairCounts.CONFIRMED_DUPLICATE + duplicates.duplicatePairCounts.LIKELY_DUPLICATE > 0;

  return {
    fixtureId: fixture.fixtureId,
    top1CandidateId: top1 ? top1.id : null,
    topKCandidateIds: topKSlice.map((c) => c.id),
    identityTop1,
    substituteTop1,
    componentsTop1,
    exactTop1,
    exactTopK,
    usefulTop1,
    usefulTopK,
    irrelevantTop1,
    hasDuplicateInTopK,
    duplicateSummary: duplicates,
  };
}

function rate(results, predicate) {
  if (results.length === 0) return null;
  return results.filter(predicate).length / results.length;
}

/** Wrong-attribute rate: strict "wrong" (component score === 0), excluding fixtures with no scoreable ground truth for that component (never defaulted to 0 - spec section 14's "report unavailable rather than guessing"). */
function wrongComponentRate(results, componentName) {
  const scoreable = results.filter((r) => r.componentsTop1[componentName] !== null && r.componentsTop1[componentName] !== undefined);
  if (scoreable.length === 0) {
    return { rate: null, n: 0, reason: `no fixture had scoreable ground truth for '${componentName}'` };
  }
  return { rate: scoreable.filter((r) => r.componentsTop1[componentName] === 0).length / scoreable.length, n: scoreable.length };
}

/**
 * Aggregate per-fixture results into headline retrieval metrics (spec
 * section 14). `wrongSubtypeRate` is explicitly UNAVAILABLE: FMQ's fixture
 * ground truth carries `category` only, never an ontology `subtype` - see
 * buildIndex.js's header for why candidates here are not run through
 * CanonicalFashionAttributesV1. Guessing a subtype mapping to fill this in
 * would be exactly the fabrication spec section 14 forbids.
 */
function aggregateRetrievalMetrics(perFixtureResults) {
  return {
    n: perFixtureResults.length,
    exactTop1Rate: rate(perFixtureResults, (r) => r.exactTop1),
    exactTop5Rate: rate(perFixtureResults, (r) => r.exactTopK),
    usefulTop1Rate: rate(perFixtureResults, (r) => r.usefulTop1),
    usefulTop5Rate: rate(perFixtureResults, (r) => r.usefulTopK),
    wrongColorRate: wrongComponentRate(perFixtureResults, 'color_family'),
    wrongSilhouetteRate: wrongComponentRate(perFixtureResults, 'silhouette'),
    wrongMaterialRate: wrongComponentRate(perFixtureResults, 'material'),
    wrongPatternRate: wrongComponentRate(perFixtureResults, 'pattern'),
    wrongSubtypeRate: {
      rate: null,
      n: 0,
      reason: 'UNAVAILABLE: FMQ fixture ground truth has no ontology subtype field (category only) - see buildIndex.js header',
    },
    irrelevantRate: rate(perFixtureResults, (r) => r.irrelevantTop1),
    duplicateRate: rate(perFixtureResults, (r) => r.hasDuplicateInTopK),
  };
}

/**
 * Break results down by Real Fashion Corpus V2 failure-taxonomy label (spec
 * section 15). Consumes RFC V2 case records directly - never a second
 * taxonomy. Structurally complete and real: with 0 real cases (this
 * checkout's actual state), every count is honestly 0, not fabricated or
 * omitted - the machinery is proven against constructed fixtures in
 * tests/retrievalEvaluator.test.js, the same methodology
 * tools/real-fashion-corpus/tests/ already uses throughout.
 */
function buildFailureTaxonomyBreakdown(rfcCases) {
  const counts = Object.fromEntries(FAILURE_TAXONOMY.map((label) => [label, 0]));
  for (const record of rfcCases) {
    for (const label of record.failureTaxonomy || []) {
      if (counts[label] !== undefined) counts[label] += 1;
    }
  }
  return { totalCasesConsidered: rfcCases.length, counts };
}

module.exports = {
  evaluateRanking,
  aggregateRetrievalMetrics,
  buildFailureTaxonomyBreakdown,
  USEFUL_IDENTITY_LEVELS,
  USEFUL_SUBSTITUTE_LEVELS,
};
