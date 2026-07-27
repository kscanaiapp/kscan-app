/**
 * Deterministic provider fixtures for Phase 2B.1 backend activation tests.
 *
 * These are FIXED payloads, not a simulated model. Nothing here reaches Gemini,
 * Llama, a retailer API, or any production service — the whole point is that a
 * backend contract test must be reproducible offline and must never spend a
 * real provider call.
 *
 * Payload shape matches what `scan-identify` produces AFTER its existing
 * `sanitizeIdentification` / `sanitizeAttributes` stage, because that is the
 * boundary the canonical normalizer consumes.
 *
 * This file lives under `__tests__/fixtures/` which the runner excludes from
 * test discovery, so it is imported, never executed as a suite.
 */

'use strict';

/** A provider outcome the transport/parse layer decides, not the model. */
const TRANSPORT_OUTCOMES = {
  MALFORMED_JSON: 'malformed_json',
  EXCEPTION: 'exception',
  TIMEOUT: 'timeout',
};

const FIXTURES = {
  /** Full identification: category, subtype, colour, material, construction. */
  complete_fashion: {
    outcome: 'classified',
    identification: {
      item_type: 'outerwear',
      subtype: 'chore jacket',
      primary_color: 'tan',
      secondary_colors: ['ecru'],
      material_estimate: 'cotton canvas',
      silhouette: 'boxy',
      pattern: 'solid',
      fit: 'relaxed',
      length: 'hip',
      sleeve_length: 'long',
      neckline_or_lapel: 'camp collar',
      closure: 'button',
      distinctive_features: ['patch pockets', 'contrast stitching'],
      style_tags: ['workwear', 'casual'],
      occasion_tags: ['everyday'],
      visual_observation: 'A tan cotton chore jacket with patch pockets.',
      confidence_score: 0.78,
    },
    attributes: {
      category: 'outerwear',
      itemType: 'chore jacket',
      colorPalette: ['tan', 'ecru'],
      materialEstimate: 'cotton canvas',
      silhouette: 'boxy',
      pattern: 'solid',
      styleTags: ['workwear', 'casual'],
      confidenceScore: 0.78,
    },
  },

  /** Subtype known, brand unknown — must stay a useful result. */
  subtype_partial: {
    outcome: 'classified',
    identification: {
      item_type: 'outerwear',
      subtype: 'chore jacket',
      primary_color: 'tan',
      brand_guess: null,
      confidence_score: 0.71,
    },
    attributes: { category: 'outerwear', confidenceScore: 0.71 },
  },

  /** Category only — partial, not a failure. */
  category_only: {
    outcome: 'classified',
    identification: { item_type: 'footwear', confidence_score: 0.44 },
    attributes: { category: 'footwear', confidenceScore: 0.44 },
  },

  /**
   * Visually branded. Uses a placeholder brand deliberately: this proves a
   * SUPPLIED brand survives every layer, not that any real brand is recognised.
   */
  visually_branded: {
    outcome: 'classified',
    identification: {
      item_type: 'footwear',
      subtype: 'low-top sneaker',
      brand_guess: 'ExampleBrand',
      visible_brand_text: null,
      logo_detected: true,
      primary_color: 'grey',
      confidence_score: 0.83,
    },
    attributes: { category: 'footwear', colorPalette: ['grey'], confidenceScore: 0.83 },
  },

  non_fashion: {
    outcome: 'non_fashion',
    identification: { non_fashion: true },
    attributes: {},
  },

  insufficient_visual_evidence: {
    outcome: 'insufficient_visual_evidence',
    identification: { scan_quality_note: 'Image too dark to identify a garment.' },
    attributes: {},
  },

  multiple_items: {
    outcome: 'multiple_items_need_selection',
    identification: { item_type: 'outfit' },
    attributes: { category: 'outfit' },
    candidates: [
      { candidateId: 'cand-1', category: 'top', subtype: 'oxford shirt' },
      { candidateId: 'cand-2', category: 'bottom', subtype: 'chino trouser' },
    ],
  },

  selected_item: {
    outcome: 'classified',
    identification: {
      item_type: 'top',
      subtype: 'oxford shirt',
      primary_color: 'blue',
      material_estimate: 'cotton',
      confidence_score: 0.69,
    },
    attributes: { category: 'top', colorPalette: ['blue'], confidenceScore: 0.69 },
  },

  /** Transport-layer failures. All must surface as technical_failure. */
  malformed_provider_json: {
    outcome: 'technical_failure',
    transportOutcome: TRANSPORT_OUTCOMES.MALFORMED_JSON,
    identification: {},
    attributes: {},
    unknownReason: 'malformed_provider_response',
  },

  provider_exception: {
    outcome: 'technical_failure',
    transportOutcome: TRANSPORT_OUTCOMES.EXCEPTION,
    identification: {},
    attributes: {},
    unknownReason: 'provider_error',
  },

  provider_timeout: {
    outcome: 'technical_failure',
    transportOutcome: TRANSPORT_OUTCOMES.TIMEOUT,
    identification: {},
    attributes: {},
    unknownReason: 'provider_timeout',
  },
};

/**
 * Returns a deep copy so a test that mutates a fixture cannot leak into the
 * next test through shared object identity.
 */
function getProviderFixture(name) {
  const fixture = FIXTURES[name];
  if (!fixture) {
    throw new Error(`Unknown provider fixture: ${name}`);
  }
  return JSON.parse(JSON.stringify(fixture));
}

function listProviderFixtures() {
  return Object.keys(FIXTURES).sort();
}

/**
 * Builds the normalizer input for a fixture.
 *
 * Test-only. Production code must never select behaviour from a request key or
 * an evidence id, which is why this mapping lives here and not in the function.
 */
function toNormalizationInput(name, { requestId, evidenceIds }) {
  const fixture = getProviderFixture(name);
  return {
    requestId,
    evidenceIds,
    outcome: fixture.outcome,
    identification: fixture.identification,
    attributes: fixture.attributes,
    ...(fixture.unknownReason ? { unknownReason: fixture.unknownReason } : {}),
    ...(fixture.candidates
      ? {
        candidates: fixture.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          evidenceId: evidenceIds[0],
          category: candidate.category,
          subtype: candidate.subtype,
        })),
      }
      : {}),
  };
}

module.exports = {
  TRANSPORT_OUTCOMES,
  getProviderFixture,
  listProviderFixtures,
  toNormalizationInput,
};
