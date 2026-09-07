'use strict';

/**
 * CROSS-SYSTEM CONSISTENCY — spec sections 13/41.
 *
 * Real cross-system comparison requires two ACTUAL subject responses (one
 * from Elise, one from Concierge) for the same actor/turn. Since no
 * owner-captured transcripts exist for this dispatch, there are no real
 * subject responses to compare — spec section 41 requires recording
 * `CROSS_SYSTEM_FACT_CONTRADICTION: NOT TESTABLE — NO SUBJECT RESPONSES` for
 * that case and implementing the comparison LOGIC only.
 *
 * This module IS that comparison logic, and D13 (synthesis/defects) is used
 * ONLY to prove the logic itself works on a synthetic, known-answer PAIR —
 * never to claim Elise and Concierge actually disagree in production.
 */

const { extractClaims } = require('../extraction/claimExtractor');
const { CLAIM_TYPES } = require('../model/claimSchema');

/**
 * Compare two response texts (produced under the SAME scenario/evidence) for
 * contradictory factual claims about the same referent.
 *
 * @param {{ elise: string, concierge: string }} pair
 * @param {object} evidence
 * @returns {{ consistent: boolean, contradictions: object[] }}
 */
function compareCrossSystemFacts(pair, evidence) {
  const eliseClaims = extractClaims(pair.elise, evidence).claims;
  const conciergeClaims = extractClaims(pair.concierge, evidence).claims;

  const contradictions = [];
  const factTypes = new Set([CLAIM_TYPES.OWNERSHIP, CLAIM_TYPES.NON_OWNERSHIP]);

  // A cross-system contradiction is about what the TWO SYSTEMS ASSERTED
  // relative to EACH OTHER, not about whether either assertion happens to be
  // independently correct against fixture ground truth (that is what
  // supportStatus already measures, one layer down, per system). Comparing
  // supportStatus values here instead of raw claim TYPES was this module's
  // first design, and it silently passed the D13 fixture: an incorrect
  // OWNERSHIP claim and an incorrect (falsely-denying) NON_OWNERSHIP claim
  // about the SAME real, owned item both carry supportStatus CONTRADICTED --
  // which look "the same" if you compare statuses, even though the two
  // systems are flatly disagreeing with each other about the fact itself.
  for (const a of eliseClaims) {
    if (!factTypes.has(a.type)) continue;
    for (const b of conciergeClaims) {
      if (!factTypes.has(b.type)) continue;
      if (a.referent !== b.referent) continue;
      if (a.type !== b.type) {
        contradictions.push({
          referent: a.referent,
          eliseClaim: a,
          conciergeClaim: b,
          code: 'CROSS_SYSTEM_OWNERSHIP_CONTRADICTION',
        });
      }
    }
  }

  return { consistent: contradictions.length === 0, contradictions };
}

module.exports = { compareCrossSystemFacts };
