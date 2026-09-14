#!/usr/bin/env node
/**
 * Activation FMQ regression gate (activation brief section 32).
 *
 * WHY THIS EXISTS SEPARATELY FROM #409's GATE. #409 proved that its own
 * contextual WEIGHTS do not degrade fashion match. Activation changes
 * something else: which context actually gets ATTACHED. Live Closet,
 * Signature Style and Packing context can move ranking inputs without any
 * weight changing, so the same candidate sets are scored twice — context OFF
 * and context ON — by the existing Fashion Match Quality axes.
 *
 * Purpose is a gross-regression catch, not a significance test. Nothing here
 * alters FMQ or any ranking weight.
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));

const { loadSyntheticCorpus } = require(path.join(ROOT, 'tools/fashion-match-quality/corpus/corpusLoader'));
const { scoreIdentity } = require(path.join(ROOT, 'tools/fashion-match-quality/evaluator/identityAxis'));
const { scoreSubstitute } = require(path.join(ROOT, 'tools/fashion-match-quality/evaluator/substituteAxis'));
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');
const { buildShoppingIntent, parseContextContributions } = edge('commerceShoppingIntent.ts');
const activation = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));

const ROUTE_BY_ARCHETYPE = {
  top: 'apparel', dress: 'apparel', pants: 'apparel', outerwear: 'outerwear',
  footwear: 'footwear', bag: 'accessory', accessory: 'accessory',
};

const CATEGORY_BY_ARCHETYPE = {
  top: 'top', dress: 'dress', pants: 'pants', outerwear: 'outerwear',
  footwear: 'footwear', bag: 'bag', accessory: 'accessory',
};

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

const WRONG_AXES = ['color_family', 'silhouette', 'material', 'pattern'];

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

/**
 * The context ACTIVATION attaches, assembled through the real activation
 * path: a same-category Closet piece and the wearer's Signature Style, both
 * actor-stamped, exactly as `buildActivationEvidence` would produce them.
 *
 * Deliberately NON-CONTRADICTING — drawn from the fixture's own ground truth —
 * because the risk being measured is live context DISPLACING a correct match,
 * not a customer deliberately asking for something else.
 */
function activationContextFor(fixture) {
  const gt = fixture.groundTruth || {};
  const category = CATEGORY_BY_ARCHETYPE[fixture.archetype] ?? null;
  const evidence = activation.buildActivationEvidence({
    state: {
      category,
      color: null,
      budget: null,
      exclusions: [],
      functionalRequirements: [],
    },
    actorId: 'actor-fmq',
    closetItems: [
      {
        title: String(gt.titleNormalized ?? 'owned piece'),
        category: String(gt.category ?? category ?? ''),
        color: gt.color_family ?? null,
        material: gt.material ?? null,
      },
    ],
    signatureStyleTokens: [gt.silhouette, gt.pattern].filter(Boolean),
  });
  if (!evidence?.shoppingContext) return null;
  return buildShoppingIntent(parseContextContributions(evidence.shoppingContext), 'actor-fmq');
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
    scores: res.stats.agreementScores ?? [],
    contextApplied: res.stats.contextualApplied === true,
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
    const id = scoreIdentity(result.top, gt);
    identity[id.level] = (identity[id.level] || 0) + 1;
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

  const rates = {};
  for (const axis of WRONG_AXES) {
    const { wrong: w, scored } = wrong[axis];
    rates[`${axis}_wrong_rate`] = scored ? +(w / scored).toFixed(4) : null;
  }
  return { identityQuality: identity, substituteQuality: substitute, wrongAttributeRates: rates, topResultWithNoPurchasePath: noPurchasePath };
}

const IDENTITY_GOOD = new Set(['EXACT', 'EXACT_PRODUCT', 'SAME_PRODUCT_DIFFERENT_RETAILER', 'SAME_MODEL_FAMILY']);
const SUBSTITUTE_GOOD = new Set(['STRONG_SUBSTITUTE', 'ACCEPTABLE_SUBSTITUTE']);
const countIn = (dist, allowed) => Object.entries(dist).reduce((n, [k, v]) => (allowed.has(k) ? n + v : n), 0);

function run() {
  const fixtures = loadSyntheticCorpus().filter((f) => f.groundTruth?.confidence === 'authoritative');
  const contextOff = fixtures.map((f) => rankArm(f, null));
  const contextOn = fixtures.map((f) => rankArm(f, activationContextFor(f)));

  const off = summarize(contextOff, fixtures);
  const on = summarize(contextOn, fixtures);

  let scoreChanged = 0;
  let maxAbsShift = 0;
  contextOff.forEach((c, i) => {
    const a = contextOn[i];
    let changed = false;
    for (let k = 0; k < Math.max(c.scores.length, a.scores.length); k += 1) {
      const delta = Math.abs((a.scores[k] ?? 0) - (c.scores[k] ?? 0));
      if (delta > 0) changed = true;
      if (delta > maxAbsShift) maxAbsShift = delta;
    }
    if (changed) scoreChanged += 1;
  });

  const regressions = [];
  if (countIn(on.identityQuality, IDENTITY_GOOD) < countIn(off.identityQuality, IDENTITY_GOOD)) {
    regressions.push('identity quality fell with live context attached');
  }
  if (countIn(on.substituteQuality, SUBSTITUTE_GOOD) < countIn(off.substituteQuality, SUBSTITUTE_GOOD)) {
    regressions.push('substitute quality fell with live context attached');
  }
  for (const axis of WRONG_AXES) {
    const key = `${axis}_wrong_rate`;
    if (off.wrongAttributeRates[key] === null || on.wrongAttributeRates[key] === null) continue;
    if (on.wrongAttributeRates[key] > off.wrongAttributeRates[key]) {
      regressions.push(`${axis} wrong-rate rose: ${off.wrongAttributeRates[key]} -> ${on.wrongAttributeRates[key]}`);
    }
  }
  if (on.topResultWithNoPurchasePath > off.topResultWithNoPurchasePath) {
    regressions.push('more top results lost their purchase path');
  }

  return {
    corpusTier: 'SYNTHETIC',
    fixtures: fixtures.length,
    fixturesWhereContextApplied: contextOn.filter((c) => c.contextApplied).length,
    perturbation: { fixturesWithScoreChange: scoreChanged, maxAbsScoreShift: maxAbsShift },
    contextOff: off,
    contextOn: on,
    regressions,
    verdict: regressions.length === 0 ? 'NO_MATERIAL_REGRESSION' : 'REGRESSION_DETECTED',
    statisticalClaim: 'NONE — synthetic corpus, gross-regression catch only',
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

if (require.main === module) {
  const r = run();
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.verdict === 'NO_MATERIAL_REGRESSION' ? 0 : 1;
}

module.exports = { run };
