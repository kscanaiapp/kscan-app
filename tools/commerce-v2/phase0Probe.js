#!/usr/bin/env node
/**
 * Commerce V2 Phase 0 — contract probes and failure baseline (brief §6, §7, §11).
 *
 * Executable evidence, not inspection. Every axis claim below is produced by
 * running the REAL production modules: a claim that an axis "exists" because a
 * field is declared is not accepted here — the probe changes one axis and
 * reports whether a real score or order moved.
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const harness = require(path.join(ROOT, 'tools/activation/journeyHarness.js'));

const { scoreContextualFit } = edge('commerceContextualRanking.ts');
const { buildShoppingIntent, shoppingIntentFingerprint } = edge('commerceShoppingIntent.ts');
const { buildCommerceCacheKey, fingerprintQuery } = edge('commerceResultCache.ts');
const { filterAndDedupeProducts, canonicalizeUrlForIdentity } = edge('qualityTuneCommerce.ts');
const { runTurn, makeFixtureProvider, product } = harness;

const out = (k, v) => console.log(`${k}=${v}`);

// ── §6 / §32 axis probes ───────────────────────────────────────────────────
//
// One candidate, two intents differing in exactly one axis. A real axis moves
// the delta; a declared-but-unconsumed field does not.
function probeAxis(axis, token, text) {
  const candidate = { title: text, productUrl: 'https://r.example.com/a', type: 'retail', price: '$100', currency: 'USD' };
  const base = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', category: 'footwear' }]);
  const withAxis = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', category: 'footwear', [axis]: token }]);
  const a = scoreContextualFit(candidate, base).delta;
  const b = scoreContextualFit(candidate, withAxis).delta;
  return { consumed: a !== b, before: a, after: b };
}

console.log('## RANKING AXES (executed, not inferred)');
for (const [axis, token, text] of [
  ['color', 'black', 'Black Leather Loafer'],
  ['material', 'suede', 'Brown Suede Loafer'],
  ['silhouette', 'chelsea', 'Black Chelsea Boot'],
  ['pattern', 'striped', 'Striped Cotton Shirt'],
  ['formality', 'casual', 'Casual Canvas Sneaker'],
]) {
  const r = probeAxis(axis, token, text);
  out(`${axis.toUpperCase()}_AXIS_PRESENT`, `${r.consumed ? 'YES' : 'NO'} (delta ${r.before} -> ${r.after})`);
}
{
  const candidate = { title: 'Waterproof Rain Shell', productUrl: 'https://r.example.com/b', type: 'retail', price: '$100', currency: 'USD' };
  const base = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', category: 'outerwear' }]);
  const fn = buildShoppingIntent([{ provenance: 'USER_EXPLICIT', category: 'outerwear', functionalRequirements: ['waterproof'] }]);
  const a = scoreContextualFit(candidate, base).delta;
  const b = scoreContextualFit(candidate, fn).delta;
  out('FUNCTIONAL_AXIS_PRESENT', `${a !== b ? 'YES' : 'NO'} (delta ${a} -> ${b})`);
}

// ── §7 identity probe ──────────────────────────────────────────────────────
console.log('\n## PRODUCT IDENTITY');
const sameOfferTwoWays = [
  'https://www.farfetch.com/shopping/s_loafer.aspx?utm_source=x&ref=y',
  'https://www.farfetch.com/shopping/s_loafer.aspx/',
];
out('DEDUP_IDENTITY', 'qualityTuneCommerce.productIdentityKey -> canonical_url tier (canonicalizeUrlForIdentity)');
out('CANONICAL_AGREEMENT', JSON.stringify(sameOfferTwoWays.map(canonicalizeUrlForIdentity)));
out('CROSS_RETRIEVAL_IDENTITY_STABLE',
  canonicalizeUrlForIdentity(sameOfferTwoWays[0]) === canonicalizeUrlForIdentity(sameOfferTwoWays[1]) ? 'YES (canonical url)' : 'NO');

// ── §14 cache key invariant, measured BEFORE any change ────────────────────
console.log('\n## CACHE');
const zeroCtx = {
  category: 'footwear', subtype: 'shoes', brand: null, exactItemHypothesis: null,
  queryFingerprint: fingerprintQuery('black loafers'), locale: 'en-US', currency: 'USD', country: 'US',
  shoppingIntentFingerprint: shoppingIntentFingerprint(null),
};
out('BASE_CACHE_KEY_ZERO_MEMORY', buildCommerceCacheKey(zeroCtx));
out('FINGERPRINT_ZERO_CONTEXT', JSON.stringify(shoppingIntentFingerprint(buildShoppingIntent([]))));

// ── §11 failure baseline ───────────────────────────────────────────────────
const action = (shopping) => `Let me look.\n<actions>[{"type":"find_products","shopping":${JSON.stringify(shopping)}}]</actions>`;

const LOAFERS = [
  product('l_black_leather', 'Black Leather Penny Loafer', '$140.00'),
  product('l_black_suede', 'Black Suede Driving Loafer', '$120.00', { source: 'Poshmark' }),
  product('l_navy_leather', 'Navy Leather Tassel Loafer', '$130.00', { source: 'KicksCrew' }),
  product('l_black_canvas', 'Black Canvas Casual Loafer', '$90.00', { source: 'Serper' }),
  product('l_brown_suede', 'Brown Suede Casual Loafer', '$99.00', { source: 'Mr Porter' }),
  product('l_black_horsebit', 'Black Leather Horsebit Loafer', '$145.00', { source: 'Selfridges' }),
  product('l_black_chunky', 'Black Chunky Platform Loafer', '$119.00', { source: 'Nordstrom' }),
  product('l_black_suede_casual', 'Black Suede Casual Loafer', '$105.00', { source: 'Zappos' }),
  product('l_tan_leather', 'Tan Leather Penny Loafer', '$128.00', { source: 'Mr Porter' }),
  product('l_black_formal', 'Black Leather Formal Loafer', '$149.00', { source: 'Harrods' }),
];

const JACKETS = [
  product('j_red_suede', 'Red Suede Moto Jacket', '$220.00'),
  product('j_red_leather', 'Red Leather Biker Jacket', '$260.00', { source: 'Selfridges' }),
  product('j_red_wool', 'Red Wool Overcoat', '$180.00', { source: 'Nordstrom' }),
  product('j_black_suede', 'Black Suede Jacket', '$210.00', { source: 'Mr Porter' }),
];

async function scenario(name, turns) {
  require(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts')).clearCandidateUniverses();
  const provider = makeFixtureProvider({ universe: turns.universe ?? LOAFERS });
  let rows = [];
  const record = [];
  for (const t of turns.list ?? turns) {
    const r = await runTurn({ ...t, priorRows: rows, provider });
    rows = r.rows;
    record.push({ msg: t.message, products: r.products, status: r.status, calls: r.commerceCalls, category: r.state?.category ?? null, memoryOp: r.memoryOp ?? null, notices: r.notices ?? [] });
  }
  const [before, after] = record;
  const repeated = before && after ? before.products.filter((p) => after.products.includes(p)) : [];
  console.log(`\n### ${name}`);
  console.log(`INTENT_BEFORE=${JSON.stringify(before.category)}  INTENT_AFTER=${JSON.stringify(after?.category)}`);
  console.log(`PRODUCTS_BEFORE=${JSON.stringify(before.products)}`);
  console.log(`PRODUCTS_AFTER=${JSON.stringify(after?.products)}`);
  console.log(`REPEATED_IDENTITIES=${JSON.stringify(repeated)}`);
  console.log(`MEMORY_OP=${after?.memoryOp ?? 'none'}  NOTICES=${JSON.stringify(after?.notices ?? [])}  STATUS=${after?.status}`);
  console.log(`PROVIDER_CALLS=${provider.calls.length}`);
  console.log(`OBSERVED_FAILURE=${repeated.length === (after?.products.length ?? 0) && repeated.length > 0 ? 'IDENTICAL SHELF RETURNED' : 'see above'}`);
}

(async () => {
  console.log('\n## PHASE 0 FAILURE BASELINE (current build, before any V2 change)');
  await scenario('Q01 "different ones"', [
    { message: 'Show me black loafers under $150.', modelText: action({ category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD' }) },
    { message: 'Show me different ones.', modelText: action({}) },
  ]);
  await scenario('Q02 "not those"', [
    { message: 'Show me boots.', modelText: action({ category: 'boots' }) },
    { message: 'Not those.', modelText: action({}) },
  ]);
  await scenario('Q03 "something less formal"', [
    { message: 'Find shoes for this outfit.', modelText: action({ category: 'shoes' }) },
    { message: 'Something less formal.', modelText: action({}) },
  ]);
  await scenario('Q04 "maybe suede instead"', Object.assign([
    { message: 'Find a red jacket.', modelText: action({ category: 'jacket', color: 'red' }) },
    { message: 'Maybe suede instead.', modelText: action({ material: 'suede' }) },
  ], { universe: JACKETS }));
  await scenario('Q05 "go back to the first one"', [
    { message: 'Show me black loafers under $150.', modelText: action({ category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD' }) },
    { message: 'Go back to the first one.', modelText: action({}) },
  ]);
  await scenario('Q06 "another"', [
    { message: 'Show me black loafers under $150.', modelText: action({ category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD' }) },
    { message: 'Another.', modelText: action({}) },
  ]);
})();
