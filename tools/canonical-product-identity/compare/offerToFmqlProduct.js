'use strict';

/**
 * Pure field-mapping adapter: RetailOffer -> the exact field names
 * tools/fashion-match-quality/duplicates/duplicateClassifier.js already
 * reads (Addendum A.3 decision memo DM-003). Introduces no matching logic
 * of its own and makes zero changes to FMQL - see the memo for why this
 * shape, not a modification to duplicateClassifier.js, is the correct seam.
 */

function offerToFmqlProduct(offer) {
  return {
    id: offer.offerId,
    identitySku: offer.manufacturerStyleCode || offer.retailerSku || null,
    purchaseUrl: offer.canonicalUrl || offer.url || null,
    brand: offer.brand || null,
    title: offer.title || null,
    category: offer.category || null,
    color: offer.color || null,
    silhouette: offer.silhouette || null,
    material: offer.material || null,
    imageUrl: offer.imageUrl || null,
    retailer: offer.retailer || null,
  };
}

module.exports = { offerToFmqlProduct };
