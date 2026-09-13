#!/usr/bin/env node
/**
 * Commerce Activation — Phase 0 baselines (activation brief section 3).
 *
 * Captured BEFORE any product edit and re-run after, so "the cold path is
 * unchanged" is an equality assertion against recorded fixtures rather than a
 * claim. Deterministic and offline: the real production ranker, fixed
 * fixtures, no provider call.
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));

const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');
const { attachCommercialUsability, selectPrimaryTransactionalIndex } = edge('commerceContextualRanking.ts');
const { buildShoppingIntent, extractExplicitContribution } = edge('commerceShoppingIntent.ts');
const { contributionFromPackingGap } = edge('commercePackingBridge.ts');

const p = (id, title, price, o = {}) => ({
  id,
  title,
  price,
  currency: o.currency ?? 'USD',
  type: o.type ?? 'retail',
  source: o.source ?? 'Farfetch',
  imageUrl: `https://img.cdn.io/${id}.jpg`,
  productUrl: o.productUrl ?? `https://www.${(o.source ?? 'Farfetch').toLowerCase()}.com/shopping/${id}.aspx`,
  ...(o.availability ? { availability: o.availability } : {}),
});

/** Fixed zero-context fixtures. These are the BLOCKING equality comparison. */
const ZERO_CONTEXT_FIXTURES = [
  {
    id: 'ZC1_boots',
    garment: { item_type: 'footwear', subtype: 'boot', primary_color: 'black', material_estimate: 'leather' },
    route: 'footwear',
    products: [
      p('z1', 'Black Leather Chelsea Boot', '$300.00'),
      p('z2', 'Black Suede Ankle Boot', '$150.00', { source: 'Poshmark' }),
      p('z3', 'Brown Leather Boot', '$210.00', { source: 'KicksCrew' }),
      p('z4', 'Navy Wool Coat', '$400.00', { source: 'Serper' }),
    ],
  },
  {
    id: 'ZC2_jacket',
    garment: { item_type: 'outerwear', subtype: 'moto jacket', primary_color: 'black', material_estimate: 'leather' },
    route: 'outerwear',
    products: [
      p('y1', 'Black Leather Moto Jacket', '$1,290.00'),
      p('y2', 'Black Leather Biker Jacket', '$890.00', { source: 'Poshmark' }),
      p('y3', 'Lightweight Rain Shell', '', { type: 'similar', source: 'Brave' }),
    ],
  },
];

function rank(fixture, intent, actorId = null) {
  const started = process.hrtime.bigint();
  const res = filterAndDedupeProducts(fixture.products, fixture.garment, {
    enabled: true,
    categoryRoute: fixture.route,
    ...(intent ? { shoppingContext: intent, requestActorId: actorId } : {}),
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const annotated = attachCommercialUsability(res.products);
  return {
    order: res.products.map((x) => x.id),
    scores: res.stats.agreementScores ?? [],
    contextualApplied: res.stats.contextualApplied === true,
    transactionStates: annotated.map((x) => `${x.id}:${x.commercialUsability}`),
    primaryTransactionalIndex: selectPrimaryTransactionalIndex(annotated),
    rationale: res.stats.rationale ?? null,
    removed: res.stats.contextualRemovals ?? {},
    rankingMs: +ms.toFixed(3),
  };
}

/** A. Zero-context Commerce baseline. Commerce calls are local only: 1 rank pass. */
function zeroContextBaseline() {
  return ZERO_CONTEXT_FIXTURES.map((f) => ({
    fixture: f.id,
    candidateSet: f.products.map((x) => x.id),
    ...rank(f, null),
    commerceRankPasses: 1,
  }));
}

/**
 * B. Customer-quality baseline.
 *
 * Elise cannot activate Commerce yet, so these run DIRECTLY through the #409
 * path with the intent the activated journey would produce. That is the honest
 * BEFORE: it shows what the engine can already do, against which the wired
 * journey is compared.
 */
const QUALITY_NEEDS = [
  {
    id: 'Q1_outfit_shopping',
    request: 'I like this outfit, but show me different shoes under $120.',
    garment: { item_type: 'footwear', subtype: 'boot', primary_color: 'black', material_estimate: 'leather' },
    route: 'footwear',
    products: [
      p('q1', 'Black Leather Chelsea Boot', '$300.00'),
      p('q2', 'Black Suede Ankle Boot', '$110.00', { source: 'Poshmark' }),
      p('q3', 'Black Leather Derby Shoe', '$95.00', { source: 'KicksCrew' }),
    ],
    contributions: () => [extractExplicitContribution('different shoes under $120')],
  },
  {
    id: 'Q2_packing_gap',
    request: 'Packing: CONFIRMED gap — a light rain layer.',
    garment: { item_type: 'outerwear', subtype: 'jacket' },
    route: 'outerwear',
    products: [
      p('r1', 'Wool Overcoat', '$600.00'),
      p('r2', 'Packable Waterproof Rain Jacket', '$120.00', { source: 'Poshmark' }),
      p('r3', 'Denim Jacket', '$95.00', { source: 'Serper' }),
    ],
    contributions: () => [
      contributionFromPackingGap({
        code: 'missing_weather_layer',
        label: 'A light rain layer',
        certainty: 'confirmed',
        source: 'weather',
      }),
    ],
  },
  {
    id: 'Q3_closet_aware',
    request: 'Different shoes for this outfit (Closet already has black leather chelsea boots).',
    garment: { item_type: 'footwear', subtype: 'boot', primary_color: 'black', material_estimate: 'leather' },
    route: 'footwear',
    actorId: 'actor-1',
    products: [
      p('c1', 'Black Leather Chelsea Boot', '$300.00'),
      p('c2', 'Brown Suede Chelsea Boot', '$290.00', { source: 'Poshmark' }),
    ],
    contributions: () => [
      {
        provenance: 'CLOSET',
        actorId: 'actor-1',
        relevantOwned: [{ descriptor: 'black leather chelsea boot', category: 'boot', color: 'black', material: 'leather' }],
      },
    ],
  },
];

function qualityBaseline() {
  return QUALITY_NEEDS.map((n) => {
    const intent = buildShoppingIntent(n.contributions(), n.actorId ?? null);
    const result = rank(n, intent, n.actorId ?? null);
    return {
      need: n.id,
      request: n.request,
      context: {
        budgetCeiling: intent.budgetCeiling?.value ?? null,
        gap: intent.gapRelationship?.value ?? null,
        relevantOwned: intent.relevantOwned,
      },
      products: result.order,
      order: result.order,
      rationaleFacts: result.rationale?.map((r) => r.factCodes) ?? null,
      transactionState: result.transactionStates,
    };
  });
}

function run() {
  return {
    capturedAgainst: 'PR #409 merge 28e1203aebe4864e4bed689ccb14d16ec857aaf7',
    A_zeroContext: zeroContextBaseline(),
    B_customerQuality: qualityBaseline(),
    C_eliseTurnStructure: {
      ELISE_TURN_STRUCTURE: 'SINGLE_PASS',
      evidence: [
        'supabase/functions/stylechat-generate/index.ts:buildGeminiBody — no `tools`, `functionDeclarations` or `toolConfig` key exists in the request body',
        'index.ts:2790 one buildGeminiBody + callGemini per turn',
        'index.ts:2884 a second call occurs ONLY as a completeness/quality retry (buildRetryTurns), never as a tool continuation',
      ],
      MODEL_TURNS_PER_NORMAL_ELISE_TURN: '1 (2 only on an incomplete-response retry)',
      structuredOutputChannel: '<actions>[...]</actions> parsed out of the single response by actions.ts',
    },
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));

module.exports = { run, zeroContextBaseline, qualityBaseline, ZERO_CONTEXT_FIXTURES, QUALITY_NEEDS, rank };
