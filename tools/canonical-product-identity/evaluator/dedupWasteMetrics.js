'use strict';

/**
 * Aggregate spec section 24's set-level metrics (DUPLICATE-INVENTORY
 * WASTE@K, UNIQUE CANONICAL PRODUCTS@K, RETAILER-DIVERSITY DELTA) across
 * every candidate-set window built by simulate/candidateEconomics.js.
 */

const { buildAllWindows, DEFAULT_K_SIZES } = require('../simulate/candidateEconomics');

function average(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function aggregateDedupWasteMetrics(corpus, { kSizes = DEFAULT_K_SIZES, pairwiseResults } = {}) {
  const { windows } = buildAllWindows(corpus, { kSizes, pairwiseResults });

  const byK = {};
  for (const K of kSizes) {
    const atK = windows.filter((w) => w.windowSize === K);
    byK[K] = {
      windowCount: atK.length,
      averageWasteRaw: average(atK.map((w) => w.wasteRaw)),
      averageWasteCanonical: average(atK.map((w) => w.wasteCanonical)),
      averageWasteOracle: average(atK.map((w) => w.wasteOracle)),
      averageWasteDelta: average(atK.map((w) => w.wasteDelta)),
      averageUniqueCanonicalProducts: average(atK.map((w) => w.uniqueCanonicalProductsAtK)),
      averageConcentrationDelta: average(atK.map((w) => w.retailerDiversity.concentrationDelta)),
    };
  }

  return {
    kSizes,
    perWindow: windows.map((w) => ({
      category: w.category,
      windowSize: w.windowSize,
      poolSize: w.poolSize,
      rawCount: w.rawCount,
      canonicalCount: w.canonicalCount,
      oracleCount: w.oracleCount,
      wasteRaw: w.wasteRaw,
      wasteCanonical: w.wasteCanonical,
      wasteOracle: w.wasteOracle,
      wasteDelta: w.wasteDelta,
      retailerDiversity: w.retailerDiversity,
    })),
    byK,
    note: 'Windows are synthetic category pools drawn deterministically from the committed corpus (Addendum A.3 decision memo DM-004), not a modeled real query distribution. wasteRaw uses production\'s own exact-id/exact-normalized-URL dedup method (authority/sourceMap.json); wasteCanonical uses this lab\'s resolver (AUTO_MERGE-only variant clusters); wasteOracle uses the generator-known ground truth as an upper bound on achievable reduction.',
  };
}

module.exports = { aggregateDedupWasteMetrics };
