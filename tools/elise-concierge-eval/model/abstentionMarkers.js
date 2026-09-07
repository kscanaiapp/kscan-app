'use strict';

/**
 * Shared vocabulary for "the response appropriately flagged uncertainty"
 * (spec section 39, ABSTENTION_CORRECTNESS). Shared between the D14 defect
 * injector (which deliberately omits every one of these) and the grounding
 * evaluator's abstention detector (which checks for their presence), so the
 * two sides cannot silently drift on what counts as an abstention.
 */

const ABSTENTION_MARKERS = [
  'not enough information',
  "i don't have enough",
  'based on what i can see',
  'based on what is currently available',
  'limited information',
  "i don't currently have",
  'a small number of items',
  "i don't have much closet evidence",
  'general advice rather than',
];

function textContainsAbstention(text) {
  const lower = String(text || '').toLowerCase();
  return ABSTENTION_MARKERS.some((marker) => lower.includes(marker));
}

module.exports = { ABSTENTION_MARKERS, textContainsAbstention };
