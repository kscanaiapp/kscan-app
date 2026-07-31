'use strict';

/**
 * Deterministic mock provider for adapter validation (Phase 0D Lane C §6).
 *
 * Makes ZERO external calls. Every envelope below reproduces the shape the
 * certified v140 parser actually consumes — the `identification` / `attributes`
 * object the model is prompted to return — so the production parser is
 * exercised rather than bypassed. Key names were taken from the certified
 * source at `cert/ios-phase-2b4-cross-path-v2` (`f5f4ed2`).
 *
 * THIS IS NOT ACCURACY EVIDENCE. It validates adapter mechanics: routing,
 * parsing, normalization, failure mapping and the zero-side-effect invariants.
 * All content is synthetic. No private image and no live provider response is
 * ever used as a snapshot.
 */

const SCENARIOS = Object.freeze({
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  INSUFFICIENT_EVIDENCE: 'insufficient_visual_evidence',
  NON_FASHION: 'non_fashion',
  MULTI_ITEM: 'multiple_items_need_selection',
  TECHNICAL_FAILURE: 'technical_failure',
  MALFORMED_ENVELOPE: 'malformed_envelope',
  SCHEMA_FAILURE: 'schema_failure',
  FALLBACK_SUCCESS: 'primary_fails_fallback_succeeds',
  BOTH_FAIL: 'primary_and_fallback_fail',
});

/** A fully populated identification, as the prompt asks the model to return. */
function completedEnvelope() {
  return {
    identification: {
      item_type: 'footwear',
      subtype: 'low_top_sneaker',
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      primary_color: 'red',
      secondary_colors: ['white'],
      material_estimate: 'canvas',
      silhouette: 'low profile',
      pattern: 'solid',
      fit: null,
      length: null,
      sleeve_length: null,
      neckline_or_lapel: null,
      collar: null,
      closure: 'lace-up',
      pockets: [],
      style_tags: ['casual'],
      occasion_tags: ['everyday'],
      distinctive_features: ['contrast midsole'],
      visual_observation: 'A red low-top lace-up sneaker with a white midsole.',
      confidence_score: 0.82,
      scan_quality_note: null,
      status: 'completed',
    },
    attributes: {
      category: 'footwear',
      colorPalette: ['red', 'white'],
      materialEstimate: 'canvas',
      silhouette: 'low profile',
      pattern: 'solid',
      styleTags: ['casual'],
      occasion: ['everyday'],
      confidenceScore: 0.82,
    },
  };
}

/** Category only — the certified classifier maps this to `partial`. */
function partialEnvelope() {
  const base = completedEnvelope();
  base.identification.subtype = null;
  base.identification.confidence_score = 0.44;
  base.identification.visual_observation = 'Footwear of an indeterminate style.';
  base.attributes.confidenceScore = 0.44;
  return base;
}

function insufficientEvidenceEnvelope() {
  return {
    identification: {
      item_type: null,
      subtype: null,
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      primary_color: null,
      secondary_colors: [],
      material_estimate: null,
      silhouette: null,
      pattern: null,
      pockets: [],
      style_tags: [],
      occasion_tags: [],
      distinctive_features: [],
      visual_observation: null,
      confidence_score: 0.08,
      scan_quality_note: 'Image is too dark and blurred to identify a garment.',
      status: 'insufficient_visual_evidence',
    },
    attributes: {},
  };
}

function nonFashionEnvelope() {
  return {
    identification: {
      item_type: null,
      subtype: null,
      non_fashion: true,
      brand_guess: null,
      visible_brand_text: null,
      logo_detected: false,
      primary_color: null,
      secondary_colors: [],
      pockets: [],
      style_tags: [],
      occasion_tags: [],
      distinctive_features: [],
      visual_observation: 'A ceramic mug on a table. No garment is present.',
      confidence_score: 0.91,
      scan_quality_note: null,
      status: 'non_fashion',
    },
    attributes: {},
  };
}

/** Detection response: several garments, none selected yet. */
function multiItemEnvelope() {
  return {
    identification: {
      item_type: null,
      subtype: null,
      pockets: [],
      style_tags: [],
      occasion_tags: [],
      distinctive_features: [],
      visual_observation: 'Multiple distinct garments are present.',
      confidence_score: 0.7,
      status: 'multiple_items_need_selection',
    },
    attributes: {},
    candidates: [
      { label: 'bag', category: 'bag', bounds: { x: 0.08, y: 0.2, width: 0.4, height: 0.5 } },
      { label: 'sunglasses', category: 'accessory', bounds: { x: 0.55, y: 0.28, width: 0.3, height: 0.16 } },
    ],
  };
}

/** Not JSON at all — the parser must map this to a bounded failure. */
function malformedEnvelope() {
  return '```\nI could not analyse that image. Sorry!\n```';
}

/** Valid JSON, wrong shape — every expected key is absent. */
function schemaFailureEnvelope() {
  return { result: 'ok', data: { thing: 'a shoe, maybe' }, confidence: 'high' };
}

const ENVELOPES = Object.freeze({
  [SCENARIOS.COMPLETED]: completedEnvelope,
  [SCENARIOS.PARTIAL]: partialEnvelope,
  [SCENARIOS.INSUFFICIENT_EVIDENCE]: insufficientEvidenceEnvelope,
  [SCENARIOS.NON_FASHION]: nonFashionEnvelope,
  [SCENARIOS.MULTI_ITEM]: multiItemEnvelope,
  [SCENARIOS.SCHEMA_FAILURE]: schemaFailureEnvelope,
});

class ProviderError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

/**
 * Build a deterministic mock provider.
 *
 * Records every invocation so the adapter's routing and fallback behaviour can
 * be asserted exactly. Same scenario in, same bytes out — no clock, no
 * randomness.
 *
 * @param {string} scenario one of SCENARIOS
 */
function createMockProvider(scenario) {
  const calls = [];

  function invoke({ model, prompt, imageCount, attempt }) {
    calls.push({ model, promptLength: prompt ? prompt.length : 0, imageCount, attempt });

    if (scenario === SCENARIOS.TECHNICAL_FAILURE) {
      throw new ProviderError('provider returned 500', 'provider_error');
    }
    if (scenario === SCENARIOS.BOTH_FAIL) {
      throw new ProviderError(`provider unavailable (${model})`, 'provider_error');
    }
    if (scenario === SCENARIOS.FALLBACK_SUCCESS) {
      // The first call — the primary model — fails; the fallback succeeds.
      if (calls.length === 1) throw new ProviderError('primary model timed out', 'timeout');
      return { raw: JSON.stringify(completedEnvelope()), model };
    }
    if (scenario === SCENARIOS.MALFORMED_ENVELOPE) {
      return { raw: malformedEnvelope(), model };
    }

    const build = ENVELOPES[scenario];
    if (!build) throw new Error(`unknown mock scenario: ${scenario}`);
    return { raw: JSON.stringify(build()), model };
  }

  return {
    scenario,
    invoke,
    calls,
    callCount: () => calls.length,
    modelsUsed: () => calls.map((c) => c.model),
  };
}

module.exports = {
  SCENARIOS,
  ENVELOPES,
  ProviderError,
  createMockProvider,
  completedEnvelope,
  partialEnvelope,
  insufficientEvidenceEnvelope,
  nonFashionEnvelope,
  multiItemEnvelope,
  malformedEnvelope,
  schemaFailureEnvelope,
};
