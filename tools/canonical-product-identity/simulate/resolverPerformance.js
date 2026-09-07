'use strict';

/**
 * Resolver performance (spec section 30). Measures the resolver itself,
 * OFFLINE, on this machine - these are OBSERVED wall-clock numbers from
 * this lab's own hardware, never a claim about production latency (that
 * distinction is spelled out wherever these numbers are surfaced in the
 * report, per spec section 29's PROVEN/OBSERVED/MODELED discipline).
 *
 * Candidate-set sizes 10/50/200/500 per spec. For each size, runs the full
 * pairwise-resolve + cluster pipeline (the actual granularity a caller
 * would invoke) `repetitions` times against a FRESH deterministically-
 * generated offer set (lib/seededRandom.js + lib/offerFactory.js), and
 * reports P50/P95 wall time plus heap delta. Determinism is checked by
 * running the exact same input twice and diffing the JSON-stringified
 * decision output.
 */

const { createRng } = require('../lib/seededRandom');
const { makeOffer, resetOfferCounter } = require('../lib/offerFactory');
const { CATEGORY_STYLES, CATEGORY_KEYS, BRANDS, RETAILERS } = require('../lib/fashionWorld');
const { generateValidGtin13 } = require('../lib/identifierNormalize');
const { evaluateAllPairs } = require('../evaluator/pairwiseEvaluation');
const { clusterOffers } = require('../resolver/cluster');

const DEFAULT_SIZES = [10, 50, 200, 500];
const DEFAULT_REPETITIONS = 15;

/** Deterministically synthesize `size` offers - a realistic mix of duplicates/siblings/distinct products, same vocabulary the corpus uses. */
function synthesizeOfferSet(size, seed) {
  resetOfferCounter();
  const rng = createRng(seed);
  const offers = [];
  let i = 0;
  while (offers.length < size) {
    const t = CATEGORY_STYLES[rng.pick(CATEGORY_KEYS)];
    const brand = rng.pick(BRANDS);
    const styleName = rng.pick(t.styleNames);
    const color = rng.pick(t.colors);
    const material = rng.pick(t.materials);
    const title = `${brand} ${styleName} - ${color} ${material}`;
    const shareGtin = rng.bool(0.35); // roughly a third of draws land as a cross-retailer duplicate of the previous offer
    const gtin = shareGtin && offers.length > 0 ? offers[offers.length - 1].gtin : generateValidGtin13(rng);
    offers.push(makeOffer({
      offerId: `perf-${size}-${i}`,
      retailer: rng.pick(RETAILERS),
      brand,
      title,
      category: t.category,
      color,
      material,
      gtin: rng.bool(0.7) ? gtin : null, // ~30% missing GTIN, matching the corpus's own "safe fallthrough" coverage
      price: 50 + rng.int(0, 900),
      url: `https://example-retail.com/p/${size}/${i}`,
    }));
    i += 1;
  }
  return { offers, corpusStub: { canonicalStyles: [], pairOverrides: [] } };
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function runOnePass(offers) {
  const corpusStub = { offers, canonicalStyles: [], pairOverrides: [] };
  const pairwiseResults = evaluateAllPairs(corpusStub, { offers });
  const { variantClusters } = clusterOffers(offers, pairwiseResults);
  return { pairwiseResults, variantClusters };
}

function benchmarkSize(size, { repetitions = DEFAULT_REPETITIONS } = {}) {
  const { offers } = synthesizeOfferSet(size, `resolver-performance-v1-size-${size}`);
  const timingsMs = [];
  let firstRunSignature = null;
  let determinismOk = true;
  let memBeforeAvg = 0;
  let memAfterAvg = 0;

  for (let r = 0; r < repetitions; r += 1) {
    if (global.gc) global.gc(); // only affects timing if the process opts in (--expose-gc); harmless no-op otherwise
    const memBefore = process.memoryUsage().heapUsed;
    const start = process.hrtime.bigint();
    const { pairwiseResults, variantClusters } = runOnePass(offers);
    const end = process.hrtime.bigint();
    const memAfter = process.memoryUsage().heapUsed;

    timingsMs.push(Number(end - start) / 1e6);
    memBeforeAvg += memBefore;
    memAfterAvg += memAfter;

    const signature = JSON.stringify({
      decisions: pairwiseResults.map((p) => `${p.offerIdA}|${p.offerIdB}|${p.decision}`),
      clusters: variantClusters.map((c) => c.offerIds.slice().sort()).sort((a, b) => a[0].localeCompare(b[0])),
    });
    if (firstRunSignature === null) firstRunSignature = signature;
    else if (signature !== firstRunSignature) determinismOk = false;
  }

  const sorted = [...timingsMs].sort((a, b) => a - b);
  return {
    candidateSetSize: size,
    pairCount: (size * (size - 1)) / 2,
    repetitions,
    p50Ms: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    avgHeapDeltaBytes: Math.round((memAfterAvg - memBeforeAvg) / repetitions),
    deterministic: determinismOk,
    timingClass: 'OBSERVED - offline wall-clock time on this lab\'s own run, not a production latency measurement',
  };
}

function runResolverPerformanceSuite({ sizes = DEFAULT_SIZES, repetitions = DEFAULT_REPETITIONS } = {}) {
  return sizes.map((size) => benchmarkSize(size, { repetitions }));
}

module.exports = { synthesizeOfferSet, benchmarkSize, runResolverPerformanceSuite, DEFAULT_SIZES, DEFAULT_REPETITIONS };
