#!/usr/bin/env node
/**
 * Explicit-attribute ranking baseline runner (continuation brief sections 12-13).
 *
 * Runs the nine committed fixtures through the REAL ranking authority --
 * `parseContextContributions` -> `buildShoppingIntent` -> the real
 * `filterAndDedupeProducts` -> the real response-boundary annotation -- and
 * records the resulting order with the score that actually decided it.
 *
 *   node tools/activation/rankingBaseline.js            # human readable
 *   node tools/activation/rankingBaseline.js --json     # machine readable
 *   node tools/activation/rankingBaseline.js --write    # rewrite the committed JSON
 *
 * The committed JSON is the BEFORE half of the evidence. It is captured once,
 * before the ranking change, and compared against afterwards. Rewriting it is a
 * deliberate act with a visible diff, never a side effect of a test run.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');
const { buildShoppingIntent, parseContextContributions } = edge('commerceShoppingIntent.ts');
const { attachCommercialUsability, scoreContextualFit } = edge('commerceContextualRanking.ts');
const { scoreProductAgreement } = edge('commerceRelevanceAgreement.ts');
const { FIXTURES } = require(path.join(ROOT, 'tools/activation/attributeStrengthFixtures.js'));

const BASELINE_PATH = path.join(ROOT, 'tools/activation/rankingBaseline.json');
const AFTER_PATH = path.join(ROOT, 'tools/activation/rankingAfter.json');

const ROUTE_BY_ITEM_TYPE = {
  footwear: 'footwear',
  outerwear: 'outerwear',
  dress: 'apparel',
  pants: 'apparel',
  top: 'apparel',
  bag: 'accessory',
  accessory: 'accessory',
};

/**
 * One fixture -> its ordered result, trimmed to the top 5.
 *
 * The contribution goes through `parseContextContributions` first, exactly as a
 * client-supplied one does, so a fixture cannot assert behaviour that a real
 * request could not reach.
 */
function runFixture(fixture) {
  const contributions = parseContextContributions([fixture.contribution]);
  const intent = buildShoppingIntent(contributions, null);
  const route = ROUTE_BY_ITEM_TYPE[String(fixture.identification.item_type)] ?? 'apparel';
  const res = filterAndDedupeProducts(fixture.universe, fixture.identification, {
    enabled: true,
    categoryRoute: route,
    shoppingContext: intent,
    requestActorId: null,
  });
  const annotated = attachCommercialUsability(res.products);
  // The deciding score, recomputed per product rather than read positionally:
  // `stats.agreementScores` is emitted in pre-diversity order, so indexing it by
  // final rank would print a number next to the wrong candidate.
  const decidingScore = (product) => {
    const ag = scoreProductAgreement(product, fixture.identification, route, null);
    const ctx = scoreContextualFit(product, intent);
    return Math.max(0, Math.min(100, ag.score + ctx.delta));
  };
  const top5 = annotated.slice(0, 5).map((product, rank) => ({
    rank: rank + 1,
    id: product.id,
    title: product.title,
    score: decidingScore(product),
    usability: product.commercialUsability ?? null,
    factCodes: product.commerceRationale ? [...product.commerceRationale.factCodes].sort() : [],
  }));
  return {
    id: fixture.id,
    tier: fixture.tier,
    message: fixture.message,
    request: fixture.contribution,
    universe: fixture.universe.map((product) => product.id),
    kept: annotated.length,
    top5,
  };
}

function runAll() {
  return FIXTURES.map(runFixture);
}

function render(results) {
  const lines = [];
  for (const r of results) {
    lines.push(`\n${r.id}  [${r.tier}]  kept=${r.kept}/${r.universe.length}`);
    lines.push(`  "${r.message}"  ->  ${JSON.stringify(r.request)}`);
    if (!r.top5.length) {
      lines.push('    (no candidates)');
      continue;
    }
    for (const product of r.top5) {
      lines.push(
        `    ${product.rank}. ${String(product.score).padStart(3)}  ${product.id.padEnd(20)} ${String(product.usability).padEnd(18)} ${product.title}`,
      );
    }
  }
  return lines.join('\n');
}

/** Ordering only, for a before/after comparison that ignores incidental fields. */
function orderingOf(results) {
  return Object.fromEntries(results.map((r) => [r.id, r.top5.map((product) => product.id)]));
}

module.exports = { runAll, runFixture, render, orderingOf, BASELINE_PATH, AFTER_PATH };

if (require.main === module) {
  const results = runAll();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, BASELINE_PATH)} (${results.length} fixtures)`);
  } else if (process.argv.includes('--write-after')) {
    fs.writeFileSync(AFTER_PATH, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, AFTER_PATH)} (${results.length} fixtures)`);
  } else if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(render(results));
  }
}
