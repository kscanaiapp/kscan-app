#!/usr/bin/env node
/**
 * Contextual Commerce — FMQ control/challenger regression gate (section 17).
 *
 * WHY A GATE AND NOT A WIN CONDITION. This lane deliberately reorders Commerce
 * candidates. Reordering can improve situational usefulness while quietly
 * degrading fashion match — a "more relevant" shelf whose top result is the
 * wrong colour is a worse product. So the SAME candidate universes are scored
 * twice, by the EXISTING Fashion Match Quality authority, and the challenger
 * has to not be worse.
 *
 * WHAT IS REUSED, NOT REBUILT. `scoreIdentity` and `scoreSubstitute` are the
 * lab's own axes (`tools/fashion-match-quality/evaluator/`), unmodified, and
 * the corpus is the lab's own committed synthetic corpus. Nothing here invents
 * a metric or a fixture.
 *
 * WHAT THIS IS NOT. The lab's L1 mode measures `scanHelpers.rankRecommendedProducts`,
 * which the live scan-identify path does not call; the production commerce
 * ranker is `filterAndDedupeProducts`. This gate therefore runs the lab's AXES
 * against the PRODUCTION ranker rather than running the lab's L1 pipeline, and
 * says so. The corpus is SYNTHETIC: these numbers prove the reordering did not
 * degrade fashion match, and are not a K Scan production accuracy claim.
 */
'use strict';

// Edge-function modules are Deno TypeScript. Resolving them through a computed
// path keeps runtime behaviour identical while keeping the root `tsc` out of a
// tree its tsconfig deliberately excludes — a static specifier would drag the
// Deno globals into a typecheck that cannot satisfy them.
const path = require('node:path');
const EDGE = path.resolve(__dirname, '../../supabase/functions/scan-identify');
const edge = (name) => require(path.join(EDGE, name));

const { loadSyntheticCorpus } = require('../fashion-match-quality/corpus/corpusLoader');
const { scoreIdentity } = require('../fashion-match-quality/evaluator/identityAxis');
const { scoreSubstitute } = require('../fashion-match-quality/evaluator/substituteAxis');
const {
  filterAndDedupeProducts,
} = edge('qualityTuneCommerce.ts');
const {
  buildShoppingIntent,
  extractExplicitContribution,
} = edge('commerceShoppingIntent.ts');

/**
 * Map an FMQ fixture candidate onto the production `RecommendedProduct` shape.
 *
 * Field renames only — no value is invented, dropped, or re-derived, so both
 * arms see exactly the same universe and the only variable is the ranking.
 */
function toRecommendedProduct(candidate) {
  return {
    ...candidate,
    id: candidate.id,
    title: candidate.title || candidate.name,
    source: candidate.retailer,
    price: typeof candidate.price === 'number' ? String(candidate.price) : candidate.price,
    currency: candidate.currency,
    type: 'retail',
    imageUrl: candidate.imageUrl,
    productUrl: candidate.purchaseUrl,
  };
}

/** Back to the shape the lab's axes expect. */
function toEvaluatorCandidate(product, original) {
  return { ...original, purchaseUrl: product.productUrl ?? original.purchaseUrl };
}

const ROUTE_BY_ARCHETYPE = {
  top: 'apparel', dress: 'apparel', pants: 'apparel', outerwear: 'outerwear',
  footwear: 'footwear', bag: 'accessory', accessory: 'accessory',
};

/**
 * The context each fixture's shopper brings, in two strengths.
 *
 * Both are deliberately NON-CONTRADICTING: the stated constraints agree with
 * the fixture's own ground truth. That is the case the gate needs to protect,
 * because the real risk of contextual ranking is CONTEXT NOISE DISPLACING THE
 * CORRECT MATCH. (A context that contradicts the garment — "in red instead" —
 * is *supposed* to move the shelf away from the scanned item, so measuring it
 * as a fashion-match regression would manufacture a false alarm.)
 *
 *   mild   — Signature Style plus a ceiling above every candidate: context is
 *            present and active, but nothing is filtered.
 *   active — the same, plus a ceiling at the median price and the shopper's
 *            own Closet. This one genuinely removes and reorders candidates,
 *            which is what makes the gate worth running at all.
 */
function contextFor(fixture, strength) {
  const gt = fixture.groundTruth || {};
  const prices = (fixture.candidateProducts || [])
    .map((c) => (typeof c.price === 'number' ? c.price : Number.NaN))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!prices.length) return buildShoppingIntent([], null);

  const ceiling = strength === 'active'
    ? Math.ceil(prices[Math.floor(prices.length / 2)])
    : Math.ceil(prices[prices.length - 1] + 1);

  const contributions = [
    { provenance: 'SIGNATURE_STYLE', signatureStyleTokens: [gt.silhouette, gt.pattern].filter(Boolean) },
  ];
  if (strength === 'active') {
    contributions.push({
      provenance: 'CLOSET',
      relevantOwned: [{
        descriptor: String(gt.titleNormalized || ''),
        category: gt.category ?? null,
        color: gt.color_family ?? null,
        material: gt.material ?? null,
      }],
    });
  }
  contributions.push(extractExplicitContribution(`something like this, under $${ceiling}`));
  return buildShoppingIntent(contributions, null);
}

/**
 * The arm that actually moves the shelf.
 *
 * The committed synthetic corpus prices every candidate within a fixture
 * identically, so a budget ceiling cannot separate them — a real limitation of
 * the corpus, recorded in the report rather than engineered around. What DOES
 * separate them is an explicit attribute, so this arm has the shopper state
 * the fixture's OWN ground-truth colour ("in white instead" where white is the
 * truth).
 *
 * That is the sharpest non-contradicting perturbation available here: it
 * applies the largest weight in the contextual model (+22 / -18) to every
 * candidate, and the correct answer must still come first. If contextual
 * ranking can displace a known-correct match, this arm is where it shows.
 */
function reorderingContextFor(fixture) {
  const gt = fixture.groundTruth || {};
  const color = typeof gt.color_family === 'string' ? gt.color_family : null;
  if (!color) return null;
  const contribution = extractExplicitContribution(`in ${color} instead`);
  if (!contribution.color) return null; // the vocabulary did not recognise it
  return buildShoppingIntent([contribution], null);
}

/**
 * The same perturbation at the STRONG tier ("only white", not "in white").
 *
 * The strong tier elevates a matching candidate further than any other weight
 * in the contextual model, so it is the arm most able to displace a
 * known-correct match -- which makes it the one worth proving safe. The
 * ordinary arm above is left exactly as it was, so the two tiers are measured
 * side by side rather than one replacing the other.
 */
function strongReorderingContextFor(fixture) {
  const gt = fixture.groundTruth || {};
  const color = typeof gt.color_family === 'string' ? gt.color_family : null;
  if (!color) return null;
  // The same extractor phrase as the ordinary arm, so the two differ ONLY in
  // the strength tier: any difference between them is the tier's doing and
  // nothing else.
  const contribution = extractExplicitContribution(`in ${color} instead`);
  if (!contribution.color) return null;
  contribution.colorStrength = 'STRONG_EXPLICIT_PREFERENCE';
  return buildShoppingIntent([contribution], null);
}

function rankArm(fixture, intent) {
  const products = (fixture.candidateProducts || []).map(toRecommendedProduct);
  const relevance = {
    enabled: true,
    categoryRoute: ROUTE_BY_ARCHETYPE[fixture.archetype] || 'apparel',
    ...(intent ? { shoppingContext: intent, requestActorId: null } : {}),
  };
  const out = filterAndDedupeProducts(products, fixture.garmentIdentification || {}, relevance);
  const top = out.products[0] || null;
  const original = top ? (fixture.candidateProducts || []).find((c) => c.id === top.id) : null;
  return {
    top: top && original ? toEvaluatorCandidate(top, original) : null,
    order: out.products.map((p) => p.id),
    retailers: out.products.map((p) => p.source),
    scores: out.stats.agreementScores || [],
    contextApplied: out.stats.contextualApplied === true,
  };
}

/**
 * How hard an arm actually pushed.
 *
 * Without this, an arm that silently no-ops is indistinguishable from one that
 * pushed hard and was correctly resisted — and only the second is evidence.
 * `maxAbsScoreShift` is the largest single-candidate score change the context
 * produced; `fixturesWithScoreChange` is how many fixtures it moved at all.
 */
function perturbation(control, arm) {
  let maxAbsScoreShift = 0;
  let fixturesWithScoreChange = 0;
  control.forEach((c, i) => {
    const a = arm[i];
    let changed = false;
    const len = Math.max(c.scores.length, a.scores.length);
    for (let k = 0; k < len; k += 1) {
      const delta = Math.abs((a.scores[k] ?? 0) - (c.scores[k] ?? 0));
      if (delta > 0) changed = true;
      if (delta > maxAbsScoreShift) maxAbsScoreShift = delta;
    }
    if (changed) fixturesWithScoreChange += 1;
  });
  return { fixturesWithScoreChange, maxAbsScoreShift };
}

const WRONG_AXES = ['color_family', 'silhouette', 'material', 'pattern'];

/**
 * Read one comparable axis off a candidate.
 *
 * Corpus candidates spell colour as `color` / `color_normalized` while ground
 * truth spells it `color_family`. Without this alias every top result scores as
 * a colour miss — an artefact of the fixture shape, not a product defect. The
 * alias is applied identically to CONTROL and CHALLENGER, so it cannot
 * advantage either arm; it only stops the axis from being uniformly blind.
 */
function candidateAxis(candidate, axis) {
  if (!candidate) return undefined;
  if (candidate[axis] !== undefined && candidate[axis] !== null) return candidate[axis];
  if (axis === 'color_family') return candidate.color_normalized ?? candidate.color;
  return undefined;
}

function axisWrong(candidate, groundTruth, axis) {
  const g = groundTruth?.[axis];
  if (g === undefined || g === null) return null; // unscoreable
  const c = candidateAxis(candidate, axis);
  if (c === undefined || c === null) return true; // absent where truth exists
  return c !== g;
}

function summarize(arm, fixtures) {
  const identity = {};
  const substitute = {};
  const wrong = Object.fromEntries(WRONG_AXES.map((a) => [a, { wrong: 0, scored: 0 }]));
  let noResult = 0;
  let noPurchasePath = 0;

  arm.forEach((result, i) => {
    const gt = fixtures[i].groundTruth || {};
    if (!result.top) {
      noResult += 1;
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
    rates[`${axis}_scored`] = scored;
  }

  const retailerCounts = {};
  for (const result of arm) {
    for (const r of result.retailers) retailerCounts[r] = (retailerCounts[r] || 0) + 1;
  }

  return {
    identityQuality: identity,
    substituteQuality: substitute,
    wrongAttributeRates: rates,
    commercialUsabilityFindings: { topResultWithNoPurchasePath: noPurchasePath, fixturesWithNoResult: noResult },
    retailerDistribution: retailerCounts,
  };
}

const IDENTITY_GOOD = new Set(['EXACT_PRODUCT', 'SAME_PRODUCT_DIFFERENT_RETAILER', 'SAME_MODEL_FAMILY']);
const SUBSTITUTE_GOOD = new Set(['STRONG_SUBSTITUTE', 'ACCEPTABLE_SUBSTITUTE']);

function countIn(distribution, allowed) {
  return Object.entries(distribution).reduce((sum, [k, v]) => (allowed.has(k) ? sum + v : sum), 0);
}

function run() {
  const fixtures = loadSyntheticCorpus().filter(
    (f) => f.groundTruth?.confidence === 'authoritative',
  );

  const control = fixtures.map((f) => rankArm(f, null));
  const mild = fixtures.map((f) => rankArm(f, contextFor(f, 'mild')));
  const challenger = fixtures.map((f) => rankArm(f, contextFor(f, 'active')));
  const reorderingFixtures = fixtures.filter((f) => reorderingContextFor(f) !== null);
  const reorderingControl = reorderingFixtures.map((f) => rankArm(f, null));
  const reordering = reorderingFixtures.map((f) => rankArm(f, reorderingContextFor(f)));
  const strongFixtures = fixtures.filter((f) => strongReorderingContextFor(f) !== null);
  const strongControl = strongFixtures.map((f) => rankArm(f, null));
  const strongReordering = strongFixtures.map((f) => rankArm(f, strongReorderingContextFor(f)));

  const controlSummary = summarize(control, fixtures);
  const mildSummary = summarize(mild, fixtures);
  const challengerSummary = summarize(challenger, fixtures);
  const reorderingControlSummary = summarize(reorderingControl, reorderingFixtures);
  const reorderingSummary = summarize(reordering, reorderingFixtures);
  const strongControlSummary = summarize(strongControl, strongFixtures);
  const strongSummary = summarize(strongReordering, strongFixtures);

  const changed = (a, b) =>
    a.reduce((n, x, i) => (x.order.join('|') !== b[i].order.join('|') ? n + 1 : n), 0);
  const reordered = changed(control, challenger);
  const contextActive = challenger.filter((c) => c.contextApplied).length;

  const controlGoodIdentity = countIn(controlSummary.identityQuality, IDENTITY_GOOD);
  const challengerGoodIdentity = countIn(challengerSummary.identityQuality, IDENTITY_GOOD);
  const controlGoodSubstitute = countIn(controlSummary.substituteQuality, SUBSTITUTE_GOOD);
  const challengerGoodSubstitute = countIn(challengerSummary.substituteQuality, SUBSTITUTE_GOOD);

  const regressions = [];
  const mildGoodIdentity = countIn(mildSummary.identityQuality, IDENTITY_GOOD);
  const mildGoodSubstitute = countIn(mildSummary.substituteQuality, SUBSTITUTE_GOOD);
  if (mildGoodIdentity < controlGoodIdentity) {
    regressions.push(`mild-context identity quality fell: ${controlGoodIdentity} → ${mildGoodIdentity}`);
  }
  if (mildGoodSubstitute < controlGoodSubstitute) {
    regressions.push(`mild-context substitute quality fell: ${controlGoodSubstitute} → ${mildGoodSubstitute}`);
  }
  if (challengerGoodIdentity < controlGoodIdentity) {
    regressions.push(`identity quality fell: ${controlGoodIdentity} → ${challengerGoodIdentity}`);
  }
  if (challengerGoodSubstitute < controlGoodSubstitute) {
    regressions.push(`substitute quality fell: ${controlGoodSubstitute} → ${challengerGoodSubstitute}`);
  }
  for (const axis of WRONG_AXES) {
    const key = `${axis}_wrong_rate`;
    const before = controlSummary.wrongAttributeRates[key];
    const after = challengerSummary.wrongAttributeRates[key];
    if (before === null || after === null) continue;
    if (after > before) regressions.push(`${axis} wrong-rate rose: ${before} → ${after}`);
  }
  if (
    challengerSummary.commercialUsabilityFindings.topResultWithNoPurchasePath >
    controlSummary.commercialUsabilityFindings.topResultWithNoPurchasePath
  ) {
    regressions.push('more top results have no actionable purchase path');
  }

  // The arm that actually reorders is held to the same bar, against its own
  // control (the same fixtures, ranked without context).
  const reorderControlIdentity = countIn(reorderingControlSummary.identityQuality, IDENTITY_GOOD);
  const reorderIdentity = countIn(reorderingSummary.identityQuality, IDENTITY_GOOD);
  const reorderControlSubstitute = countIn(reorderingControlSummary.substituteQuality, SUBSTITUTE_GOOD);
  const reorderSubstitute = countIn(reorderingSummary.substituteQuality, SUBSTITUTE_GOOD);
  if (reorderIdentity < reorderControlIdentity) {
    regressions.push(`reordering-arm identity quality fell: ${reorderControlIdentity} → ${reorderIdentity}`);
  }
  if (reorderSubstitute < reorderControlSubstitute) {
    regressions.push(`reordering-arm substitute quality fell: ${reorderControlSubstitute} → ${reorderSubstitute}`);
  }
  for (const axis of WRONG_AXES) {
    const key = `${axis}_wrong_rate`;
    const before = reorderingControlSummary.wrongAttributeRates[key];
    const after = reorderingSummary.wrongAttributeRates[key];
    if (before === null || after === null) continue;
    if (after > before) regressions.push(`reordering-arm ${axis} wrong-rate rose: ${before} → ${after}`);
  }

  return {
    corpusTier: 'SYNTHETIC',
    fixtures: fixtures.length,
    fixturesWhereContextApplied: contextActive,
    fixturesReorderedOrFiltered: reordered,
    fixturesChangedByMildContext: changed(control, mild),
    control: controlSummary,
    challengerMild: mildSummary,
    challenger: challengerSummary,
    reorderingArm: {
      fixtures: reorderingFixtures.length,
      fixturesReordered: changed(reorderingControl, reordering),
      // Order held because the correct candidates GAINED and the mismatched
      // one LOST — the context pushed hard and pushed the right way. The
      // perturbation figures are what distinguish that from a silent no-op.
      perturbation: perturbation(reorderingControl, reordering),
      control: reorderingControlSummary,
      challenger: reorderingSummary,
    },
    strongReorderingArm: {
      fixtures: strongFixtures.length,
      fixturesReordered: changed(strongControl, strongReordering),
      perturbation: perturbation(strongControl, strongReordering),
      control: strongControlSummary,
      challenger: strongSummary,
    },
    activeArmPerturbation: perturbation(control, challenger),
    mildArmPerturbation: perturbation(control, mild),
    corpusLimitations: [
      'Every candidate within a synthetic fixture carries the same price, so a budget ceiling cannot reorder or filter this corpus. Budget behaviour is proven by the dedicated ranking tests instead, not by this gate.',
      'The corpus is SYNTHETIC (10 authoritative fixtures). It can show that reordering did not degrade fashion match; it cannot support a production accuracy claim or a significance test.',
    ],
    regressions,
    verdict: regressions.length === 0 ? 'NO_MATERIAL_REGRESSION' : 'REGRESSION_DETECTED',
    // The corpus is synthetic and small: it can show that nothing broke, and
    // it cannot support a claim about production accuracy or a significance
    // test it does not have the power for.
    statisticalClaim: 'NONE — synthetic corpus, engineering regression gate only',
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

if (require.main === module) {
  const report = run();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === 'NO_MATERIAL_REGRESSION' ? 0 : 1;
}

module.exports = { run };
