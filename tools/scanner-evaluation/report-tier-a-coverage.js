#!/usr/bin/env node
'use strict';

/**
 * Tier A stratum coverage and pilot-freeze eligibility.
 *
 * OBJECTIVE: a useful licensed-web-image PILOT benchmark that exposes actionable
 * scanner failures. NOT a comprehensive brand-recognition certification corpus.
 *
 * Brand evidence is graded into three tiers, and only the first is a positive
 * brand case:
 *
 *   product_level_evidence  legible logo, label or tag on the product, or an
 *                           authoritative object record tied to the product
 *   contextual_cue_only     store signage, branded background, nearby display,
 *                           or trade-dress resemblance with no legible mark
 *   no_reliable_evidence    no defensible brand signal at all
 *
 * The lower two tiers are NOT waste and are never discarded: they are the
 * measurement cohort for brand FALSE POSITIVES. A model that reads "adidas" off
 * a store wall and attributes it to the shoe is making the exact error those
 * cases exist to catch, so a useful corpus needs both cohorts populated.
 *
 * The positive brand count is therefore REPORTED, NOT GATED. Acquisition does not
 * continue merely to reach a brand quota. When the distinct-object support behind
 * the positive cases is small, positive brand recognition is reported as
 * EXPLORATORY and no comprehensive brand-accuracy claim may be made from it.
 *
 * Freeze gates are breadth gates: same-item coverage, garment-category coverage,
 * a populated false-positive cohort, and ambiguous / insufficient-evidence cases.
 *
 * A set counts only when it has >= 2 members whose shared object identity is
 * established by visual confirmation or an institutional object record. Crops,
 * masks, recompressions and alternate framings of one source image never count.
 */

const fs = require('fs');
const path = require('path');

const CURATION = path.join(
  __dirname, '..', '..', 'evals', 'scanner-accuracy', 'curation', 'tier-a-curation.v0.1.0.json'
);

/**
 * Freeze gates. `brandEvidenced` is deliberately ABSENT: the positive brand count
 * is reported, never gated. `minDistinctObjectsForConfirmatory` is the threshold
 * below which positive brand findings are labelled exploratory.
 */
const TARGETS = Object.freeze({
  sameItemSets: 10,
  distinctGarmentCategories: 5,
  contextualCueOnlyCases: 3,
  noReliableEvidenceCases: 5,
  ambiguousCases: 3,
  minDistinctObjectsForConfirmatory: 10,
});

/** Evidence kinds that place a case in the product_level_evidence tier. */
const VALID_BRAND_EVIDENCE = new Set([
  'legible_logo_on_product',
  'legible_label_or_tag',
  'packaging_text',
  'documented_museum_attribution',
]);

const BRAND_TIERS = Object.freeze({
  PRODUCT: 'product_level_evidence',
  CONTEXTUAL: 'contextual_cue_only',
  NONE: 'no_reliable_evidence',
});

/** Signals that a brand mark is present in frame but NOT on the product. */
const CONTEXTUAL_TAGS = new Set([
  'brand_signage_not_product_mark',
  'brand_like_motif_without_legible_mark',
  'brand_on_shelf_label_not_product',
  'branded_background',
]);

/**
 * Grade one case. An explicitly recorded `brandEvidenceTier` always wins so a
 * reviewer can override; otherwise the tier is derived from recorded evidence.
 * Derivation never promotes: absence of evidence yields the lowest tier.
 */
function brandTier(d) {
  if (d.brandEvidenceTier) return d.brandEvidenceTier;
  if (d.brandVisible === true && VALID_BRAND_EVIDENCE.has(d.brandEvidenceKind)) {
    return BRAND_TIERS.PRODUCT;
  }
  const tags = [...(d.sceneTags || []), ...(d.difficultyTags || [])];
  const contextual =
    tags.some((t) => CONTEXTUAL_TAGS.has(t)) ||
    d.trademarkReviewState === 'trademark_visible_on_signage' ||
    Boolean(d.brandEvidenceNote);
  return contextual ? BRAND_TIERS.CONTEXTUAL : BRAND_TIERS.NONE;
}

/**
 * The scoreable expectation for each tier. This is what makes the lower two tiers
 * measurements rather than filler.
 */
function expectedBrandOutcome(tier) {
  if (tier === BRAND_TIERS.PRODUCT) {
    return 'brand_may_be_named_and_is_scored_for_correctness';
  }
  if (tier === BRAND_TIERS.CONTEXTUAL) {
    return 'naming_the_in_frame_brand_as_the_product_brand_is_a_false_positive';
  }
  return 'any_brand_claim_is_a_false_positive';
}

function load() {
  return JSON.parse(fs.readFileSync(CURATION, 'utf8'));
}

function report() {
  const c = load();
  const decisions = Object.entries(c.decisions || {});
  const kept = decisions.filter(([, d]) => d.keep);

  // ── Brand evidence, graded into three tiers ──
  const graded = kept.map(([id, d]) => {
    const tier = brandTier(d);
    return { caseId: id, d, tier, expectedBrandOutcome: expectedBrandOutcome(tier) };
  });
  const byTier = (t) => graded.filter((g) => g.tier === t);
  const brandCases = byTier(BRAND_TIERS.PRODUCT);
  const contextualCases = byTier(BRAND_TIERS.CONTEXTUAL);
  const noEvidenceCases = byTier(BRAND_TIERS.NONE);

  // Per-case counting overstates brand diversity when several cases are views of
  // ONE physical object. The distinct-object count is what decides whether the
  // positive brand finding is confirmatory or merely exploratory, so it must
  // travel with every positive brand number.
  const brandObjects = new Set(brandCases.map((g) => g.d.sameItemSetId || g.caseId));
  const brandNames = new Set(brandCases.map((g) => g.d.brand));
  const exploratory = brandObjects.size < TARGETS.minDistinctObjectsForConfirmatory;

  // ── Same-item sets ──
  const sets = Object.entries(c.sameItemSets || {});
  const validSets = sets.filter(([, s]) => {
    const members = s.members || [];
    return s.trueMultiImage === true && s.identityConfirmed !== false && members.length >= 2;
  });
  const invalidSets = sets.filter(([id]) => !validSets.find(([vid]) => vid === id));

  // ── Other strata, reported not gated ──
  const tally = {};
  for (const [, d] of kept) {
    for (const t of [...(d.sceneTags || []), ...(d.difficultyTags || [])]) tally[t] = (tally[t] || 0) + 1;
  }

  const licence = {};
  for (const [, d] of kept) {
    const l = d.licenceId ? `${d.licenceId}${d.licenceVersion ? ` ${d.licenceVersion}` : ''}` : 'recorded_in_acquisition_report';
    licence[l] = (licence[l] || 0) + 1;
  }

  // ── Garment-category coverage ──
  const categories = {};
  for (const [, d] of kept) {
    const k = d.category || 'unknown';
    categories[k] = (categories[k] || 0) + 1;
  }
  // Case-insensitive: the corpus records non-fashion negatives as NON_FASHION, and
  // counting that as a garment category would inflate the coverage gate.
  const realCategories = Object.keys(categories).filter(
    (k) => !['unknown', 'non_fashion'].includes(k.toLowerCase())
  );

  // Ambiguous / insufficient-evidence cases: those where the correct behaviour is
  // to abstain or to return a partial answer rather than a confident label.
  const ambiguous = kept.filter(
    ([, d]) =>
      d.expectedAbstention === true ||
      d.expectedResultType === 'insufficient_evidence' ||
      (d.difficultyTags || []).some((t) =>
        ['occluded', 'motion_blur', 'low_light', 'distant_view', 'label_only_no_garment_silhouette',
          'brand_like_motif_without_legible_mark', 'many_items_in_frame'].includes(t)
      )
  );

  // ── Freeze gates: breadth, not brand quota ──
  const gates = {
    sameItemSets: { have: validSets.length, need: TARGETS.sameItemSets },
    distinctGarmentCategories: { have: realCategories.length, need: TARGETS.distinctGarmentCategories },
    contextualCueOnlyCases: { have: contextualCases.length, need: TARGETS.contextualCueOnlyCases },
    noReliableEvidenceCases: { have: noEvidenceCases.length, need: TARGETS.noReliableEvidenceCases },
    ambiguousCases: { have: ambiguous.length, need: TARGETS.ambiguousCases },
  };
  for (const g of Object.values(gates)) g.met = g.have >= g.need;
  const unmet = Object.entries(gates).filter(([, g]) => !g.met);

  return {
    benchmarkKind: 'LICENSED-WEB-IMAGE PILOT BENCHMARK',
    notARealWorldSmartGlassesBenchmark: true,
    notAComprehensiveBrandAccuracyCorpus: true,
    curated: decisions.length,
    kept: kept.length,
    rejected: decisions.length - kept.length,

    freezeGates: gates,

    // Reported, never gated.
    brandEvidence: {
      positive: {
        cases: brandCases.length,
        distinctObjects: brandObjects.size,
        distinctBrands: [...brandNames].sort(),
        support: exploratory ? 'EXPLORATORY' : 'confirmatory',
        interpretation: exploratory
          ? `Positive brand recognition is EXPLORATORY only: ${brandCases.length} cases rest on just ${brandObjects.size} distinct physical objects and ${brandNames.size} brands. Report directional signal, never a brand-accuracy rate.`
          : 'Distinct-object support is sufficient to report a brand-accuracy rate for the brands present.',
        cases_detail: brandCases.map((g) => ({
          caseId: g.caseId, brand: g.d.brand, evidence: g.d.brandEvidenceKind,
          evidenceSource: g.d.brandEvidenceSource || null, sameItemSetId: g.d.sameItemSetId || null,
        })),
      },
      // The false-positive measurement cohorts. Reported SEPARATELY, never merged.
      falsePositiveCohorts: {
        contextual_cue_only: {
          cases: contextualCases.length,
          expectedBrandOutcome: expectedBrandOutcome(BRAND_TIERS.CONTEXTUAL),
          measures: 'brand attributed to the product from environment-level branding: store signage, shelf labels, branded backgrounds, or trade-dress resemblance with no legible mark',
          cases_detail: contextualCases.map((g) => ({
            caseId: g.caseId, why: g.d.brandEvidenceNote || g.d.note || null,
          })),
        },
        no_reliable_evidence: {
          cases: noEvidenceCases.length,
          expectedBrandOutcome: expectedBrandOutcome(BRAND_TIERS.NONE),
          measures: 'brand invented with no defensible visual signal at all',
          caseIds: noEvidenceCases.map((g) => g.caseId),
        },
      },
    },

    validSets: validSets.map(([id, s]) => ({ setId: id, members: s.members.length, identityEvidence: s.identityEvidence || null })),
    invalidSets: invalidSets.map(([id, s]) => ({ setId: id, reason: s.setNote || 'fewer than 2 confirmed members' })),
    categoryCoverage: categories,
    ambiguousCaseIds: ambiguous.map(([id]) => id),
    otherStrata: tally,
    licenceBreakdown: licence,

    pilotFreezeEligible: unmet.length === 0,
    freezeVerdict:
      unmet.length === 0
        ? 'BREADTH GATES MET — eligible for pilot freeze as a LICENSED-WEB-IMAGE PILOT BENCHMARK. The positive brand count is NOT a gate and is reported with its support level.'
        : `NOT eligible: ${unmet.map(([k, g]) => `${k} ${g.have}/${g.need}`).join('; ')}`,
  };
}

if (require.main === module) {
  const r = report();
  console.log(JSON.stringify(r, null, 2));
  if (!r.pilotFreezeEligible) process.exitCode = 1;
}

module.exports = { report, TARGETS, VALID_BRAND_EVIDENCE, BRAND_TIERS, brandTier, expectedBrandOutcome };
