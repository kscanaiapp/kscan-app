#!/usr/bin/env node
/**
 * Contextual Commerce — engineering measurement harness.
 *
 * Measures the two costs section 21 asks for against a representative
 * 20-candidate local set, and the retailer distribution shift section 9 asks
 * for. Deterministic, offline, no provider call: it exercises the REAL
 * production ranking path (`filterAndDedupeProducts`) rather than a model of
 * it, so the numbers describe the code that ships.
 *
 * Internal engineering evidence only. Not a user-facing or marketing claim.
 */
'use strict';

// Edge-function modules are Deno TypeScript. Resolving them through a computed
// path keeps runtime behaviour identical while keeping the root `tsc` out of a
// tree its tsconfig deliberately excludes — a static specifier would drag the
// Deno globals into a typecheck that cannot satisfy them.
const path = require('node:path');
const EDGE = path.resolve(__dirname, '../../supabase/functions/scan-identify');
const edge = (name) => require(path.join(EDGE, name));

const {
  filterAndDedupeProducts,
} = edge('qualityTuneCommerce.ts');
const {
  buildShoppingIntent,
  extractExplicitContribution,
} = edge('commerceShoppingIntent.ts');
const {
  contributionFromPackingGap,
} = edge('commercePackingBridge.ts');

const RETAILERS = ['Farfetch', 'KicksCrew', 'Poshmark', 'Serper', 'Brave'];
const TITLES = [
  'Black Leather Moto Jacket', 'Red Leather Moto Jacket', 'Black Suede Biker Jacket',
  'Navy Wool Overcoat', 'Packable Waterproof Rain Jacket', 'Cropped Black Bomber',
  'Brown Leather Trucker Jacket', 'Black Denim Jacket', 'Quilted Black Puffer',
  'Green Cotton Field Jacket',
];

const GARMENT = {
  item_type: 'outerwear',
  subtype: 'moto jacket',
  primary_color: 'black',
  material_estimate: 'leather',
};

/** 20 realistic candidates spread across five retailers. */
function candidateSet(n = 20) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `p${i}`,
      title: TITLES[i % TITLES.length] + (i >= TITLES.length ? ' II' : ''),
      price: `$${(60 + i * 23) % 500 + 40}.00`,
      currency: 'USD',
      type: 'retail',
      source: RETAILERS[i % RETAILERS.length],
      imageUrl: `https://img.cdn.io/p${i}.jpg`,
      productUrl: `https://www.${RETAILERS[i % RETAILERS.length].toLowerCase()}.com/shopping/p${i}.aspx`,
    });
  }
  return out;
}

const CONTEXT_CONTRIBUTIONS = [
  {
    provenance: 'CLOSET',
    actorId: 'actor-1',
    relevantOwned: [
      { descriptor: 'black leather moto jacket', category: 'outerwear', color: 'black', material: 'leather' },
      { descriptor: 'navy wool overcoat', category: 'outerwear', color: 'navy', material: 'wool' },
    ],
  },
  { provenance: 'SIGNATURE_STYLE', actorId: 'actor-1', signatureStyleTokens: ['cropped', 'minimal'] },
  contributionFromPackingGap({
    code: 'missing_weather_layer', label: 'A light rain layer', certainty: 'confirmed', source: 'weather',
  }),
];

const USER_TEXT = 'something like this, under $400, not suede';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function timed(fn, iterations) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { median: median(samples), max: Math.max(...samples) };
}

function retailerDistribution(products) {
  const counts = {};
  for (const p of products) counts[p.source] = (counts[p.source] || 0) + 1;
  return counts;
}

function run() {
  const WARMUP = 200;
  const ITERATIONS = 500;
  const products = candidateSet(20);
  const baseOpts = { enabled: true, categoryRoute: 'outerwear' };

  // Warm up both paths so JIT state is not the thing being measured.
  for (let i = 0; i < WARMUP; i += 1) {
    filterAndDedupeProducts(products, GARMENT, baseOpts);
    const warm = buildShoppingIntent([...CONTEXT_CONTRIBUTIONS, extractExplicitContribution(USER_TEXT)], 'actor-1');
    filterAndDedupeProducts(products, GARMENT, { ...baseOpts, shoppingContext: warm, requestActorId: 'actor-1' });
  }

  const baseline = timed(() => filterAndDedupeProducts(products, GARMENT, baseOpts), ITERATIONS);

  // A: context assembly — parsing the user's words and folding the
  // contributions into one intent. This is the whole cost of "understanding
  // the need"; there is no retrieval and no model call in it.
  const assembly = timed(
    () => buildShoppingIntent([...CONTEXT_CONTRIBUTIONS, extractExplicitContribution(USER_TEXT)], 'actor-1'),
    ITERATIONS,
  );

  const intent = buildShoppingIntent([...CONTEXT_CONTRIBUTIONS, extractExplicitContribution(USER_TEXT)], 'actor-1');

  // B: local ranking with context — the full production filter/score/dedupe
  // path, contextual stages included.
  const contextual = timed(
    () => filterAndDedupeProducts(products, GARMENT, { ...baseOpts, shoppingContext: intent, requestActorId: 'actor-1' }),
    ITERATIONS,
  );

  // The cold path must not pay for a feature it does not use.
  const coldIntent = buildShoppingIntent([extractExplicitContribution('find this jacket')], null);
  const cold = timed(
    () => filterAndDedupeProducts(products, GARMENT, { ...baseOpts, shoppingContext: coldIntent, requestActorId: null }),
    ITERATIONS,
  );

  const before = filterAndDedupeProducts(products, GARMENT, baseOpts);
  const after = filterAndDedupeProducts(products, GARMENT, {
    ...baseOpts, shoppingContext: intent, requestActorId: 'actor-1',
  });

  const rankingOverhead = contextual.median - baseline.median;
  const total = assembly.median + rankingOverhead;

  return {
    candidates: products.length,
    iterations: ITERATIONS,
    performance: {
      BASELINE_MS: +baseline.median.toFixed(3),
      CONTEXT_ASSEMBLY_MS: +assembly.median.toFixed(3),
      NEW_RANKING_MS: +contextual.median.toFixed(3),
      RANKING_OVERHEAD_MS: +rankingOverhead.toFixed(3),
      TOTAL_INCREMENTAL_MS: +total.toFixed(3),
      ZERO_CONTEXT_MS: +cold.median.toFixed(3),
      ZERO_CONTEXT_OVERHEAD_MS: +(cold.median - baseline.median).toFixed(3),
      TARGET_MS: 50,
      WITHIN_TARGET: total <= 50,
    },
    retailerDistribution: {
      BEFORE_CONTEXTUAL_RANKING: retailerDistribution(before.products),
      AFTER_CONTEXTUAL_RANKING: retailerDistribution(after.products),
      BEFORE_RETAILER_COUNT: before.stats.retailerCount,
      AFTER_RETAILER_COUNT: after.stats.retailerCount,
      BEFORE_TOP5: before.products.slice(0, 5).map((p) => p.source),
      AFTER_TOP5: after.products.slice(0, 5).map((p) => p.source),
    },
    ordering: {
      BEFORE: before.products.map((p) => p.id),
      AFTER: after.products.map((p) => p.id),
      REMOVED_BY_CONTEXT: after.stats.contextualRemovals,
    },
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

if (require.main === module) {
  console.log(JSON.stringify(run(), null, 2));
}

module.exports = { run, candidateSet, CONTEXT_CONTRIBUTIONS, USER_TEXT, GARMENT };
