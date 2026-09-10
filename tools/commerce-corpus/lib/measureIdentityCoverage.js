'use strict';

/**
 * Identity coverage measurement (spec section 29).
 *
 * IMPORTANT HONESTY CONSTRAINT: this lane has no OBSERVED-SHAPE (runtime)
 * evidence at all (STAGING_OBSERVED_SHAPE: UNAVAILABLE). Every number this
 * module produces is therefore a description of what THIS CORPUS CONTAINS,
 * broken out strictly by evidenceClass - never a claim about production
 * traffic prevalence. Section 29 forbids mixing SYNTHETIC coverage into
 * real-data readiness claims; since there is no real (OBSERVED-SHAPE) data
 * to mix it into here, this module keeps SOURCE-SHAPE and SYNTHETIC counted
 * separately and labels the whole result as corpus-composition, not
 * runtime-prevalence, evidence.
 */

const { loadCorpus } = require('./loadCorpus');

function emptyBucket() {
  return {
    offerCount: 0,
    withProviderScopedId: 0,
    withHypotheticalExactCrossRetailerId: 0,
    withSku: 0,
    withGtinUpcEan: 0,
    withNoStableIdentity: 0,
    commerceType: { retail: 0, resale: 0, unknown: 0 },
  };
}

/** Recursively collect any array-of-offer-shaped-objects found under `input`. */
function collectOfferGroups(input) {
  const groups = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const looksLikeOfferArray = node.length > 0 && node.every((el) => el && typeof el === 'object' && !Array.isArray(el));
      if (looksLikeOfferArray && node.some((el) => 'retailer' in el || 'productId' in el || 'hypotheticalTrustedProductId' in el)) {
        groups.push(node);
      }
      node.forEach(walk);
      return;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  }
  walk(input);
  // A record whose `input` IS itself a single offer (no wrapping array) still
  // counts as one offer for the per-offer tallies, as a singleton group.
  if (groups.length === 0 && input && typeof input === 'object' && ('retailer' in input || 'productId' in input)) {
    groups.push([input]);
  }
  return groups;
}

function classifyOffer(offer, bucket) {
  bucket.offerCount += 1;
  const providerScopedId = offer.productId || offer.providerProductId;
  if (typeof providerScopedId === 'string' && providerScopedId.trim()) bucket.withProviderScopedId += 1;
  if (typeof offer.hypotheticalTrustedProductId === 'string' && offer.hypotheticalTrustedProductId.trim()) {
    bucket.withHypotheticalExactCrossRetailerId += 1;
  }
  // SKU/GTIN/UPC/EAN never appear in this corpus's real-schema-grounded
  // records by design (Finding: absent from production schema) - counted
  // for completeness, will remain 0 unless a future fixture legitimately
  // introduces one of these keys.
  if (typeof offer.sku === 'string') bucket.withSku += 1;
  if (typeof offer.gtin === 'string' || typeof offer.upc === 'string' || typeof offer.ean === 'string') {
    bucket.withGtinUpcEan += 1;
  }
  if (!providerScopedId && !offer.hypotheticalTrustedProductId && !offer.sku && !offer.gtin && !offer.upc && !offer.ean) {
    bucket.withNoStableIdentity += 1;
  }

  if (offer.commerceType === 'resale') bucket.commerceType.resale += 1;
  else if (offer.commerceType === 'retail') bucket.commerceType.retail += 1;
  else bucket.commerceType.unknown += 1;
}

function measureIdentityCoverage() {
  const { scenarios } = loadCorpus();
  const byEvidenceClass = { 'SOURCE-SHAPE': emptyBucket(), SYNTHETIC: emptyBucket() };

  let exactIdentityGroups = 0;
  let groupsWithTwoOrMoreOffers = 0;
  let crossRetailerExactGroups = 0;

  for (const { record } of scenarios) {
    const evidenceClass = record.evidenceClass;
    const bucket = byEvidenceClass[evidenceClass];
    if (!bucket) continue; // mutation records etc. carry no evidenceClass/input of this shape

    const groups = collectOfferGroups(record.input);
    for (const group of groups) {
      for (const offer of group) classifyOffer(offer, bucket);

      // Exact-identity sub-grouping within this fixture group: cluster by
      // whichever exact id field is present (productId or the SYNTHETIC
      // hypothetical cross-retailer id), then check group size/retailer span.
      const byExactId = new Map();
      for (const offer of group) {
        const exactId = offer.productId || offer.hypotheticalTrustedProductId;
        if (!exactId) continue;
        if (!byExactId.has(exactId)) byExactId.set(exactId, []);
        byExactId.get(exactId).push(offer);
      }
      for (const members of byExactId.values()) {
        if (members.length < 2) continue;
        exactIdentityGroups += 1;
        groupsWithTwoOrMoreOffers += 1;
        const retailers = new Set(members.map((m) => m.retailer).filter(Boolean));
        if (retailers.size > 1) crossRetailerExactGroups += 1;
      }
    }
  }

  function percentages(bucket) {
    const n = bucket.offerCount || 1; // avoid divide-by-zero; offerCount 0 means all percentages are meaningless 0s
    return {
      ...bucket,
      pctWithProviderScopedId: Math.round((bucket.withProviderScopedId / n) * 100),
      pctWithHypotheticalExactCrossRetailerId: Math.round((bucket.withHypotheticalExactCrossRetailerId / n) * 100),
      pctWithSku: Math.round((bucket.withSku / n) * 100),
      pctWithGtinUpcEan: Math.round((bucket.withGtinUpcEan / n) * 100),
      pctWithNoStableIdentity: Math.round((bucket.withNoStableIdentity / n) * 100),
    };
  }

  return {
    evidenceNote:
      'STAGING_OBSERVED_SHAPE: UNAVAILABLE. Every count below describes THIS CORPUS\'s own fixture composition, kept strictly separate by evidenceClass, and must never be read as a production runtime-prevalence claim.',
    bySourceShape: percentages(byEvidenceClass['SOURCE-SHAPE']),
    bySynthetic: percentages(byEvidenceClass.SYNTHETIC),
    exactIdentityGroups,
    groupsWithTwoOrMoreOffers,
    crossRetailerExactGroups,
  };
}

module.exports = { measureIdentityCoverage, collectOfferGroups };
