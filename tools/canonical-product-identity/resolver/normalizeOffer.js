'use strict';

/**
 * Produce a normalized view of a RetailOffer for comparison. Pure function,
 * zero network, deterministic (spec section 24 DETERMINISM). This is the
 * ONLY place tier1/tier2 read raw offer fields from - they never touch
 * `offer.*` directly, so every comparison rule is provably applied to
 * normalized values.
 */

const { normalizeGtin, normalizeCode } = require('../lib/identifierNormalize');
const { normalizeText, tokenize, canonicalizeUrl } = require('../lib/textNormalize');

function lower(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeOffer(offer) {
  const gtin = offer.gtin ? normalizeGtin(offer.gtin) : null;
  return {
    offerId: offer.offerId,
    retailer: lower(offer.retailer),
    brand: lower(offer.brand),
    category: lower(offer.category),
    color: lower(offer.color),
    material: lower(offer.material),
    pattern: lower(offer.pattern),
    silhouette: lower(offer.silhouette),
    season: lower(offer.season),
    constructionDetails: Array.isArray(offer.constructionDetails)
      ? new Set(offer.constructionDetails.filter((d) => typeof d === 'string').map((d) => d.trim().toLowerCase()))
      : null,
    sellerType: offer.sellerType || null,
    titleRaw: offer.title || null,
    titleNormalized: normalizeText(offer.title),
    titleTokens: tokenize(offer.title),
    gtin: gtin && gtin.valid ? gtin.normalized : null,
    gtinPresent: Boolean(offer.gtin),
    gtinValid: Boolean(gtin && gtin.valid),
    mpn: normalizeCode(offer.mpn),
    manufacturerStyleCode: normalizeCode(offer.manufacturerStyleCode),
    retailerSku: normalizeCode(offer.retailerSku),
    canonicalUrl: canonicalizeUrl(offer.canonicalUrl || offer.url),
    imageUrl: offer.imageUrl || null,
    price: typeof offer.price === 'number' ? offer.price : null,
  };
}

module.exports = { normalizeOffer };
