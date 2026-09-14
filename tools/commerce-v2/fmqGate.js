#!/usr/bin/env node
/**
 * Commerce V2 FMQ gate (brief §52).
 *
 * WHY A THIRD FMQ ARM. #409 proved its contextual WEIGHTS do not degrade
 * fashion match. #410's activation gate proved that ATTACHING live context
 * does not. Commerce V2 changes a third thing: a richer USER-STATED axis now
 * reaches the ranker, so a customer who says "suede" moves candidates that a
 * customer who says nothing does not.
 *
 * The arms are deliberately CORRECT-BY-CONSTRUCTION: each fixture's richer
 * axis is taken from its own ground truth, so the question asked is "does
 * stating a true attribute make the match better or worse?" — not "can a
 * contradictory request be made to win?", which is a different question with
 * an obvious answer.
 *
 * SUGGESTIVE ENGINEERING EVIDENCE, NOT A PR GATE. Synthetic corpus, no
 * significance claim, and the corpus is never tuned to make a number move.
 *
 *   node tools/commerce-v2/fmqGate.js
 *   node tools/commerce-v2/fmqGate.js --json
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));

const { loadSyntheticCorpus } = require(path.join(ROOT, 'tools/fashion-match-quality/corpus/corpusLoader'));
const { scoreIdentity } = require(path.join(ROOT, 'tools/fashion-match-quality/evaluator/identityAxis'));
const { scoreSubstitute } = require(path.join(ROOT, 'tools/fashion-match-quality/evaluator/substituteAxis'));
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');
const { buildShoppingIntent } = edge('commerceShoppingIntent.ts');

const ROUTE_BY_ARCHETYPE = {
  top: 'apparel', dress: 'apparel', pants: 'apparel', outerwear: 'outerwear',
  footwear: 'footwear', bag: 'accessory', accessory: 'accessory',
};
const CATEGORY_BY_ARCHETYPE = {
  top: 'top', dress: 'dress', pants: 'pants', outerwear: 'outerwear',
  footwear: 'footwear', bag: 'bag', accessory: 'accessory',
};
const WRONG_AXES = ['color_family', 'silhouette', 'material', 'pattern'];

const toProduct = (c) => ({
  ...c,
  id: c.id,
  title: c.title || c.name,
  source: c.retailer,
  price: typeof c.price === 'number' ? String(c.price) : c.price,
  currency: c.currency,
  type: 'retail',
  imageUrl: c.imageUrl,
  productUrl: c.purchaseUrl,
});

function candidateAxis(candidate, axis) {
  if (!candidate) return undefined;
  if (candidate[axis] !== undefined && candidate[axis] !== null) return candidate[axis];
  if (axis === 'color_family') return candidate.color_normalized ?? candidate.color;
  return undefined;
}

function axisWrong(candidate, groundTruth, axis) {
  const g = groundTruth?.[axis];
  if (g === undefined || g === null) return null;
  const c = candidateAxis(candidate, axis);
  if (c === undefined || c === null) return true;
  return c !== g;
}

/** The V2 arm: the customer states a TRUE richer attribute about what they want. */
function richerIntentFor(fixture, axis) {
  const gt = fixture.groundTruth || {};
  const value = gt[axis];
  if (typeof value !== 'string' || !value.trim()) return null;
  return buildShoppingIntent([{
    provenance: 'USER_EXPLICIT',
    category: CATEGORY_BY_ARCHETYPE[fixture.archetype] ?? undefined,
    [axis]: value.toLowerCase(),
  }], 'actor-fmq');
}

function rankArm(fixture, intent) {
  const products = (fixture.candidateProducts || []).map(toProduct);
  const res = filterAndDedupeProducts(products, fixture.garmentIdentification || {}, {
    enabled: true,
    categoryRoute: ROUTE_BY_ARCHETYPE[fixture.archetype] || 'apparel',
    ...(intent ? { shoppingContext: intent, requestActorId: 'actor-fmq' } : {}),
  });
  const top = res.products[0] || null;
  const original = top ? (fixture.candidateProducts || []).find((c) => c.id === top.id) : null;
  return {
    top: top && original ? { ...original, purchaseUrl: top.productUrl ?? original.purchaseUrl } : null,
    order: res.products.map((p) => p.id),
  };
}

function summarize(arm, fixtures) {
  const identity = {};
  const substitute = {};
  const wrong = Object.fromEntries(WRONG_AXES.map((a) => [a, { wrong: 0, scored: 0 }]));
  let noPurchasePath = 0;

  arm.forEach((result, i) => {
    const gt = fixtures[i].groundTruth || {};
    if (!result.top) {
      identity.UNKNOWN = (identity.UNKNOWN || 0) + 1;
      substitute.UNUSABLE = (substitute.UNUSABLE || 0) + 1;
      return;
    }
    identity[scoreIdentity(result.top, gt).level] = (identity[scoreIdentity(result.top, gt).level] || 0) + 1;
    const sub = scoreSubstitute(result.top, gt);
    const level = sub.insufficientEvidence ? 'INSUFFICIENT_EVIDENCE' : sub.level;
    substitute[level] = (substitute[level] || 0) + 1;
    if (sub.reason === 'no_actionable_purchase_path') noPurchasePath += 1;
    for (const axis of WRONG_AXES) {
      const verdict = axisWrong(result.top, gt, axis);
      if (verdict === null) continue;
      wrong[axis].scored += 1;
      if (verdict) wrong[axis].wrong += 1;
    }
  });

  return {
    identityQuality: identity,
    substituteQuality: substitute,
    wrongAttributeRates: Object.fromEntries(
      WRONG_AXES.map((a) => [`${a}_wrong_rate`, wrong[a].scored ? Number((wrong[a].wrong / wrong[a].scored).toFixed(3)) : 0]),
    ),
    topResultWithNoPurchasePath: noPurchasePath,
  };
}

function main() {
  const fixtures = loadSyntheticCorpus();
  const control = fixtures.map((f) => rankArm(f, null));
  const controlSummary = summarize(control, fixtures);

  const arms = {};
  for (const axis of ['material', 'silhouette']) {
    const applicable = [];
    const results = [];
    let orderChanged = 0;
    fixtures.forEach((fixture, i) => {
      const intent = richerIntentFor(fixture, axis);
      if (!intent) return;
      applicable.push(fixture);
      const armResult = rankArm(fixture, intent);
      results.push(armResult);
      if (armResult.order.join('|') !== control[i].order.join('|')) orderChanged += 1;
    });
    arms[axis] = {
      fixturesWithGroundTruthForAxis: applicable.length,
      orderChangedCount: orderChanged,
      control: summarize(applicable.map((f) => control[fixtures.indexOf(f)]), applicable),
      richer: summarize(results, applicable),
    };
  }

  const regressions = [];
  for (const [axis, arm] of Object.entries(arms)) {
    if (!arm.fixturesWithGroundTruthForAxis) continue;
    const beforeExact = arm.control.identityQuality.EXACT ?? 0;
    const afterExact = arm.richer.identityQuality.EXACT ?? 0;
    if (afterExact < beforeExact) regressions.push(`${axis}: EXACT identity fell ${beforeExact} -> ${afterExact}`);
    for (const key of Object.keys(arm.control.wrongAttributeRates)) {
      if (arm.richer.wrongAttributeRates[key] > arm.control.wrongAttributeRates[key]) {
        regressions.push(`${axis}: ${key} rose ${arm.control.wrongAttributeRates[key]} -> ${arm.richer.wrongAttributeRates[key]}`);
      }
    }
    if (arm.richer.topResultWithNoPurchasePath > arm.control.topResultWithNoPurchasePath) {
      regressions.push(`${axis}: commercial usability of the top result degraded`);
    }
  }

  // HONESTY ABOUT WHAT THIS RUN CAN AND CANNOT SHOW.
  //
  // The synthetic corpus already ranks the exact match first in every fixture,
  // so an arm that states a TRUE attribute has no room to improve anything and
  // no ordering to move. A clean "no regression" from a saturated corpus is
  // evidence that the axis does no HARM; it is not evidence that the axis
  // works, and reporting it as though it were would be the quiet kind of
  // dishonesty this gate exists to avoid.
  const controlExact = controlSummary.identityQuality.EXACT ?? 0;
  const saturated = controlExact === fixtures.length;
  const movedAnything = Object.values(arms).some((a) => a.orderChangedCount > 0);

  const report = {
    corpusFixtures: fixtures.length,
    discrimination: saturated && !movedAnything
      ? {
        status: 'NON_DISCRIMINATING',
        why: `the control arm is already EXACT on ${controlExact}/${fixtures.length} fixtures, so a true stated attribute has nothing to correct and no order to change`,
        meaning: 'this run shows the richer axes do no harm; it does NOT show they work',
        positiveEvidenceLivesIn: [
          '__tests__/commerce/commerceV2RicherIntent.test.js :: AXIS GATE (the ranker delta per axis)',
          '__tests__/commerce/commerceV2RicherIntent.test.js :: BLOCK-CV2-16 (a real order change on a material-diverse fixture)',
        ],
      }
      : { status: 'DISCRIMINATING', armsThatMovedOrder: Object.entries(arms).filter(([, a]) => a.orderChangedCount > 0).map(([k]) => k) },
    controlSummary,
    arms,
    regressions,
    verdict: regressions.length ? 'REVIEW_REQUIRED' : 'NO_MATERIAL_REGRESSION',
    statisticalClaim: 'NONE — synthetic corpus, gross-regression catch only',
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
    note:
      'A stated TRUE attribute is expected to change ordering. Where it does, that is the ' +
      'feature working; the gate watches for identity quality falling, wrong-attribute rates ' +
      'rising, or the top result losing its purchase path.',
  };

  console.log(JSON.stringify(report, null, 2));
  return report;
}

main();
