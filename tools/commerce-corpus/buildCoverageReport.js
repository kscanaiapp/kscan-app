#!/usr/bin/env node
'use strict';

/**
 * Builds the machine-readable coverage report (spec section 46) at
 * artifacts/commerce-corpus-coverage.json.
 *
 * Mechanical counts (scenario/category/tag/evidence-class tallies, identity
 * coverage) are computed directly from the corpus on disk. The doctrine
 * verdicts (grouping readiness, price-freshness authority, affiliate
 * authority, per-garment status) are NOT computed from the corpus - they are
 * conclusions from docs/commerce-corpus/01-commerce-shape-census.md's direct
 * source inspection, stated here as constants with their citation, exactly
 * as a human reviewer would record them. Do not infer these from fixture
 * counts; the corpus is ~100 illustrative scenarios, not a runtime sample,
 * and Section 30/48/49 forbid letting SYNTHETIC fixture volume manufacture
 * a verdict.
 *
 * Usage: node tools/commerce-corpus/buildCoverageReport.js
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadCorpus } = require('./lib/loadCorpus');
const { measureIdentityCoverage } = require('./lib/measureIdentityCoverage');
const { canonicalHash, stripVolatile } = require('./lib/canonicalJson');

const OUT_PATH = path.resolve(__dirname, '../../artifacts/commerce-corpus-coverage.json');

// Doctrine verdicts - see docs/commerce-corpus/01-commerce-shape-census.md
// and docs/commerce-corpus/02-final-report.md for the full reasoning.
const DOCTRINE = {
  stagingObservedShape: 'UNAVAILABLE',
  priceFreshnessAuthority: 'PARTIAL',
  priceFreshnessCitation:
    'PRESENT at the Watchlist layer (user_commerce_watches.last_checked_at, CommerceWatchEvent.observedAt) and the dormant backend v127 canonical layer (CanonicalOffer.observedAt); ABSENT on CanonicalPurchaseOption/PurchaseOption/WatchCandidate/RankedScanProduct, the shapes that render ordinary shelves.',
  affiliateAuthority: 'ABSENT',
  affiliateAuthorityCitation:
    'affiliateUrl is a passthrough field slot only; every real fixture in data/catalog.json has it null; no affiliate/click/tracking/network ID minting exists anywhere in source (zero grep hits).',
  perGarmentCommerce: 'PRESENT',
  perGarmentCommerceCitation:
    'services/multiItemCommerce.ts fetchMultiItemCommerce produces an independent Map<candidateId, ItemCommerceCard> per detected garment, Promise.allSettled-isolated, with 11 dedicated test files.',
  exactGroupingReadiness: 'NOT_YET',
  exactGroupingReadinessCitation:
    'No production type carries a governed, cross-retailer-comparable exact product identifier (no GTIN/SKU/UPC/EAN anywhere; productId/providerProductId are provider-scoped). The one mechanism that attempts cross-retailer grouping (canonicalProductKey, brand+title-token heuristic) is dormant/unconsumed and is explicitly documented in-source (watchlistCapability.ts:9-11) as merging colorways and being unstable under a retailer re-title - the exact must-not-group failure mode this corpus tests for. See Finding F2.',
  prCRecommendation: 'DEFER',
  groupingImplication:
    'Cannot be quantified from OBSERVED-SHAPE evidence because none exists in this lane, and cannot be quantified from source-shape evidence either, because the source-level identity model provides no cross-retailer exact key at all to count against - stating a percentage here would itself be a fabricated number. Commerce V2 PR C should not build a grouped purchase-option ladder against canonicalProductKey without first introducing a real exact cross-retailer identity field.',
};

function tally(scenarios, keyFn) {
  const out = {};
  for (const scenario of scenarios) {
    const key = keyFn(scenario);
    if (key === undefined || key === null) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function tallyTags(scenarios) {
  const out = {};
  for (const { record } of scenarios) {
    for (const tag of record.tags || []) out[tag] = (out[tag] || 0) + 1;
  }
  return out;
}

function buildReport() {
  const { manifest, scenarios } = loadCorpus();
  const identity = measureIdentityCoverage();

  const byCategory = tally(scenarios, (s) => s.manifestEntry.category);
  const byEvidenceClass = tally(scenarios, (s) => s.manifestEntry.evidenceClass);
  const byTag = tallyTags(scenarios);

  const report = {
    commerceCorpusVersion: manifest.commerceCorpusVersion,
    generatedBy: 'tools/commerce-corpus/buildCoverageReport.js',
    stagingObservedShape: DOCTRINE.stagingObservedShape,
    scenarioCounts: {
      total: scenarios.length,
      byCategory,
      byEvidenceClass,
      byTag,
    },
    retailResaleCoverage: {
      retail: byTag.retail || 0,
      resale: byTag.resale || 0,
    },
    retailerTruthCoverage: {
      knownRetailer: byTag['retailer-truth'] || 0,
      unknownRetailer: byTag['unknown-retailer'] || 0,
      missingLogo: byTag['missing-logo'] || 0,
      brandRetailerDistinctionCases: byTag['brand-retailer'] || 0,
    },
    watchCoverage: {
      watchable: byTag.watchable || 0,
      notWatchable: byTag['not-watchable'] || 0,
    },
    currencyCoverage: {
      scenarios: byTag.currency || 0,
    },
    groupingCoverage: {
      exactGroupCases: byTag['exact-group'] || 0,
      mustNotGroupCases: byTag['must-not-group'] || 0,
    },
    failureCoverage: {
      scenarios: byTag.failure || 0,
    },
    scaleCoverage: {
      scenarios: byTag.scale || 0,
    },
    urlSafetyCoverage: {
      safeUrl: byTag['safe-url'] || 0,
      unsafeUrl: byTag['unsafe-url'] || 0,
    },
    attributionCoverage: {
      scenarios: byTag.attribution || 0,
      affiliateAuthority: DOCTRINE.affiliateAuthority,
      affiliateAuthorityCitation: DOCTRINE.affiliateAuthorityCitation,
      fabricatedAffiliateIds: 0,
    },
    prSupportCoverage: {
      prA: byTag['pr-a-support'] || 0,
      prB: byTag['pr-b-support'] || 0,
      prC: byTag['pr-c-support'] || 0,
    },
    identityCoverage: identity,
    perGarmentCommerce: {
      status: DOCTRINE.perGarmentCommerce,
      citation: DOCTRINE.perGarmentCommerceCitation,
    },
    priceFreshnessAuthority: {
      status: DOCTRINE.priceFreshnessAuthority,
      citation: DOCTRINE.priceFreshnessCitation,
    },
    groupingReadiness: {
      verdict: DOCTRINE.exactGroupingReadiness,
      citation: DOCTRINE.exactGroupingReadinessCitation,
      prCRecommendation: DOCTRINE.prCRecommendation,
      groupingImplication: DOCTRINE.groupingImplication,
    },
  };

  report.contentHash = canonicalHash(stripVolatile(report, ['contentHash', 'generatedAt']));
  report.generatedAt = new Date().toISOString().slice(0, 10); // date only, so re-runs on the same day are byte-identical

  return report;
}

function main() {
  const report = buildReport();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${OUT_PATH}`);
  console.log(`  total scenarios: ${report.scenarioCounts.total}`);
  console.log(`  grouping readiness: ${report.groupingReadiness.verdict} / PR C: ${report.groupingReadiness.prCRecommendation}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildReport };
