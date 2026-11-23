// B42-SCAN-02 Scanner identity-aware ranking v1. Deterministic: no network,
// no model, no provider. Every case runs the real v122 relevance path
// (`filterAndDedupeProducts`) with the flag OFF and ON.
import assert from 'node:assert/strict';
import { filterAndDedupeProducts } from './qualityTuneCommerce.ts';
import {
  BRAND_CONTRADICTION_PENALTY,
  decideIdentityTier,
  orderByIdentityTier,
  rescoreForIdentityRanking,
} from './identityRanking.ts';
import { IDENTITY_RANKING_DEFAULT_ENABLED, isIdentityRankingEnabled } from './identityRankingConfig.ts';
import { brandsAgree, listingBrandVerdict } from './listingBrandIdentity.ts';
import { annotateMatchConfidence, collectOfferEvidence, classifyMatchConfidence } from './matchConfidence.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';
import { scoreProductAgreement } from './commerceRelevanceAgreement.ts';

const FLAG = 'SCANNER_IDENTITY_RANKING_V1_ENABLED';

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prior = Deno.env.get(FLAG);
  if (value === undefined) Deno.env.delete(FLAG); else Deno.env.set(FLAG, value);
  try {
    return fn();
  } finally {
    if (prior === undefined) Deno.env.delete(FLAG); else Deno.env.set(FLAG, prior);
  }
}

const STAN_SMITH_SCAN = {
  item_type: 'footwear',
  subtype: 'sneakers',
  primary_color: 'white',
  material_estimate: 'leather',
  silhouette: 'low-top',
  pattern: 'solid',
  visible_brand_text: 'adidas',
  exact_item_hypothesis: 'Stan Smith',
  exact_match_confidence: 'medium',
};
const HANDOFF = (n: number) => `https://www.google.com/search?ibp=oshop&q=item&prds=pid:${n}`;
let seq = 0;
const offer = (title: string, extra: Record<string, unknown> = {}): RecommendedProduct => {
  seq += 1;
  return {
    id: `o-${seq}`,
    title,
    productUrl: HANDOFF(seq),
    imageUrl: `https://img.example-cdn.net/${seq}.jpg`,
    price: '$90',
    source: `Retailer ${seq % 3}`,
    ...extra,
  } as unknown as RecommendedProduct;
};

// The historical B42-SCAN-02 probe, in provider order.
const PROBE = () => [
  offer('White Leather Low-Top Sneakers'),
  offer('Nike Court Legacy White Leather Sneakers'),
  offer('adidas Originals Stan Smith Shoes'),
  offer('adidas Stan Smith'),
];
const rank = (products: RecommendedProduct[], garment: Record<string, unknown> = STAN_SMITH_SCAN) =>
  filterAndDedupeProducts(products, garment, { enabled: true, categoryRoute: 'footwear' }).products.map((p) => p.title);

Deno.test('identity ranking: flag defaults OFF and parses the documented values', () => {
  assert.equal(IDENTITY_RANKING_DEFAULT_ENABLED, false);
  assert.equal(isIdentityRankingEnabled(() => undefined), false);
  for (const on of ['true', 'TRUE', '1', 'on', 'yes', ' true ']) assert.equal(isIdentityRankingEnabled(() => on), true);
  for (const off of ['false', '0', 'off', 'no', 'garbage', '']) assert.equal(isIdentityRankingEnabled(() => off), false);
});

Deno.test('identity ranking: B42-SCAN-02 probe — genuine listings rank first only when ON', () => {
  const off = withFlag(undefined, () => rank(PROBE()));
  assert.deepEqual(off.slice(0, 2), ['White Leather Low-Top Sneakers', 'Nike Court Legacy White Leather Sneakers']);
  const on = withFlag('true', () => rank(PROBE()));
  assert.deepEqual(on, [
    'adidas Originals Stan Smith Shoes',
    'adidas Stan Smith',
    'White Leather Low-Top Sneakers',
    'Nike Court Legacy White Leather Sneakers',
  ]);
});

Deno.test('identity ranking: flag OFF, unset and invalid values are byte-identical to the v122 path', () => {
  const pools = [PROBE(), [offer('adidas Stan Smith Replacement Laces'), offer('Stan Smith Inspired Sneakers'), offer('Black Boots')]];
  for (const pool of pools) {
    const reference = withFlag(undefined, () => filterAndDedupeProducts(pool, STAN_SMITH_SCAN, { enabled: true, categoryRoute: 'footwear' }));
    for (const value of ['false', '0', 'off', 'garbage']) {
      const got = withFlag(value, () => filterAndDedupeProducts(pool, STAN_SMITH_SCAN, { enabled: true, categoryRoute: 'footwear' }));
      assert.deepEqual({ ...got, stats: { ...got.stats, latencyRelevanceMs: 0 } }, { ...reference, stats: { ...reference.stats, latencyRelevanceMs: 0 } });
    }
  }
  // Disabled hooks return the very same array object.
  const scored = [{ product: PROBE()[0], agreementScore: 80, agreementBand: 'strong' as const, clearCategoryConflict: false, originalIndex: 0 }];
  assert.equal(rescoreForIdentityRanking(scored, STAN_SMITH_SCAN, null, undefined, false), scored);
  const products = PROBE();
  assert.equal(orderByIdentityTier(products, STAN_SMITH_SCAN, null, false), products);
});

Deno.test('identity ranking: identity tier needs the model; no hypothesis → same-brand tier, still above look-alikes', () => {
  const noHypothesis = { ...STAN_SMITH_SCAN, exact_item_hypothesis: undefined, exact_match_confidence: undefined };
  const on = withFlag('true', () => rank(PROBE(), noHypothesis));
  // Category stated → brand tier; "adidas Stan Smith" states no category and no model can be
  // corroborated, so it is unsupported and not used to pad the shelf.
  assert.deepEqual(on, [
    'adidas Originals Stan Smith Shoes',
    'White Leather Low-Top Sneakers',
    'Nike Court Legacy White Leather Sneakers',
  ]);
});

Deno.test('identity ranking: a low-confidence model hypothesis is ignored', () => {
  const low = { ...STAN_SMITH_SCAN, exact_match_confidence: 'low' };
  const d = decideIdentityTier(offer('adidas Stan Smith') as unknown as Record<string, unknown>, low, null, 0);
  assert.equal(d.tier, 'unsupported');
});

Deno.test('identity ranking: different model variant of the same brand is brand tier, not identity', () => {
  const jordan = { item_type: 'footwear', subtype: 'sneakers', primary_color: 'red', visible_brand_text: 'Nike', exact_item_hypothesis: 'Air Jordan 1 High', exact_match_confidence: 'high' };
  const tier = (title: string) => decideIdentityTier(offer(title) as unknown as Record<string, unknown>, jordan, null, 30).tier;
  assert.equal(tier('Nike Air Jordan 1 High OG Sneakers'), 'identity');
  assert.equal(tier('Nike Air Jordan 1 Low Sneakers'), 'brand');
  assert.equal(tier('Air Jordan 4 Retro Shoes'), 'brand'); // "Air Jordan" is the Nike family
});

Deno.test('identity ranking: cross-brand titles are contradictions even without a provider brand field', () => {
  assert.equal(listingBrandVerdict({ title: 'Nike Court Legacy White Leather Sneakers' }, 'adidas'), 'contradicts');
  assert.equal(listingBrandVerdict({ title: 'New Balance 574 Sneakers' }, 'adidas'), 'contradicts');
  assert.equal(listingBrandVerdict({ title: 'adidas Originals Stan Smith' }, 'adidas'), 'agrees');
  assert.equal(listingBrandVerdict({ title: 'Stan Smith', brand: 'adidas Originals' }, 'adidas'), 'agrees');
  assert.equal(listingBrandVerdict({ title: 'adidas Stan Smith', brand: 'Nike' }, 'adidas'), 'contradicts');
  assert.equal(listingBrandVerdict({ title: 'Nike vs adidas sneaker bundle' }, 'adidas'), 'unknown');
  assert.equal(listingBrandVerdict({ title: 'YSL Le Loafer' }, 'Saint Laurent'), 'agrees');
  assert.ok(brandsAgree('Air Jordan', 'Nike'));
  assert.ok(!brandsAgree('Converse', 'Nike'));
});

Deno.test('identity ranking: ambiguous brand words never assert a title contradiction', () => {
  for (const title of ['Coach Jacket in Navy', 'Classic Polo Shirt', 'Hunter Green Rain Boots', 'Gap Year Travel Backpack', 'Guess Who Graphic Tee', 'Jordan Leather Sneakers']) {
    assert.equal(listingBrandVerdict({ title }, 'adidas'), 'unknown', title);
  }
});

Deno.test('identity ranking: retailer identity never decides the brand', () => {
  const garment = STAN_SMITH_SCAN;
  const a = decideIdentityTier({ ...offer('White Leather Low-Top Sneakers'), source: 'Nike' } as unknown as Record<string, unknown>, garment, null, 80);
  const b = decideIdentityTier({ ...offer('White Leather Low-Top Sneakers'), source: 'adidas' } as unknown as Record<string, unknown>, garment, null, 80);
  assert.deepEqual(a, b);
  assert.equal(a.tier, 'alternative');
});

Deno.test('identity ranking: contradicted look-alikes rank after brand-neutral alternatives and pay the penalty', () => {
  const nike = offer('Nike Court Legacy White Leather Sneakers');
  const base = scoreProductAgreement(nike, STAN_SMITH_SCAN).score;
  const d = decideIdentityTier(nike as unknown as Record<string, unknown>, STAN_SMITH_SCAN, null, base);
  assert.equal(d.tier, 'contradicted');
  assert.equal(d.score, base - BRAND_CONTRADICTION_PENALTY);
  // A contradicted offer that falls below usable after the penalty is unsupported.
  assert.equal(decideIdentityTier(nike as unknown as Record<string, unknown>, STAN_SMITH_SCAN, null, 55).tier, 'unsupported');
});

Deno.test('identity ranking: replicas, parts and accessories never rank as the product', () => {
  const pool = [
    offer('adidas Stan Smith Replacement Laces'),
    offer('Stan Smith Inspired White Sneakers'),
    offer('adidas Stan Smith Replica Sneakers'),
    offer('Compatible with adidas Stan Smith Shoe Cleaner'),
    offer('adidas Stan Smith Insoles'),
    offer('adidas Stan Smith Sneakers'),
  ];
  const on = withFlag('true', () => rank(pool));
  assert.deepEqual(on, ['adidas Stan Smith Sneakers']);
});

Deno.test('identity ranking: an included extra ("with box") does not make a genuine listing an accessory', () => {
  const watch = { item_type: 'accessory', subtype: 'watch', primary_color: 'silver', visible_brand_text: 'Rolex', exact_item_hypothesis: 'Submariner', exact_match_confidence: 'high' };
  const tier = (title: string) => decideIdentityTier(offer(title) as unknown as Record<string, unknown>, watch, null, 40).tier;
  assert.equal(tier('Rolex Submariner Date Watch with Box and Papers'), 'identity');
  assert.equal(tier('Rolex Submariner Replacement Band'), 'unsupported');
  assert.equal(tier('Rolex Submariner Watch Case'), 'unsupported');
});

Deno.test('identity ranking: category conflicts stay unsupported even with full brand+model agreement', () => {
  const on = withFlag('true', () => rank([offer('adidas Stan Smith Graphic T-Shirt'), offer('adidas Stan Smith Sneakers')]));
  assert.deepEqual(on, ['adidas Stan Smith Sneakers']);
});

Deno.test('identity ranking: unverified brand evidence earns nothing and asserts nothing', () => {
  const guessOnly = { ...STAN_SMITH_SCAN, visible_brand_text: undefined, brand_guess: 'adidas' };
  const mediumLogo = { ...STAN_SMITH_SCAN, visible_brand_text: undefined, logo_detected: true, logo_brand: 'adidas', logo_confidence: 'medium' };
  for (const garment of [guessOnly, mediumLogo]) {
    const t = (title: string, score: number) => decideIdentityTier(offer(title) as unknown as Record<string, unknown>, garment, null, score).tier;
    assert.equal(t('adidas Stan Smith', 0), 'unsupported');
    assert.equal(t('Nike Court Legacy White Leather Sneakers', 70), 'alternative');
    const on = withFlag('true', () => rank(PROBE(), garment));
    assert.deepEqual(on, ['White Leather Low-Top Sneakers', 'Nike Court Legacy White Leather Sneakers']);
  }
});

Deno.test('identity ranking: a wrong image-derived brand cannot create a verified claim', () => {
  // The vision model misreads the wordmark as "Nike": the Nike look-alike now
  // agrees on brand, but without the hypothesised model it is only brand tier,
  // and match confidence never emits verified_exact.
  const wrong = { ...STAN_SMITH_SCAN, visible_brand_text: 'Nike' };
  const on = withFlag('true', () => filterAndDedupeProducts(PROBE(), wrong, { enabled: true, categoryRoute: 'footwear' }).products);
  const annotated = annotateMatchConfidence(on, { identification: wrong, identityRanking: true }) as unknown as Array<{ matchConfidence: { class: string } }>;
  assert.ok(annotated.every((o) => o.matchConfidence.class !== 'verified_exact'));
  assert.ok(annotated.every((o) => o.matchConfidence.class !== 'probable'));
});

Deno.test('identity ranking: non-fashion and unrecognised scanned categories keep the v122 order', () => {
  for (const garment of [{ item_type: 'NON_FASHION' }, { item_type: 'kitchen appliance', visible_brand_text: 'adidas' }]) {
    const pool = PROBE();
    const off = withFlag(undefined, () => filterAndDedupeProducts(pool, garment, { enabled: true, categoryRoute: 'general' }).products);
    const on = withFlag('true', () => filterAndDedupeProducts(pool, garment, { enabled: true, categoryRoute: 'general' }).products);
    assert.deepEqual(on, off);
  }
});

Deno.test('identity ranking: multi-item scene — listings for the other garment do not ride the brand', () => {
  // Selected item: adidas sneakers. The provider also returned the jacket worn in the photo.
  const on = withFlag('true', () => rank([offer('adidas Originals Track Jacket'), offer('adidas Stan Smith Sneakers'), offer('White Leather Low-Top Sneakers')]));
  assert.deepEqual(on, ['adidas Stan Smith Sneakers', 'White Leather Low-Top Sneakers']);
});

Deno.test('identity ranking: no padding — an all-unsupported pool yields an empty shelf, not three fills', () => {
  const pool = [offer('Fashion Shoes'), offer('Black Ankle Boots'), offer('Canvas Slip On')];
  const off = withFlag(undefined, () => rank(pool));
  const on = withFlag('true', () => rank(pool));
  assert.ok(off.length > 0);
  assert.deepEqual(on, []);
  const stats = withFlag('true', () => filterAndDedupeProducts(pool, STAN_SMITH_SCAN, { enabled: true, categoryRoute: 'footwear' }).stats);
  assert.equal(stats.removedReasons.identity_ranking_unsupported, 3);
});

Deno.test('match confidence: title-only cross-brand contradiction is reported only with identity ranking', () => {
  const nike = offer('Nike Court Legacy White Leather Sneakers') as unknown as Record<string, unknown>;
  assert.equal(collectOfferEvidence(nike, { identification: STAN_SMITH_SCAN }).brand, 'unknown');
  assert.equal(collectOfferEvidence(nike, { identification: STAN_SMITH_SCAN, identityRanking: true }).brand, 'contradicts');
  const c = classifyMatchConfidence(collectOfferEvidence(nike, { identification: STAN_SMITH_SCAN, identityRanking: true }));
  assert.ok(c.reasons.includes('listing_brand_contradicts'));
  assert.notEqual(c.class, 'probable');
  // annotateMatchConfidence reads the flag when the caller does not pass it.
  const off = withFlag(undefined, () => annotateMatchConfidence([nike], { identification: STAN_SMITH_SCAN }));
  const on = withFlag('true', () => annotateMatchConfidence([nike], { identification: STAN_SMITH_SCAN }));
  assert.ok(!(off[0] as { matchConfidence: { reasons: string[] } }).matchConfidence.reasons.includes('listing_brand_contradicts'));
  assert.ok((on[0] as { matchConfidence: { reasons: string[] } }).matchConfidence.reasons.includes('listing_brand_contradicts'));
});

Deno.test('identity ranking: vocabulary gap — "Black Clogs" is a supported alternative, not a coverage fill', () => {
  const clogScan = { item_type: 'footwear', subtype: 'clogs', primary_color: 'black', pattern: 'solid' };
  const route = { enabled: true as const, categoryRoute: 'footwear' as const };
  const pool = () => [offer('Black Clogs'), offer('Black Ankle Boots'), offer('Clog Shoe Charms Set')];
  const on = withFlag('true', () => filterAndDedupeProducts(pool(), clogScan, route).products.map((p) => p.title));
  // "Black Ankle Boots" is v122-usable on its own (footwear + compatible subtype + colour).
  assert.ok(on.includes('Black Clogs'));
  assert.ok(!on.includes('Clog Shoe Charms Set'));
  const off = withFlag(undefined, () => filterAndDedupeProducts(pool(), clogScan, route).products.map((p) => p.title));
  assert.ok(off.includes('Clog Shoe Charms Set'), 'OFF keeps the accessory as a coverage fill');
  // Match confidence agrees with ranking only when identity ranking is on.
  const clog = offer('Black Clogs') as unknown as Record<string, unknown>;
  assert.equal(classifyMatchConfidence(collectOfferEvidence(clog, { identification: clogScan })).class, 'unsupported');
  assert.equal('attributeSupported' in collectOfferEvidence(clog, { identification: clogScan }), false);
  assert.equal(classifyMatchConfidence(collectOfferEvidence(clog, { identification: clogScan, identityRanking: true })).class, 'similar');
});

Deno.test('identity ranking: brand tier uses the supplemental noun table ("Crocs Pink Clogs")', () => {
  const crocs = { item_type: 'footwear', subtype: 'clogs', primary_color: 'pink', visible_brand_text: 'Crocs' };
  const d = decideIdentityTier(offer('Crocs Pink Clogs') as unknown as Record<string, unknown>, crocs, null, 45);
  assert.equal(d.tier, 'brand');
  assert.ok(d.score >= 50);
});

Deno.test('identity ranking: no customer-visible field is added or renamed', () => {
  const on = withFlag('true', () => filterAndDedupeProducts(PROBE(), STAN_SMITH_SCAN, { enabled: true, categoryRoute: 'footwear' }).products);
  const off = withFlag(undefined, () => filterAndDedupeProducts(PROBE(), STAN_SMITH_SCAN, { enabled: true, categoryRoute: 'footwear' }).products);
  const keys = (list: RecommendedProduct[]) => new Set(list.flatMap((p) => Object.keys(p)));
  assert.deepEqual([...keys(on)].sort(), [...keys(off)].sort());
});
