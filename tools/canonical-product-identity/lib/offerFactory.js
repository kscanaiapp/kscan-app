'use strict';

/**
 * Shared RetailOffer construction helper. Used by both the ground-truth
 * corpus case generators (corpus/caseGenerators.js) and the resolver
 * performance harness (simulate/resolverPerformance.js), so both draw
 * offers with the same field shape the resolver actually consumes.
 */

let offerCounter = 0;

function resetOfferCounter() {
  offerCounter = 0;
}

/** Build a RetailOffer. Every field is explicit or defaulted to null/undefined - never fabricated silently. */
function makeOffer(fields = {}) {
  offerCounter += 1;
  const offerId = fields.offerId || `offer-${offerCounter.toString(36)}`;
  return {
    offerId,
    retailer: fields.retailer || 'UnknownRetailer',
    externalProductId: fields.externalProductId ?? null,
    url: fields.url ?? null,
    canonicalUrl: fields.canonicalUrl ?? fields.url ?? null,
    price: fields.price ?? null,
    currency: fields.currency ?? 'USD',
    availability: fields.availability ?? 'in_stock',
    sizeAvailable: fields.sizeAvailable ?? null,
    gtin: fields.gtin ?? null,
    mpn: fields.mpn ?? null,
    manufacturerStyleCode: fields.manufacturerStyleCode ?? null,
    retailerSku: fields.retailerSku ?? null,
    brand: fields.brand ?? null,
    title: fields.title ?? null,
    category: fields.category ?? null,
    color: fields.color ?? null,
    material: fields.material ?? null,
    pattern: fields.pattern ?? null,
    silhouette: fields.silhouette ?? null,
    constructionDetails: fields.constructionDetails ?? null,
    imageUrl: fields.imageUrl ?? null,
    season: fields.season ?? null,
    sellerType: fields.sellerType ?? 'authorized_retailer',
  };
}

module.exports = { makeOffer, resetOfferCounter };
