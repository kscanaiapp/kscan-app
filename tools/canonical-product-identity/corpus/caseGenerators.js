'use strict';

/**
 * Named case generators (spec sections 21 REQUIRED SYNTHETIC CASES and 22
 * ADVERSARIAL CORPUS; Addendum A.4 - UNDECIDABLE cases are CONSTRUCTED by
 * stripping evidence, never labeled after the fact).
 *
 * Every case function has signature (rng, instanceIndex) -> {
 *   offers: RetailOffer[],
 *   styles: CanonicalStyle[],       // this case's contribution to the generator-known graph
 *   pairOverrides: PairOverride[],  // only for NEAR_DUPLICATE_DISTINCT / UNDECIDABLE - see corpus/groundTruth.js
 * }
 *
 * Ground truth is NEVER attached to an offer directly. It is always derived
 * from (a) which variant/style an offer belongs to in `styles`, or (b) an
 * explicit override for the handful of cases where the structural graph
 * default would be wrong (adjacent-but-different styles, or deliberately
 * evidence-stripped pairs). See corpus/groundTruth.js#groundTruthForPair.
 */

const { makeOffer } = require('../lib/offerFactory');
const { generateValidGtin13 } = require('../lib/identifierNormalize');
const { CATEGORY_STYLES, CATEGORY_KEYS, BRANDS, RETAILERS, MARKETPLACE_RETAILERS, OUTLET_RETAILERS, SEASONS, TRACKING_SUFFIXES } = require('../lib/fashionWorld');

function pickTemplate(rng) {
  const key = rng.pick(CATEGORY_KEYS);
  return CATEGORY_STYLES[key];
}

function buildTitle(brand, styleName, color, material) {
  const parts = [brand, styleName];
  const descriptors = [color, material].filter(Boolean);
  return descriptors.length ? `${parts.join(' ')} - ${descriptors.map((d) => cap(d)).join(' ')}` : parts.join(' ');
}

function cap(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function styleId(caseId, idx, n = 1) {
  return `${caseId}-${idx}-style${n}`;
}
function variantId(caseId, idx, n, v) {
  return `${caseId}-${idx}-style${n}-variant${v}`;
}
function offerId(caseId, idx, tag) {
  return `${caseId}-${idx}-${tag}`;
}

// ── 1. True duplicate across retailers ──────────────────────────────────────
function caseTrueDuplicateAcrossRetailers(rng, idx) {
  const caseId = 'true-duplicate-cross-retailer';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  const [retailerA, retailerB] = [rng.pick(RETAILERS), rng.pick(RETAILERS)];
  const title = buildTitle(brand, styleName, color, material);
  const oA = makeOffer({
    offerId: offerId(caseId, idx, 'a'), retailer: retailerA, brand, title, category: t.category,
    color, material, gtin, price: 475, url: `https://${retailerA.toLowerCase().replace(/\s/g, '')}.com/p/${idx}-a`,
  });
  const oB = makeOffer({
    offerId: offerId(caseId, idx, 'b'), retailer: retailerB, brand, title, category: t.category,
    color, material, gtin, price: 495, url: `https://${retailerB.toLowerCase().replace(/\s/g, '')}.com/p/${idx}-b`,
  });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 2. Same retailer, different URLs (tracking params / mobile) ────────────
function caseSameRetailerDifferentUrls(rng, idx) {
  const caseId = 'same-retailer-different-urls';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const retailer = rng.pick(RETAILERS);
  const title = buildTitle(brand, styleName, color, material);
  const baseUrl = `https://${retailer.toLowerCase().replace(/\s/g, '')}.com/product/${idx}`;
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer, brand, title, category: t.category, color, material, url: `${baseUrl}${rng.pick(TRACKING_SUFFIXES)}` });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer, brand, title, category: t.category, color, material, url: `${baseUrl}${rng.pick(TRACKING_SUFFIXES)}` });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 3. Same style, different size inventory (must remain same variant) ─────
function caseSameStyleDifferentSizeInventory(rng, idx) {
  const caseId = 'same-style-different-size-inventory';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  const title = buildTitle(brand, styleName, color, material);
  const retailer = rng.pick(RETAILERS);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer, brand, title, category: t.category, color, material, gtin, sizeAvailable: ['S', 'M'] });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer, brand, title, category: t.category, color, material, gtin, sizeAvailable: ['L', 'XL'] });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 4. Same style, different color (sibling variants) ──────────────────────
function caseSameStyleDifferentColor(rng, idx) {
  const caseId = 'same-style-different-color';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const [colorA, colorB] = rng.pick(t.colors) === t.colors[0] ? [t.colors[0], t.colors[1]] : [t.colors[0], t.colors[1]];
  const material = rng.pick(t.materials);
  const retailer = rng.pick(RETAILERS);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer, brand, title: buildTitle(brand, styleName, colorA, material), category: t.category, color: colorA, material });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer, brand, title: buildTitle(brand, styleName, colorB, material), category: t.category, color: colorB, material });
  return {
    offers: [oA, oB],
    styles: [{
      styleId: styleId(caseId, idx), brand, styleName, category: t.category,
      variants: [
        { variantId: variantId(caseId, idx, 1, 'A'), color: colorA, material, offerIds: [oA.offerId] },
        { variantId: variantId(caseId, idx, 1, 'B'), color: colorB, material, offerIds: [oB.offerId] },
      ],
    }],
    pairOverrides: [],
  };
}

// ── 5. Same style, different material (sibling variant where commercially meaningful) ──
function caseSameStyleDifferentMaterial(rng, idx) {
  const caseId = 'same-style-different-material';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const [materialA, materialB] = [t.materials[0], t.materials[1]];
  const retailer = rng.pick(RETAILERS);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer, brand, title: buildTitle(brand, styleName, color, materialA), category: t.category, color, material: materialA });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer, brand, title: buildTitle(brand, styleName, color, materialB), category: t.category, color, material: materialB });
  return {
    offers: [oA, oB],
    styles: [{
      styleId: styleId(caseId, idx), brand, styleName, category: t.category,
      variants: [
        { variantId: variantId(caseId, idx, 1, 'A'), color, material: materialA, offerIds: [oA.offerId] },
        { variantId: variantId(caseId, idx, 1, 'B'), color, material: materialB, offerIds: [oB.offerId] },
      ],
    }],
    pairOverrides: [],
  };
}

// ── 6. Similar title, same brand, different style (must not merge) ─────────
function caseSimilarTitleSameBrandDifferentStyle(rng, idx) {
  const caseId = 'similar-title-same-brand-different-style';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const [styleNameA, styleNameB] = [t.styleNames[0], t.styleNames[1]];
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const retailer = rng.pick(RETAILERS);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer, brand, title: buildTitle(brand, styleNameA, color, material), category: t.category, color, material });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer, brand, title: buildTitle(brand, styleNameB, color, material), category: t.category, color, material });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName: styleNameA, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName: styleNameB, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 7. Same category/color/material, different brand (must not merge) ──────
function caseSameAttributesDifferentBrand(rng, idx) {
  const caseId = 'same-attributes-different-brand';
  const t = pickTemplate(rng);
  const [brandA, brandB] = [BRANDS[idx % BRANDS.length], BRANDS[(idx + 1) % BRANDS.length]];
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand: brandA, title: buildTitle(brandA, styleName, color, material), category: t.category, color, material });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand: brandB, title: buildTitle(brandB, styleName, color, material), category: t.category, color, material });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand: brandA, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand: brandB, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 8. Missing GTIN, falls through safely (still resolvable via supporting evidence) ──
function caseMissingGtinFallsThroughSafely(rng, idx) {
  const caseId = 'missing-gtin-falls-through-safely';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const title = buildTitle(brand, styleName, color, material);
  const [retailerA, retailerB] = [rng.pick(RETAILERS), rng.pick(RETAILERS)];
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: retailerA, brand, title, category: t.category, color, material });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: retailerB, brand, title, category: t.category, color, material });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 9. Conflicting IDs (different validated GTIN despite similar supporting evidence) ──
function caseConflictingIds(rng, idx) {
  const caseId = 'conflicting-ids';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const title = buildTitle(brand, styleName, color, material);
  const gtinA = generateValidGtin13(rng);
  const gtinB = generateValidGtin13(rng.child(`${idx}-b`));
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title, category: t.category, color, material, gtin: gtinA });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title, category: t.category, color, material, gtin: gtinB });
  // Structurally two different styles (default DISTINCT) - the point of this
  // case is that supporting evidence looks like a match but the strong
  // identifiers conflict, so the resolver must SEPARATE, not AUTO_MERGE.
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 10. Marketplace/reseller listing (correct identity, separate Offer) ────
function caseMarketplaceReseller(rng, idx) {
  const caseId = 'marketplace-reseller';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  const title = buildTitle(brand, styleName, color, material);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title, category: t.category, color, material, gtin, sellerType: 'authorized_retailer', price: 650 });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(MARKETPLACE_RETAILERS), brand, title, category: t.category, color, material, gtin, sellerType: 'marketplace_seller', price: 410 });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 11. Sale-price difference (must not split identity) ────────────────────
function caseSalePriceDifference(rng, idx) {
  const caseId = 'sale-price-difference';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  const title = buildTitle(brand, styleName, color, material);
  const retailer = rng.pick(RETAILERS);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer, brand, title, category: t.category, color, material, gtin, price: 298 });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer, brand, title, category: t.category, color, material, gtin, price: 149 });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 12. Large retailer price difference (must not split identity) ──────────
function caseLargeRetailerPriceDifference(rng, idx) {
  const caseId = 'large-retailer-price-difference';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  const title = buildTitle(brand, styleName, color, material);
  const [retailerA, retailerB, retailerC] = [rng.pick(RETAILERS), rng.pick(RETAILERS), rng.pick(RETAILERS)];
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: retailerA, brand, title, category: t.category, color, material, gtin, price: 475 });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: retailerB, brand, title, category: t.category, color, material, gtin, price: 525 });
  const oC = makeOffer({ offerId: offerId(caseId, idx, 'c'), retailer: retailerC, brand, title, category: t.category, color, material, gtin, price: 700 });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB, oC],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId, oC.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 13. Near-identical photography, different product (DISTINCT) ──────────
function caseNearIdenticalPhotographyDifferentProduct(rng, idx) {
  const caseId = 'near-identical-photography-different-product';
  const t = pickTemplate(rng);
  const [brandA, brandB] = [BRANDS[idx % BRANDS.length], BRANDS[(idx + 3) % BRANDS.length]];
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const sharedImage = `https://cdn.example-retail.com/studio/${t.category}-${color}-${idx}.jpg`;
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand: brandA, title: buildTitle(brandA, t.styleNames[0], color, material), category: t.category, color, material, imageUrl: sharedImage });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand: brandB, title: buildTitle(brandB, t.styleNames[1], color, material), category: t.category, color, material, imageUrl: sharedImage });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand: brandA, styleName: t.styleNames[0], category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand: brandB, styleName: t.styleNames[1], category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 14. Different photography, same product (SAME_VARIANT) ─────────────────
function caseDifferentPhotographySameProduct(rng, idx) {
  const caseId = 'different-photography-same-product';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  const title = buildTitle(brand, styleName, color, material);
  const [retailerA, retailerB] = [rng.pick(RETAILERS), rng.pick(RETAILERS)];
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: retailerA, brand, title, category: t.category, color, material, gtin, imageUrl: `https://cdn.${retailerA.toLowerCase().replace(/\s/g, '')}.com/studioA/${idx}.jpg` });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: retailerB, brand, title, category: t.category, color, material, gtin, imageUrl: `https://cdn.${retailerB.toLowerCase().replace(/\s/g, '')}.com/lifestyleB/${idx}.jpg` });
  const vId = variantId(caseId, idx, 1, 'A');
  return {
    offers: [oA, oB],
    styles: [{ styleId: styleId(caseId, idx), brand, styleName, category: t.category, variants: [{ variantId: vId, color, material, offerIds: [oA.offerId, oB.offerId] }] }],
    pairOverrides: [],
  };
}

// ── 15. Previous-season / adjacent model (hard negative -> NEAR_DUPLICATE_DISTINCT) ──
function casePreviousSeasonAdjacentModel(rng, idx) {
  const caseId = 'previous-season-adjacent-model';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const [seasonA, seasonB] = [SEASONS[0], SEASONS[2]];
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(OUTLET_RETAILERS), brand, title: `${buildTitle(brand, styleName, color, material)} (${seasonA})`, category: t.category, color, material, season: seasonA, sellerType: 'outlet' });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title: buildTitle(brand, styleName, color, material), category: t.category, color, material, season: seasonB });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [{ offerIdA: oA.offerId, offerIdB: oB.offerId, label: 'NEAR_DUPLICATE_DISTINCT', reason: 'previous_season_outlet_vs_current_season_no_manufacturer_evidence_of_equivalence' }],
  };
}

// ── 16. Same brand/category/color, almost-identical title, different style code ──
function caseAdjacentStyleCodeAttack(rng, idx) {
  const caseId = 'adjacent-style-code-attack';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const codeA = `${styleName.slice(0, 2).toUpperCase()}-${1000 + idx}`;
  const codeB = `${styleName.slice(0, 2).toUpperCase()}-${2000 + idx}`;
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title: buildTitle(brand, styleName, color, material), category: t.category, color, material, manufacturerStyleCode: codeA });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title: buildTitle(brand, styleName, color, material), category: t.category, color, material, manufacturerStyleCode: codeB });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 17. Same product title, different season ────────────────────────────────
function caseSameTitleDifferentSeason(rng, idx) {
  const caseId = 'same-title-different-season';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const title = buildTitle(brand, styleName, color, material);
  const [seasonA, seasonB] = [SEASONS[1], SEASONS[3]];
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title, category: t.category, color, material, season: seasonA });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title, category: t.category, color, material, season: seasonB });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [{ offerIdA: oA.offerId, offerIdB: oB.offerId, label: 'NEAR_DUPLICATE_DISTINCT', reason: 'identical_title_different_season_tag_no_manufacturer_continuity_evidence' }],
  };
}

// ── 18. Same manufacturer family, mens vs womens construction (DISTINCT) ────
function caseMensVsWomensConstruction(rng, idx) {
  const caseId = 'mens-vs-womens-construction';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title: `${buildTitle(brand, styleName, color, material)} - Womens`, category: t.category, color, material, constructionDetails: ['womens_fit'] });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title: `${buildTitle(brand, styleName, color, material)} - Mens`, category: t.category, color, material, constructionDetails: ['mens_fit'] });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName: `${styleName} Womens`, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName: `${styleName} Mens`, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 19. Retailer removes style suffix (looks identical, genuinely different model) ──
function caseRetailerRemovesStyleSuffix(rng, idx) {
  const caseId = 'retailer-removes-style-suffix';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title: buildTitle(brand, styleName, color, material), category: t.category, color, material, manufacturerStyleCode: `V2-${idx}` });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title: buildTitle(brand, styleName, color, material), category: t.category, color, material, manufacturerStyleCode: `V1-${idx}` });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName: `${styleName} V2`, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName: `${styleName} V1`, category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color, material, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [],
  };
}

// ── 20a. One listing lacks every strong identifier (evidence stripped -> UNDECIDABLE) ──
function caseEvidenceStrippedListing(rng, idx) {
  const caseId = 'evidence-stripped-listing';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  const color = rng.pick(t.colors);
  const material = rng.pick(t.materials);
  const gtin = generateValidGtin13(rng);
  // Full-evidence offer.
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title: buildTitle(brand, styleName, color, material), category: t.category, color, material, gtin });
  // Deliberately stripped: only retailer + generic title survive - no brand,
  // no category, no color, no material, no identifiers. Nothing in the
  // resolver's evidence set can decide this pair either way.
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), title: 'Item', price: oA.price });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName, category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color, material, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand: null, styleName: 'unknown', category: null, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color: null, material: null, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [{ offerIdA: oA.offerId, offerIdB: oB.offerId, label: 'UNDECIDABLE', reason: 'counterpart_offer_evidence_stripped_to_generic_title_only' }],
  };
}

// ── 20b. Same physical item in truth, but title neutralized + color removed on both sides (UNDECIDABLE) ──
function caseBothSidesEvidenceNeutralized(rng, idx) {
  const caseId = 'both-sides-evidence-neutralized';
  const t = pickTemplate(rng);
  const brand = rng.pick(BRANDS);
  const styleName = rng.pick(t.styleNames);
  // Deliberately neutralized: brand present (so it isn't a total void, this
  // targets a different evidence-stripping shape than case 20a) but title is
  // generic, no color, no material, no category, no identifiers on EITHER
  // side - a resolver cannot honestly decide this from the evidence given.
  const oA = makeOffer({ offerId: offerId(caseId, idx, 'a'), retailer: rng.pick(RETAILERS), brand, title: `${brand} Item` });
  const oB = makeOffer({ offerId: offerId(caseId, idx, 'b'), retailer: rng.pick(RETAILERS), brand, title: `${brand} Item` });
  return {
    offers: [oA, oB],
    styles: [
      { styleId: styleId(caseId, idx, 1), brand, styleName: 'unknown', category: t.category, variants: [{ variantId: variantId(caseId, idx, 1, 'A'), color: null, material: null, offerIds: [oA.offerId] }] },
      { styleId: styleId(caseId, idx, 2), brand, styleName: 'unknown', category: t.category, variants: [{ variantId: variantId(caseId, idx, 2, 'A'), color: null, material: null, offerIds: [oB.offerId] }] },
    ],
    pairOverrides: [{ offerIdA: oA.offerId, offerIdB: oB.offerId, label: 'UNDECIDABLE', reason: 'both_sides_title_neutralized_no_category_color_material_or_identifier_evidence' }],
  };
}

const REGISTRY = [
  { caseId: 'true-duplicate-cross-retailer', requirementRef: 'section21#1', fn: caseTrueDuplicateAcrossRetailers },
  { caseId: 'same-retailer-different-urls', requirementRef: 'section21#2', fn: caseSameRetailerDifferentUrls },
  { caseId: 'same-style-different-size-inventory', requirementRef: 'section21#3', fn: caseSameStyleDifferentSizeInventory },
  { caseId: 'same-style-different-color', requirementRef: 'section21#4', fn: caseSameStyleDifferentColor },
  { caseId: 'same-style-different-material', requirementRef: 'section21#5', fn: caseSameStyleDifferentMaterial },
  { caseId: 'similar-title-same-brand-different-style', requirementRef: 'section21#6', fn: caseSimilarTitleSameBrandDifferentStyle },
  { caseId: 'same-attributes-different-brand', requirementRef: 'section21#7', fn: caseSameAttributesDifferentBrand },
  { caseId: 'missing-gtin-falls-through-safely', requirementRef: 'section21#8', fn: caseMissingGtinFallsThroughSafely },
  { caseId: 'conflicting-ids', requirementRef: 'section21#9', fn: caseConflictingIds },
  { caseId: 'marketplace-reseller', requirementRef: 'section21#10', fn: caseMarketplaceReseller },
  { caseId: 'sale-price-difference', requirementRef: 'section21#11', fn: caseSalePriceDifference },
  { caseId: 'large-retailer-price-difference', requirementRef: 'section21#12', fn: caseLargeRetailerPriceDifference },
  { caseId: 'near-identical-photography-different-product', requirementRef: 'section21#13', fn: caseNearIdenticalPhotographyDifferentProduct },
  { caseId: 'different-photography-same-product', requirementRef: 'section21#14', fn: caseDifferentPhotographySameProduct },
  { caseId: 'previous-season-adjacent-model', requirementRef: 'section21#15', fn: casePreviousSeasonAdjacentModel },
  { caseId: 'adjacent-style-code-attack', requirementRef: 'section22#adversarial1', fn: caseAdjacentStyleCodeAttack },
  { caseId: 'same-title-different-season', requirementRef: 'section22#adversarial2', fn: caseSameTitleDifferentSeason },
  { caseId: 'mens-vs-womens-construction', requirementRef: 'section22#adversarial3', fn: caseMensVsWomensConstruction },
  { caseId: 'retailer-removes-style-suffix', requirementRef: 'section22#adversarial4', fn: caseRetailerRemovesStyleSuffix },
  { caseId: 'evidence-stripped-listing', requirementRef: 'section22#adversarial5 / A.4-undecidable-1', fn: caseEvidenceStrippedListing },
  { caseId: 'both-sides-evidence-neutralized', requirementRef: 'A.4-undecidable-2', fn: caseBothSidesEvidenceNeutralized },
];

module.exports = { REGISTRY };
