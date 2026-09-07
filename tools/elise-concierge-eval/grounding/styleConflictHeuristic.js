'use strict';

/**
 * D07 STYLE_CONFLICT is a RUBRIC-class defect in the taxonomy (arbitrary
 * outfit coherence genuinely needs human judgment). This module is a
 * BOUNDED, DETERMINISTIC PROXY that only recognizes the specific,
 * fixed-vocabulary conflict phrasing this harness's own synthesizer plants
 * (see defects/defectInjectors.js CONFLICTING_COMPANION pool). It exists to
 * prove the instrument's rubric-dimension PLUMBING works end-to-end on a
 * controlled corpus — it is NOT a general outfit-coherence classifier, and
 * must never be reported as one. Real style-conflict judgment stays a human
 * review dimension (spec section 15, Class C / Class B).
 */

const CONFLICT_PHRASES = ['athletic shorts and flip-flops', 'a black-tie tuxedo'];

function detectStyleConflict(text) {
  const lower = String(text).toLowerCase();
  const hit = CONFLICT_PHRASES.find((phrase) => lower.includes(phrase));
  if (!hit) return null;
  return {
    code: 'STYLE_CONFLICT_PROXY_MATCH',
    detail: `Text pairs an owned item with a fixed extreme-formality-conflict phrase ("${hit}") from the bounded proxy vocabulary.`,
    isBoundedProxy: true,
  };
}

module.exports = { detectStyleConflict, CONFLICT_PHRASES };
