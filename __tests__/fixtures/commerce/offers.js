/**
 * Commerce V2 seeded corpus (Build 35 §10).
 *
 * The test authority for the Commerce V2 lane: retailer identity, purchase
 * options, Shop/Watch presentation. Every case below is a plausible shape a
 * real commerce surface in this app already produces (ProductShelf,
 * PurchaseOptionsPanel, Dressing Room snapshots, Watchlist) -- see
 * `services/commerce/retailerRegistry.ts`'s header comment for where each
 * registered retailer/domain comes from. Nothing here is a live network
 * fixture; this file is imported, never executed as a suite (matches the
 * `__tests__/fixtures/` convention -- excluded from test discovery by
 * `scripts/run-all-tests.js`).
 *
 * Each entry carries an `offer` (the raw record a resolver/normalizer would
 * receive) and an `expected` block a test asserts against, so this file
 * doubles as living documentation of what SHOULD happen for each shape.
 */

'use strict';

/**
 * One offer per required Build 35 §10 edge case. `caseId` values are stable
 * identifiers tests reference directly (never index into the array).
 */
const RETAILER_OFFERS = [
  // ---- Multiple brands, multiple retailers, retail vs resale ----------
  {
    caseId: 'retail_farfetch_declared',
    description: 'Retail offer with an explicit, registered retailer field. Brand and retailer are different and must stay different.',
    offer: {
      id: 'offer-1',
      title: 'Denim Jacket',
      brand: "Levi's",
      retailer: 'Farfetch',
      price: 425,
      currency: 'USD',
      productUrl: 'https://www.farfetch.com/shopping/women/levis-denim-jacket-item-1.aspx',
      imageUrl: 'https://images.example.test/farfetch/denim-jacket.jpg',
      commerceType: 'retail',
      watchCapability: 'refreshable_listing',
    },
    expected: {
      retailerKey: 'farfetch',
      displayName: 'Farfetch',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },
  {
    caseId: 'resale_poshmark_declared',
    description: 'Resale offer, explicit registered retailer, different brand.',
    offer: {
      id: 'offer-2',
      title: 'Wool Coat',
      brand: 'Max Mara',
      retailer: 'Poshmark',
      price: 210,
      currency: 'USD',
      productUrl: 'https://poshmark.com/listing/wool-coat-abc123',
      imageUrl: 'https://images.example.test/poshmark/wool-coat.jpg',
      commerceType: 'resale',
    },
    expected: {
      retailerKey: 'poshmark',
      displayName: 'Poshmark',
      sourceAuthority: 'declared',
      commerceType: 'resale',
    },
  },
  {
    caseId: 'resale_vinted_source_field',
    description: 'Resale offer declared via `source` (Vinted secondhand shape) rather than `retailer`.',
    offer: {
      id: 'offer-3',
      title: 'Leather Mini Skirt',
      brand: 'Coach',
      source: 'vinted',
      price: 95,
      currency: 'EUR',
      productUrl: 'https://www.vinted.com/items/12345-leather-mini-skirt',
      imageUrl: 'https://images.example.test/vinted/mini-skirt.jpg',
      commerceType: 'resale',
    },
    expected: {
      retailerKey: 'vinted',
      displayName: 'Vinted',
      sourceAuthority: 'declared',
      commerceType: 'resale',
    },
  },
  {
    caseId: 'retail_kickscrew_merchant_field',
    description: 'Retail offer declared via `merchant` (older/alternate field name some callers use).',
    offer: {
      id: 'offer-4',
      title: 'Jadon III Pisa Boots',
      brand: 'Dr. Martens',
      merchant: 'KicksCrew',
      price: 220,
      currency: 'USD',
      productUrl: 'https://www.kickscrew.com/products/jadon-iii-pisa',
      imageUrl: null,
      commerceType: 'retail',
      watchCapability: 'refreshable_listing',
    },
    expected: {
      retailerKey: 'kickscrew',
      displayName: 'KicksCrew',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },
  {
    caseId: 'retail_nordstrom_store_field',
    description: 'Retail offer declared via `store`, resolving to a registry entry seen recurring in this repo\'s own test fixtures.',
    offer: {
      id: 'offer-5',
      title: 'Cashmere Crewneck',
      brand: 'Vince',
      store: 'Nordstrom',
      price: 168,
      currency: 'USD',
      productUrl: 'https://shop.nordstrom.com/s/vince-cashmere-crewneck/555',
      imageUrl: 'https://images.example.test/nordstrom/crewneck.jpg',
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'nordstrom',
      displayName: 'Nordstrom',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },

  // ---- Currency truth ---------------------------------------------------
  {
    caseId: 'unknown_currency_no_fabrication',
    description: 'Offer with a price but no ISO-4217 currency. Must never default to USD or "$".',
    offer: {
      id: 'offer-6',
      title: 'Silk Scarf',
      brand: 'Hermès',
      retailer: 'Farfetch',
      price: 310,
      currency: null,
      productUrl: 'https://www.farfetch.com/shopping/women/silk-scarf-item-2.aspx',
      imageUrl: 'https://images.example.test/farfetch/scarf.jpg',
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'farfetch',
      displayName: 'Farfetch',
      sourceAuthority: 'declared',
      commerceType: 'retail',
      priceLabel: '310.00',
    },
  },

  // ---- Unknown retailer (no fabrication) ---------------------------------
  {
    caseId: 'unknown_retailer_no_url',
    description: 'No seller-authoritative field and no purchase URL at all. Must resolve to fully unknown, never a guess.',
    offer: {
      id: 'offer-7',
      title: 'Canvas Tote',
      brand: 'Baggu',
      price: 42,
      currency: 'USD',
      productUrl: null,
      imageUrl: null,
      commerceType: null,
    },
    expected: {
      retailerKey: null,
      displayName: null,
      sourceAuthority: 'unknown',
      commerceType: null,
    },
  },
  {
    caseId: 'unknown_retailer_unmapped_domain',
    description: 'No declared field; purchase URL is a safe, real merchant destination, but its domain is not in the committed registry. Must stay unknown -- no arbitrary-hostname-as-retailer.',
    offer: {
      id: 'offer-8',
      title: 'Wide-Leg Trousers',
      brand: 'Frankie Shop',
      price: 220,
      currency: 'USD',
      productUrl: 'https://www.the-frankie-shop-example.test/product/wide-leg-trousers',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: null,
      displayName: null,
      sourceAuthority: 'unknown',
      // The offer itself declares retail/resale; that fact is independent of
      // whether the seller's NAME can be resolved (see resolveRetailerIdentity
      // header comment).
      commerceType: 'retail',
    },
  },

  // ---- Brand-as-retailer negative control (§77) --------------------------
  {
    caseId: 'brand_only_never_becomes_retailer',
    description: 'Only a `brand` field is present -- no retailer/source/merchant/store, no purchase URL. The resolver must NOT fall back to brand.',
    offer: {
      id: 'offer-9',
      title: 'Signature Tote',
      brand: 'Coach',
      price: 350,
      currency: 'USD',
      productUrl: null,
      imageUrl: null,
      commerceType: null,
    },
    expected: {
      retailerKey: null,
      displayName: null,
      sourceAuthority: 'unknown',
      commerceType: null,
    },
  },

  // ---- Missing image ------------------------------------------------------
  {
    caseId: 'missing_image',
    description: 'Registered retailer, valid everything else, but no image URL.',
    offer: {
      id: 'offer-10',
      title: 'Suede Loafers',
      brand: 'Gucci',
      retailer: 'Farfetch',
      price: 690,
      currency: 'USD',
      productUrl: 'https://www.farfetch.com/shopping/women/suede-loafers-item-3.aspx',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'farfetch',
      displayName: 'Farfetch',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },

  // ---- No purchase URL, still has a retailer field -----------------------
  {
    caseId: 'declared_retailer_no_purchase_url',
    description: 'Retailer declared, but no purchase URL -- Shop must be absent/disabled even though the retailer identity itself resolves.',
    offer: {
      id: 'offer-11',
      title: 'Merino Sweater',
      brand: 'Everlane',
      retailer: 'Nordstrom',
      price: 88,
      currency: 'USD',
      productUrl: null,
      imageUrl: 'https://images.example.test/nordstrom/sweater.jpg',
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'nordstrom',
      displayName: 'Nordstrom',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },

  // ---- Watch capability ---------------------------------------------------
  {
    caseId: 'watchable_offer',
    description: 'Retail offer with server-authored watchCapability=refreshable_listing.',
    offer: {
      id: 'offer-12',
      title: 'Chelsea Boots',
      brand: 'Dr. Martens',
      retailer: 'KicksCrew',
      price: 180,
      currency: 'USD',
      productUrl: 'https://www.kickscrew.com/products/chelsea-boots',
      imageUrl: 'https://images.example.test/kickscrew/chelsea.jpg',
      commerceType: 'retail',
      watchCapability: 'refreshable_listing',
      type: 'retail',
    },
    expected: {
      retailerKey: 'kickscrew',
      displayName: 'KicksCrew',
      sourceAuthority: 'declared',
      commerceType: 'retail',
      watchCapability: 'refreshable_listing',
    },
  },
  {
    caseId: 'non_watchable_offer',
    description: 'Retail-looking offer explicitly marked unsupported for Watch (e.g. a Serper/Brave search result with no refresh-by-identity path).',
    offer: {
      id: 'offer-13',
      title: 'Chelsea Boots (similar)',
      brand: 'Dr. Martens',
      source: 'Nordstrom',
      price: 175,
      currency: 'USD',
      productUrl: 'https://shop.nordstrom.com/s/chelsea-boots-similar/777',
      imageUrl: null,
      commerceType: 'retail',
      watchCapability: 'unsupported',
      type: 'retail',
    },
    expected: {
      retailerKey: 'nordstrom',
      displayName: 'Nordstrom',
      sourceAuthority: 'declared',
      commerceType: 'retail',
      watchCapability: 'unsupported',
    },
  },

  // ---- Same exact product, multiple offers (safe grouping candidate) -----
  {
    caseId: 'same_product_offer_farfetch',
    description: 'Same exact product (shared productId/GTIN) as same_product_offer_poshmark, offered at a different retailer.',
    offer: {
      id: 'offer-14a',
      productId: 'sku-shared-001',
      gtin: '00012345678905',
      title: 'Quilted Shoulder Bag',
      brand: 'Chanel-style (unbranded reproduction, TEST DATA)',
      retailer: 'Farfetch',
      price: 1200,
      currency: 'USD',
      productUrl: 'https://www.farfetch.com/shopping/women/quilted-bag-item-9.aspx',
      imageUrl: 'https://images.example.test/farfetch/bag.jpg',
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'farfetch',
      displayName: 'Farfetch',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },
  {
    caseId: 'same_product_offer_poshmark',
    description: 'Same exact product (shared productId/GTIN) as same_product_offer_farfetch, offered resale.',
    offer: {
      id: 'offer-14b',
      productId: 'sku-shared-001',
      gtin: '00012345678905',
      title: 'Quilted Shoulder Bag',
      brand: 'Chanel-style (unbranded reproduction, TEST DATA)',
      retailer: 'Poshmark',
      price: 950,
      currency: 'USD',
      productUrl: 'https://poshmark.com/listing/quilted-bag-xyz789',
      imageUrl: 'https://images.example.test/poshmark/bag.jpg',
      commerceType: 'resale',
    },
    expected: {
      retailerKey: 'poshmark',
      displayName: 'Poshmark',
      sourceAuthority: 'declared',
      commerceType: 'resale',
    },
  },

  // ---- Similar-but-not-identical (must NOT group) -------------------------
  {
    caseId: 'similar_not_identical_a',
    description: 'Same brand/category/close title as similar_not_identical_b, but a distinct product (no shared productId/GTIN) -- must stay separate under §51.',
    offer: {
      id: 'offer-15a',
      productId: 'sku-black-001',
      title: 'Wool Blazer, Black',
      brand: 'Theory',
      retailer: 'Nordstrom',
      price: 425,
      currency: 'USD',
      productUrl: 'https://shop.nordstrom.com/s/theory-wool-blazer-black/111',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'nordstrom',
      displayName: 'Nordstrom',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },
  {
    caseId: 'similar_not_identical_b',
    description: 'Same brand/category/close title as similar_not_identical_a, different color/SKU -- must stay separate under §51.',
    offer: {
      id: 'offer-15b',
      productId: 'sku-navy-002',
      title: 'Wool Blazer, Navy',
      brand: 'Theory',
      retailer: 'Nordstrom',
      price: 425,
      currency: 'USD',
      productUrl: 'https://shop.nordstrom.com/s/theory-wool-blazer-navy/112',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'nordstrom',
      displayName: 'Nordstrom',
      sourceAuthority: 'declared',
      commerceType: 'retail',
    },
  },

  // ---- Redirect/aggregator destination (domain fallback must refuse) ----
  {
    caseId: 'aggregator_destination_no_declared_field',
    description: 'No declared retailer field; the only URL is a Google Shopping aggregator/redirect page, matching the real measured pattern in commerceDestinationClaimTruth.test.js. Must resolve unknown, never "Google".',
    offer: {
      id: 'offer-16',
      title: 'Trench Coat',
      brand: 'Burberry',
      price: 1980,
      currency: 'GBP',
      productUrl: 'https://www.google.com/shopping/product/1234567890',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: null,
      displayName: null,
      sourceAuthority: 'unknown',
      commerceType: 'retail',
    },
  },

  // ---- Marketplace subdomain (domain fallback must generalize) ----------
  {
    caseId: 'marketplace_subdomain_domain_fallback',
    description: 'No declared retailer field; purchase URL is a subdomain of a registered domain. Domain fallback must resolve it via the apex domain.',
    offer: {
      id: 'offer-17',
      title: 'Pleated Midi Skirt',
      brand: 'Reformation',
      price: 148,
      currency: 'USD',
      productUrl: 'https://shop.nordstrom.com/s/reformation-pleated-midi-skirt/222',
      imageUrl: 'https://images.example.test/nordstrom/skirt.jpg',
      commerceType: 'retail',
    },
    expected: {
      retailerKey: 'nordstrom',
      displayName: 'Nordstrom',
      sourceAuthority: 'domain',
      commerceType: 'retail',
    },
  },

  // ---- Shared-host / unmapped domain edge case ---------------------------
  {
    caseId: 'shared_host_unmapped',
    description: 'No declared retailer field; purchase URL is on a generic multi-tenant storefront host not in the registry. Must stay unknown rather than treating the shared host itself as a retailer name.',
    offer: {
      id: 'offer-18',
      title: 'Ceramic Hoop Earrings',
      brand: 'Local Studio, TEST DATA',
      price: 58,
      currency: 'USD',
      productUrl: 'https://shops.example-storefront-platform.test/local-studio/ceramic-hoops',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: null,
      displayName: null,
      sourceAuthority: 'unknown',
      commerceType: 'retail',
    },
  },

  // ---- Unsafe destination (must never leak into a domain match) ---------
  {
    caseId: 'unsafe_destination_domain_fallback_refused',
    description: 'No declared retailer field; the only URL is unsafe (credentialed). Domain fallback must never even look at its host.',
    offer: {
      id: 'offer-19',
      title: 'Silk Blouse',
      brand: 'Equipment',
      price: 128,
      currency: 'USD',
      productUrl: 'https://user:pass@www.farfetch.com/shopping/women/silk-blouse-item-4.aspx',
      imageUrl: null,
      commerceType: 'retail',
    },
    expected: {
      retailerKey: null,
      displayName: null,
      sourceAuthority: 'unknown',
      commerceType: 'retail',
    },
  },

  // ---- Synthetic logo-present case (see note) ----------------------------
  {
    caseId: 'synthetic_approved_logo',
    description:
      'SYNTHETIC ONLY -- no real retailer in the committed registry has an approved logo today (Build 35 §19; zero logo files exist in assets/commerce/retailers/). This case exists only to exercise RetailerIdentity\'s logo-rendering branch and the "retailer A never renders logo B" negative control. Tests must use this fixture\'s own synthetic registry entry, never assert it against the real, shipped registry.',
    offer: {
      id: 'offer-20',
      title: 'Test Fixture Item',
      retailer: 'Synthetic Retailer',
      price: 100,
      currency: 'USD',
      productUrl: 'https://synthetic-retailer.example.test/item/1',
      imageUrl: null,
      commerceType: 'retail',
    },
    // A synthetic-only registry entry, deliberately NOT added to
    // services/commerce/retailerRegistry.ts. Tests construct their own
    // lookup table from this to prove the component's logo/monogram branch
    // logic without fabricating rights for a real retailer.
    syntheticRegistryEntry: {
      retailerKey: 'synthetic-retailer',
      displayName: 'Synthetic Retailer',
      domains: ['synthetic-retailer.example.test'],
      logoAsset: 'synthetic-retailer-logo',
      fallbackMonogram: 'S',
      commerceType: 'retail',
      logoRightsBasis: 'test-fixture-only, not a real rights grant',
    },
  },
];

/**
 * Per-garment multi-item fixture (Build 35 §57-§59). Mirrors the real shape
 * `services/multiItemCommerce.ts` produces: one independent card per
 * candidateId, each with its own bestMatch/alternatives.
 */
const MULTI_ITEM_FIXTURE = {
  candidates: [
    {
      candidateId: 'candidate-jacket',
      category: 'outerwear',
      bestMatch: RETAILER_OFFERS.find((o) => o.caseId === 'retail_farfetch_declared').offer,
      alternatives: [RETAILER_OFFERS.find((o) => o.caseId === 'missing_image').offer],
    },
    {
      candidateId: 'candidate-skirt',
      category: 'bottoms',
      bestMatch: RETAILER_OFFERS.find((o) => o.caseId === 'marketplace_subdomain_domain_fallback').offer,
      alternatives: [],
    },
    {
      candidateId: 'candidate-boots',
      category: 'footwear',
      bestMatch: RETAILER_OFFERS.find((o) => o.caseId === 'watchable_offer').offer,
      alternatives: [RETAILER_OFFERS.find((o) => o.caseId === 'non_watchable_offer').offer],
    },
  ],
};

function getOfferCase(caseId) {
  const entry = RETAILER_OFFERS.find((o) => o.caseId === caseId);
  if (!entry) throw new Error(`No commerce fixture case named "${caseId}"`);
  return entry;
}

module.exports = {
  RETAILER_OFFERS,
  MULTI_ITEM_FIXTURE,
  getOfferCase,
};
