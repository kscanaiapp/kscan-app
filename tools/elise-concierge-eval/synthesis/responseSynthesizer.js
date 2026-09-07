'use strict';

/**
 * RESPONSE SYNTHESIZER — spec sections 16/17.
 *
 * V1 does not hand-author recommendation responses. This module builds a
 * deterministic, versioned response from (scenario, systemProfile,
 * defectScript, seed), producing response text, an expected verdict, and an
 * injected-defect manifest. Nothing here is a reimplementation of production
 * ranking/prompt logic (see synthesis/candidateSelector.js docstring) — it
 * exists solely to give the independent extractor/evaluator a corpus with
 * KNOWN answers to grade itself against.
 *
 * SYNTHESIZER_VERSION participates in the corpus hash (baseline/baseline.js).
 * Bump it whenever template text, phrasing pools, or candidate-selection
 * logic changes in a way that could shift generated text.
 */

const { SeededRandom } = require('../model/seededRandom');
const { parseConstraints, selectCandidates, roleAbsent } = require('./candidateSelector');
const { itemLabel, explanationSentence } = require('./phrasing');
const { INJECTORS } = require('../defects/defectInjectors');

const SYNTHESIZER_VERSION = 'SYNTHESIZER_V1';

const SYSTEM_PROFILES = Object.freeze(['ELISE', 'CONCIERGE']);

function buildContext({ scenario, fixtures, systemProfile, seedSuffix }) {
  const closet = fixtures.closetsById[scenario.closetId];
  const signatureStyle = fixtures.signatureStylesById[scenario.signatureStyleId];
  if (!closet) throw new Error(`Scenario ${scenario.id} references unknown closetId ${scenario.closetId}`);
  if (!signatureStyle) {
    throw new Error(`Scenario ${scenario.id} references unknown signatureStyleId ${scenario.signatureStyleId}`);
  }
  const constraints = parseConstraints([...(scenario.hardConstraints || []), ...(scenario.softConstraints || [])]);
  const entitlement = { kPlusActive: scenario.kPlusActive, conciergeV1: scenario.conciergeV1 };
  // Entitlement fidelity for the SYNTHESIZER itself, not just the evaluator:
  // per authority/entitlementMap.json, RLS makes a non-K+ actor's Closet rows
  // invisible to the real pipeline, so a well-behaved (CLEAN) response for
  // such an actor can never be grounded in Closet contents. Selecting real
  // candidates here for a kPlusActive:false scenario would make even the
  // CLEAN baseline violate entitlement facts -- caught by this lane's own
  // evaluator during corpus validation and fixed here at the source rather
  // than papered over downstream.
  const { anchor, shortlist, excludedByConstraint } = entitlement.kPlusActive
    ? selectCandidates(closet, constraints)
    : { anchor: null, shortlist: [], excludedByConstraint: [] };
  const commerceProduct = scenario.commerceProductId ? fixtures.commerceProductsById[scenario.commerceProductId] : null;
  const rng = new SeededRandom(`${scenario.id}:${systemProfile}:${seedSuffix}`);
  return {
    scenario,
    closet,
    signatureStyle,
    constraints,
    anchor,
    shortlist,
    excludedByConstraint,
    commerceProduct,
    commerceCatalog: fixtures.commerceCatalog,
    rng,
    systemProfile,
    entitlement,
  };
}

function groundTruthOf(context) {
  return {
    closetId: context.closet.id,
    signatureStyleId: context.signatureStyle.id,
    anchorItemId: context.anchor ? context.anchor.id : null,
    shortlistItemIds: context.shortlist.map((i) => i.id),
    excludedByConstraintIds: context.excludedByConstraint.map((i) => i.id),
    commerceProductId: context.commerceProduct ? context.commerceProduct.id : null,
    kPlusActive: context.entitlement.kPlusActive,
    conciergeV1: context.entitlement.conciergeV1,
  };
}

function conciergeTag(context, item) {
  if (context.systemProfile !== 'CONCIERGE') return '';
  return item.__fromCatalog ? ' (shopping suggestion)' : ' (from your Closet)';
}

/** Deterministic, grounded scaffold response — the CLEAN baseline. */
function buildCleanText(context, scaffoldOptions = {}) {
  const rng = context.rng;
  const lines = [];
  const lead = context.anchor || context.shortlist[0] || null;

  if (lead) {
    const label = itemLabel(rng, lead);
    lines.push(`I'd build this around your ${label}${conciergeTag(context, lead)}.`);
  } else {
    lines.push('Here is a simple, versatile option to start with.');
  }

  const rest = context.shortlist.filter((i) => !lead || i.id !== lead.id).slice(0, 2);
  for (const item of rest) {
    const anchorLabel = lead ? itemLabel(rng, lead) : 'the rest of the look';
    lines.push(explanationSentence(rng, itemLabel(rng, item) + conciergeTag(context, item), anchorLabel));
  }

  if (context.scenario.taskId === 'wardrobe_gap' && context.entitlement.kPlusActive) {
    if (roleAbsent(context.closet, 'shoe') && context.closet.items.length > 0) {
      lines.push(
        "Based on everything currently in your closet, you don't have any shoes yet, so that's the one gap I'd fill next.",
      );
    }
  }

  if (context.scenario.expectAbstentionEligible) {
    lines.push(
      "I don't have much closet evidence to go on here, so this is general advice rather than something tailored to specific pieces you own.",
    );
  }

  if (!context.entitlement.kPlusActive) {
    // No Closet-grounded advice is possible for a non-entitled actor (see the
    // entitlement guard in buildContext above); say so honestly rather than
    // giving generic advice framed as if it were Closet-aware.
    lines.push("I don't have access to closet-specific details here, so this is general styling advice.");
  }

  if (!scaffoldOptions.suppressSoftAck && context.scenario.softConstraints && context.scenario.softConstraints.length) {
    // A well-behaved (non-defective) response ACKNOWLEDGES a stated soft
    // preference rather than silently ignoring it -- see spec section 37/D06
    // and the bounded SOFT_CONSTRAINT_IGNORED proxy in
    // grounding/groundingEvaluator.js, which this sentence is designed to
    // satisfy for the CLEAN negative control.
    lines.push(
      `Keeping in mind your preference for ${context.scenario.softConstraints[0]}, this should still feel like you.`,
    );
  }

  if (!lines.length) lines.push('Here is a versatile, easy option for today.');
  return lines.join(' ');
}

function tieGroups(closet) {
  const groups = new Map();
  for (const item of closet.items) {
    const key = item.subcategory || item.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

function buildAmbiguityResult(context) {
  const groups = tieGroups(context.closet);
  if (!groups.length) {
    return { applicable: false, reason: 'no tied (same-subcategory) items exist in this closet fixture' };
  }
  const group = groups[0];
  const category = group[0].subcategory || group[0].category;
  const text =
    `You actually have a couple of ${category} options that would both work here, so I don't want to pick just one for you -- ` +
    `could you tell me which one you meant, or would you like me to build around the pair as a group?`;
  return { applicable: true, text, tieGroupIds: group.map((i) => i.id), category };
}

/**
 * @param {object} input
 * @param {string} input.scenarioId
 * @param {'ELISE'|'CONCIERGE'} input.systemProfile
 * @param {string} input.script - 'CLEAN' | 'AMBIGUITY' | 'D01'..'D16'
 * @param {object} input.fixtures - result of fixtures/index.js getFixtures()
 * @param {string|number} [input.seed] - extra seed material; defaults to script id
 */
function synthesizeResponse(input) {
  const { scenarioId, systemProfile, script, fixtures } = input;
  const seed = input.seed !== undefined ? input.seed : script;
  const scenario = fixtures.scenariosById[scenarioId];
  if (!scenario) throw new Error(`Unknown scenarioId: ${scenarioId}`);
  if (!SYSTEM_PROFILES.includes(systemProfile)) throw new Error(`Invalid systemProfile: ${systemProfile}`);

  const context = buildContext({ scenario, fixtures, systemProfile, seedSuffix: seed });
  const base = {
    synthesizerVersion: SYNTHESIZER_VERSION,
    scenarioId,
    systemProfile,
    script,
    taskId: scenario.taskId,
    closetId: scenario.closetId,
    signatureStyleId: scenario.signatureStyleId,
    groundTruth: groundTruthOf(context),
  };

  // A non-K+ actor's Closet is architecturally invisible (see buildContext
  // above and authority/entitlementMap.json). Planting a Closet-grounded
  // defect (D01/D03/D08/D09/D13, etc.) on top of that condition conflates two
  // different failure classes: the response ALWAYS also carries an
  // entitlement violation, which correctly outranks the other defect in the
  // evaluator's verdict priority (spec section 20's suppression discipline
  // applies here too -- an ambiguous compound case would mislabel a correct
  // FAIL_ENTITLEMENT result as a wrong answer for D01/D03/etc). D15 is the
  // dedicated entitlement-fact defect for this condition; every other script
  // is marked not applicable for a non-K+ scenario rather than manufacturing
  // a degenerate double-defect case.
  if (!context.entitlement.kPlusActive && !['CLEAN', 'AMBIGUITY', 'D15'].includes(script)) {
    return {
      ...base,
      applicable: false,
      reason: 'Non-K+ actor: Closet-fact defects are not independently testable here (see D15 instead) -- any such defect collides with the always-dominant entitlement violation.',
    };
  }

  if (script === 'CLEAN') {
    return {
      ...base,
      applicable: true,
      text: buildCleanText(context),
      expectedVerdicts: [{ verdict: 'PASS', note: 'no planted defect' }],
      injectedDefectManifest: null,
    };
  }

  if (script === 'AMBIGUITY') {
    const result = buildAmbiguityResult(context);
    if (!result.applicable) return { ...base, applicable: false, reason: result.reason };
    return {
      ...base,
      applicable: true,
      text: result.text,
      expectedVerdicts: [{ verdict: 'UNDECIDABLE', referent: result.tieGroupIds, category: result.category }],
      injectedDefectManifest: { script: 'AMBIGUITY', tieGroupIds: result.tieGroupIds },
    };
  }

  const injector = INJECTORS[script];
  if (!injector) throw new Error(`Unknown synthesis script: ${script}`);

  const result = injector(context);
  if (!result.applicable) return { ...base, applicable: false, reason: result.reason };

  if (result.pair) {
    return {
      ...base,
      applicable: true,
      pair: result.pair,
      expectedVerdicts: [{ verdict: result.expectedVerdict, severity: result.severity, referent: result.plantedClaim.referent }],
      injectedDefectManifest: { defectCode: script, plantedClaim: result.plantedClaim },
    };
  }

  // D14 MISSING_ABSTENTION is a REPLACEMENT, not an addendum: its entire
  // point is a response that never says "I don't have enough information".
  // Prepending the normal clean scaffold would reintroduce the abstention
  // sentence that scaffold includes for an abstention-eligible scenario,
  // silently curing the very defect being planted. Every other defect script
  // plants one bad claim inside an otherwise-normal answer, which IS
  // realistic (spec section 18), so they keep the clean prefix.
  const text =
    script === 'D14'
      ? result.text
      : `${buildCleanText(context, { suppressSoftAck: script === 'D06' })} ${result.text}`;
  return {
    ...base,
    applicable: true,
    text,
    expectedVerdicts: [{ verdict: result.expectedVerdict, severity: result.severity, referent: result.plantedClaim.referent }],
    injectedDefectManifest: { defectCode: script, plantedClaim: result.plantedClaim },
  };
}

module.exports = {
  SYNTHESIZER_VERSION,
  SYSTEM_PROFILES,
  synthesizeResponse,
  buildContext,
  buildCleanText,
  buildAmbiguityResult,
};
