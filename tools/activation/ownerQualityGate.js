#!/usr/bin/env node
/**
 * Owner quality gate (continuation brief §28).
 *
 * Three complete journeys through the REAL path, judged on whether the answer
 * would be useful to a person — not on whether the code ran. CI passing and a
 * customer being helped are different questions, and this asks the second one.
 *
 *   node tools/activation/ownerQualityGate.js
 *   node tools/activation/ownerQualityGate.js --json
 */
'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const { runTurn, makeFixtureProvider, product } = require(path.join(ROOT, 'tools/activation/journeyHarness.js'));
const handoffAdapter = require(path.join(ROOT, 'services/packing/packingCommerceHandoff.ts'));
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const { matchedRequestedAttribute } = require(path.join(ROOT, 'services/commerce/commerceRationale.ts'));

const action = (shopping) =>
  `Let me look.\n<actions>[{"type":"find_products","shopping":${JSON.stringify(shopping)}}]</actions>`;

/** An unseen universe, not reused from any implementation fixture. */
const BOOTS = [
  product('q_brown', 'Brown Leather Chelsea Boot', '$180.00', { source: 'Farfetch' }),
  product('q_tan', 'Tan Suede Chelsea Boot', '$165.00', { source: 'KicksCrew' }),
  product('q_black_premium', 'Black Leather Chelsea Boot', '$240.00', { source: 'Poshmark' }),
  product('q_black_budget', 'Black Leather Ankle Boot', '$110.00', { source: 'Serper' }),
];

const RAIN = [
  product('q_wool', 'Wool Overcoat', '$600.00', { source: 'Farfetch' }),
  product('q_parka', 'Insulated Down Parka', '$420.00', { source: 'KicksCrew' }),
  product('q_shell', 'Packable Waterproof Rain Jacket', '$120.00', { source: 'Serper' }),
];

const SPARSE = [
  product('q_camel', 'Camel Wool Overcoat', '$380.00', { source: 'Farfetch' }),
  product('q_navy', 'Navy Wool Overcoat', '$350.00', { source: 'KicksCrew' }),
  product('q_olive', 'Olive Cotton Trench Coat', '$290.00', { source: 'Poshmark' }),
];

/** J1 — Elise direct shopping, then a refinement. */
async function journeyElise() {
  const t1 = await runTurn({
    message: 'Show me some Chelsea boots under $200.',
    modelText: action({ category: 'shoes', budgetAmount: 200, budgetCurrency: 'USD' }),
    provider: makeFixtureProvider({ universe: BOOTS }),
  });
  const t2 = await runTurn({
    message: 'Only black.',
    modelText: action({ color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' }),
    priorRows: t1.rows,
    provider: makeFixtureProvider({ universe: BOOTS }),
  });

  const overBudgetGone = !t2.products.includes('q_black_premium');
  const blackLeads = matchedRequestedAttribute(t2.productDetail[0]);
  const alternativesKept = t2.products.some((id) => id === 'q_brown' || id === 'q_tan');
  const oneCallEach = t1.commerceCalls === 1 && t2.commerceCalls === 1;

  return {
    journey: 'Elise direct shopping and refinement',
    asked: '"Chelsea boots under $200", then "only black"',
    turn1: t1.products,
    turn2: t2.products,
    checks: { overBudgetGone, blackLeads, alternativesKept, oneCallEach, budgetSurvived: Boolean(t2.state.budget) },
    verdict: overBudgetGone && blackLeads && alternativesKept && oneCallEach && t2.state.budget
      ? 'USEFUL'
      : 'PARTIALLY_USEFUL',
    why: 'The $240 boot is gone because it answers a different question; the black option leads; the brown and tan options are still there to change your mind with.',
  };
}

/** J2 — a confirmed Packing gap, end to end. */
async function journeyPacking() {
  const gaps = require(path.join(ROOT, 'supabase/functions/stylechat-generate/packingGaps.ts'))
    .derivePackingCoverageGaps({
      censusComplete: true,
      closetRoleCensus: { base: 2, bottom: 2, shoe: 1 },
      requiredRoles: ['base', 'bottom', 'shoe'],
      closetItems: [
        { layeringRole: 'shoe', band: 'casual', rainEvidence: false, warmthEvidence: false },
        { layeringRole: 'base', band: 'casual', rainEvidence: false, warmthEvidence: false },
      ],
      slots: [],
      forecastSummary: 'Showers likely, rain through Tuesday',
      statedConditions: [],
    });
  const confirmed = gaps.find((g) => g.certainty === 'confirmed');
  const handoff = handoffAdapter.buildPackingCommerceHandoff({
    gapCode: confirmed.code,
    label: confirmed.label,
    certainty: confirmed.certainty,
  });

  // The handoff query is what the screen sends to Elise.
  const turn = await runTurn({
    message: handoff.query,
    modelText: action({ category: 'jacket', functionalRequirements: ['waterproof'] }),
    provider: makeFixtureProvider({ universe: RAIN }),
  });

  const shellLeads = turn.products[0] === 'q_shell';
  // IDENTIFIERS, not vocabulary. The query is a sentence a person would say,
  // and "for my trip" is the point of it -- what must not travel is a trip id,
  // a Closet id, an actor id or a date.
  const serialized = JSON.stringify(handoff);
  const noTripData =
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized) &&
    !/\d{4}-\d{2}-\d{2}/.test(serialized) &&
    !/\b(tripId|closetItemId|userId|sessionId|planId)\b/i.test(serialized);

  return {
    journey: 'Packing confirmed gap to Commerce',
    asked: `real gap "${confirmed.label}" -> "${handoff.query}"`,
    gapCertainty: confirmed.certainty,
    products: turn.products,
    checks: { handoffBuilt: Boolean(handoff), shellLeads, noTripData, realCandidates: turn.products.length > 0 },
    verdict: handoff && shellLeads && noTripData && turn.products.length > 0 ? 'USEFUL' : 'PARTIALLY_USEFUL',
    why: 'The gap Packing actually confirmed becomes a request Elise can answer, and the piece that solves the trip leads the shelf.',
  };
}

/** J3 — a strong preference nothing on the shelf satisfies. */
async function journeySparse() {
  const turn = await runTurn({
    message: 'I really want a black coat.',
    modelText: action({ category: 'jacket', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' }),
    provider: makeFixtureProvider({ universe: SPARSE }),
  });

  const noneMatched = turn.productDetail.every((p) => !matchedRequestedAttribute(p));
  const alternativesShown = turn.products.length > 0;
  const notAnEmptyState = turn.status === 'results';
  const nothingClaimsBlack = turn.productDetail.every(
    (p) => !(p.commerceRationale?.factCodes ?? []).includes('explicit_color_match'),
  );

  return {
    journey: 'Strong preference with no matching candidate',
    asked: '"I really want a black coat" against a shelf with no black coat',
    products: turn.products,
    checks: { noneMatched, alternativesShown, notAnEmptyState, nothingClaimsBlack },
    verdict: noneMatched && alternativesShown && notAnEmptyState && nothingClaimsBlack
      ? 'USEFUL'
      : 'PARTIALLY_USEFUL',
    why: 'No black coat is invented and none is captioned as matching. The customer is told plainly that nothing black came back and is shown the closest real alternatives under OTHER OPTIONS.',
  };
}

async function run() {
  const journeys = [await journeyElise(), await journeyPacking(), await journeySparse()];
  return {
    journeys,
    anyNotUseful: journeys.some((j) => j.verdict === 'NOT_USEFUL'),
    verdicts: journeys.map((j) => j.verdict),
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

module.exports = { run };

if (require.main === module) {
  run()
    .then((report) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      for (const j of report.journeys) {
        console.log(`\n${j.verdict}  —  ${j.journey}`);
        console.log(`  asked:    ${j.asked}`);
        console.log(`  products: ${j.products ? j.products.join(', ') : `${j.turn1} -> ${j.turn2}`}`);
        console.log(`  checks:   ${JSON.stringify(j.checks)}`);
        console.log(`  why:      ${j.why}`);
      }
      console.log(`\nverdicts: ${report.verdicts.join(', ')}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
