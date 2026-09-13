/**
 * Contextual Commerce — ranking objective, single authority, and the
 * before/after evidence for the Phase 0 failures this lane was built for.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Edge-function modules are Deno TypeScript. They run fine under `node --test`
 * (type stripping), but a STATIC `require('../../supabase/functions/...')`
 * makes the root `tsc` follow the specifier into a tree its tsconfig
 * deliberately excludes, and the Deno globals there then fail the root
 * typecheck. Resolving through a computed path keeps the runtime behaviour
 * identical and the static graph honest — the same approach
 * `__tests__/multiItemCommerceV127Rollback.test.js` and the Curiosity Gap
 * suite already use.
 */
const ROOT = path.resolve(__dirname, '../..');
const edge = (name) => require(path.join(ROOT, 'supabase/functions/scan-identify', name));
const client = (name) => require(path.join(ROOT, 'services/commerce', name));


const {
  filterAndDedupeProducts,
} = edge('qualityTuneCommerce.ts');
const {
  buildShoppingIntent,
  extractExplicitContribution,
  hasUsableContext,
} = edge('commerceShoppingIntent.ts');
const {
  contributionFromPackingGap,
} = edge('commercePackingBridge.ts');
const {
  scoreContextualFit,
  CTX_DELTA_MAX,
  CTX_DELTA_MIN,
  deriveRecommendationLabel,
} = edge('commerceContextualRanking.ts');

const JACKET = { item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black', material_estimate: 'leather' };
const BOOT = { item_type: 'footwear', subtype: 'boot', primary_color: 'black', material_estimate: 'leather' };

function product(id, title, price, overrides = {}) {
  return {
    id,
    title,
    price,
    currency: 'USD',
    type: 'retail',
    source: 'Farfetch',
    imageUrl: `https://img.cdn.io/${id}.jpg`,
    productUrl: `https://www.farfetch.com/shopping/${id}.aspx`,
    ...overrides,
  };
}

function rank(products, garment, intent, actorId = null) {
  return filterAndDedupeProducts(products, garment, {
    enabled: true,
    categoryRoute: garment === BOOT ? 'footwear' : 'outerwear',
    ...(intent ? { shoppingContext: intent, requestActorId: actorId } : {}),
  });
}

const ids = (r) => r.products.map((p) => p.id);

// ── Phase 0 failures, now fixed ─────────────────────────────────────────────

test('PHASE0-C01: an explicit budget ceiling is enforced as a hard constraint', () => {
  const candidates = [
    product('over', 'Black Leather Moto Jacket', '$420.00'),
    product('mid', 'Black Leather Biker Jacket', '$95.00'),
    product('low', 'Black Moto Jacket', '$88.00'),
  ];
  const before = rank(candidates, JACKET, null);
  assert.deepEqual(ids(before), ['over', 'mid', 'low'], 'BEFORE: $420 leads a $100 request');

  const after = rank(candidates, JACKET, buildShoppingIntent([extractExplicitContribution('under $100')]));
  assert.deepEqual(ids(after), ['mid', 'low'], 'AFTER: the over-budget candidate cannot answer this question');
});

test('PHASE0-C03: the latest explicit instruction outranks the scanned garment', () => {
  const candidates = [
    product('black', 'Black Leather Moto Jacket', '$420.00'),
    product('red', 'Red Leather Moto Jacket', '$400.00'),
  ];
  const before = rank(candidates, JACKET, null);
  assert.deepEqual(ids(before), ['black', 'red'], 'BEFORE: the photograph wins');

  const after = rank(candidates, JACKET, buildShoppingIntent([extractExplicitContribution('find something in red instead')]));
  assert.deepEqual(ids(after), ['red', 'black'], 'AFTER: the user wins');
});

test('PHASE0-C04: a confirmed Packing gap reaches ranking', () => {
  const garment = { item_type: 'outerwear', subtype: 'jacket' };
  const candidates = [
    product('wool', 'Wool Overcoat', '$600.00'),
    product('rain', 'Packable Waterproof Rain Jacket', '$120.00'),
  ];
  const before = rank(candidates, garment, null);
  assert.deepEqual(ids(before), ['wool', 'rain'], 'BEFORE: the rain layer is invisible to ranking');

  const intent = buildShoppingIntent([
    contributionFromPackingGap({ code: 'missing_weather_layer', label: 'A light rain layer', certainty: 'confirmed', source: 'weather' }),
  ]);
  const after = rank(candidates, garment, intent);
  assert.deepEqual(ids(after), ['rain', 'wool'], 'AFTER: the piece that answers the trip leads');
  assert.equal(after.stats.rationale[0].gap.certainty, 'confirmed');
});

test('PHASE0-C05: duplication risk is represented without hiding the listing', () => {
  const candidates = [
    product('dupe', 'Black Leather Chelsea Boot', '$300.00'),
    product('other', 'Brown Suede Chelsea Boot', '$290.00'),
  ];
  const intent = buildShoppingIntent(
    [{
      provenance: 'CLOSET',
      actorId: 'actor-1',
      relevantOwned: [{ descriptor: 'black leather chelsea boot', category: 'boot', color: 'black', material: 'leather' }],
    }],
    'actor-1',
  );
  const before = rank(candidates, BOOT, null);
  const after = rank(candidates, BOOT, intent, 'actor-1');

  assert.equal(after.stats.agreementScores[0] < before.stats.agreementScores[0], true, 'the near-duplicate is penalised');
  assert.ok(after.stats.rationale[0].factCodes.includes('duplicate_of_owned'));
  // Suppressing it would be the opposite error (§13): someone replacing a worn
  // pair still needs to see it.
  assert.equal(after.products.length, 2, 'a duplicate is ranked down, never hidden');
});

// ── Zero-context fast path ─────────────────────────────────────────────────

test('zero context produces byte-identical ranking to the pre-existing path', () => {
  const candidates = [
    product('a', 'Black Leather Moto Jacket', '$420.00'),
    product('b', 'Navy Wool Coat', '$300.00'),
    product('c', 'Black Moto Jacket', '$250.00'),
  ];
  const existing = rank(candidates, JACKET, null);

  for (const emptyish of [
    undefined,
    buildShoppingIntent([]),
    buildShoppingIntent([extractExplicitContribution('find this jacket')]),
    buildShoppingIntent([{ provenance: 'SCANNER', color: 'black', material: 'leather' }]),
  ]) {
    const out = rank(candidates, JACKET, emptyish);
    assert.deepEqual(ids(out), ids(existing));
    assert.deepEqual(out.stats.agreementScores, existing.stats.agreementScores);
    assert.notEqual(out.stats.contextualApplied, true, 'no contextual work may run');
  }
});

test('scanner-derived attributes alone are not "context"', () => {
  // The existing scorer already reads these off the identification. Counting
  // them as context would make every request a contextual request and cost
  // every cold scan the assembly it cannot benefit from.
  const scannerOnly = buildShoppingIntent([{ provenance: 'SCANNER', color: 'black', subtype: 'moto jacket' }]);
  assert.equal(hasUsableContext(scannerOnly), false);

  const explicit = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', color: 'red' }]);
  assert.equal(hasUsableContext(explicit), true);
});

// ── Single ranking authority ───────────────────────────────────────────────

test('there is exactly one production ranking authority, and context feeds it', () => {
  const root = path.join(__dirname, '../../supabase/functions/scan-identify');
  const ctx = fs.readFileSync(path.join(root, 'commerceContextualRanking.ts'), 'utf8');

  // The contextual module must not sort, order, or slice a candidate set: if
  // it did, it would BE a second ranker rather than an input to the one.
  assert.equal(/\.sort\(/.test(ctx), false, 'the contextual module must never sort candidates');

  // And its delta must be folded into the single agreement score.
  const quality = fs.readFileSync(path.join(root, 'qualityTuneCommerce.ts'), 'utf8');
  assert.ok(
    /agreementScore: score/.test(quality),
    'the one score that decides order must be the one context contributed to',
  );
});

test('the contextual delta is bounded, so context can never swamp fashion fit', () => {
  const everything = buildShoppingIntent([
    { provenance: 'USER_EXPLICIT', color: 'red', material: 'suede', silhouette: 'cropped', occasion: 'evening', formality: 'formal', functionalRequirements: ['waterproof', 'packable', 'warm', 'breathable'] },
    { provenance: 'SIGNATURE_STYLE', signatureStyleTokens: ['minimal'] },
  ]);
  const maximal = product('max', 'Red Suede Cropped Waterproof Packable Warm Breathable Minimal Evening Formal Jacket', '$10.00');
  const result = scoreContextualFit(maximal, everything);
  assert.ok(result.delta <= CTX_DELTA_MAX, `delta ${result.delta} must be bounded by ${CTX_DELTA_MAX}`);
  assert.ok(result.delta >= CTX_DELTA_MIN);
});

// ── Retailer neutrality ────────────────────────────────────────────────────

test('retailer identity has no effect on the contextual score', () => {
  const intent = buildShoppingIntent([extractExplicitContribution('in red instead')]);
  const base = product('x', 'Red Leather Moto Jacket', '$400.00');
  const scores = ['Farfetch', 'KicksCrew', 'Poshmark', 'Serper', 'Brave', 'SomeUnknownShop'].map(
    (source) => scoreContextualFit({ ...base, source }, intent).delta,
  );
  assert.equal(new Set(scores).size, 1, 'every retailer must score identically');
});

test('the contextual module never reads a retailer, source, or affiliate field', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../supabase/functions/scan-identify/commerceContextualRanking.ts'),
    'utf8',
  );
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['.source', '.retailer', '.merchant', '.store', 'affiliate', 'commission']) {
    assert.equal(body.includes(forbidden), false, `ranking must not read ${forbidden}`);
  }
});

test('metadata completeness alone earns no ranking points', () => {
  const intent = buildShoppingIntent([extractExplicitContribution('in red instead')]);
  const sparse = { id: 's', title: 'Red Leather Moto Jacket', type: 'retail', productUrl: 'https://a.com/s' };
  const rich = {
    ...sparse,
    id: 'r',
    price: '$400.00',
    currency: 'USD',
    brand: 'Acme',
    sku: 'X1',
    commerceType: 'retail',
    imageUrl: 'https://a.com/r.jpg',
    availability: 'in_stock',
  };
  assert.equal(
    scoreContextualFit(sparse, intent).delta,
    scoreContextualFit(rich, intent).delta,
    'a fuller feed is not a better answer',
  );
});

test('retailer distribution is reported before and after contextual ranking', () => {
  const candidates = [
    product('f1', 'Red Leather Moto Jacket', '$400.00', { source: 'Farfetch' }),
    product('k1', 'Red Leather Biker Jacket', '$380.00', { source: 'KicksCrew' }),
    product('p1', 'Red Moto Jacket', '$360.00', { source: 'Poshmark' }),
  ];
  const before = rank(candidates, JACKET, null);
  const after = rank(candidates, JACKET, buildShoppingIntent([extractExplicitContribution('in red instead')]));
  assert.equal(before.stats.retailerCount, 3);
  assert.equal(after.stats.retailerCount, 3, 'contextual ranking must not concentrate retailers');
});

// ── Labels ─────────────────────────────────────────────────────────────────

test('BEST VALUE requires a real same-currency comparison', () => {
  const facts = {
    matchedAttributes: [], factCodes: [], budgetFit: 'unknown',
    usability: 'TRANSACTION_READY', gap: null, relationship: 'external', priceComparable: false,
  };
  assert.equal(deriveRecommendationLabel({ rankIndex: 1, facts, isCheapestComparable: true }), null);
  assert.equal(
    deriveRecommendationLabel({ rankIndex: 1, facts: { ...facts, priceComparable: true }, isCheapestComparable: true }),
    'BEST VALUE',
  );
});

test('a set with nothing distinctive to say gets no label rather than a filler role', () => {
  const facts = {
    matchedAttributes: [], factCodes: [], budgetFit: 'unknown',
    usability: 'BROWSE_ONLY', gap: null, relationship: 'external', priceComparable: false,
  };
  assert.equal(deriveRecommendationLabel({ rankIndex: 1, facts, isCheapestComparable: false }), null);
});

test('BEST MATCH is withheld from a listing that cannot carry a transaction', () => {
  const facts = {
    matchedAttributes: [], factCodes: [], budgetFit: 'unknown',
    usability: 'BROWSE_ONLY', gap: null, relationship: 'external', priceComparable: false,
  };
  assert.equal(deriveRecommendationLabel({ rankIndex: 0, facts, isCheapestComparable: false }), null);
});
