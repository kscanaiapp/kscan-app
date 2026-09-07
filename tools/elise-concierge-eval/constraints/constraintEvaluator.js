'use strict';

/**
 * CONSTRAINT ADHERENCE — spec section 37.
 *
 * Checks response text against the scenario's parsed hard/soft constraints
 * and the fixture ground truth (which specific items the constraint should
 * have excluded, and any commerce budget). This is intentionally SEPARATE
 * from claim extraction: a constraint violation is not "a false factual
 * claim", it is "a recommendation that should never have been offered".
 */

const { parseConstraints } = require('../synthesis/candidateSelector');
const { matchesReferent } = require('./textReferentMatch');

/**
 * @param {string} text
 * @param {object} evidence - { scenario, closet, commerceProduct }
 * @param {object} groundTruth - synthesizer groundTruth (excludedByConstraintIds etc.)
 * @returns {{ hardViolations: object[], softFlags: object[] }}
 */
function evaluateConstraints(text, evidence, groundTruth) {
  const constraints = parseConstraints([
    ...(evidence.scenario.hardConstraints || []),
    ...(evidence.scenario.softConstraints || []),
  ]);
  const hardViolations = [];
  const softFlags = [];

  for (const itemId of groundTruth.excludedByConstraintIds || []) {
    const item = evidence.closet.items.find((i) => i.id === itemId);
    if (item && matchesReferent(text, item)) {
      hardViolations.push({
        code: 'HARD_CONSTRAINT_VIOLATION',
        referent: itemId,
        detail: `Response mentions ${itemId}, which the scenario's hard constraints should have excluded.`,
      });
    }
  }

  if (constraints.underPrice != null && evidence.commerceProduct && evidence.commerceProduct.price > constraints.underPrice) {
    const mentioned =
      text.toLowerCase().includes(evidence.commerceProduct.title.toLowerCase()) ||
      text.toLowerCase().includes(String(evidence.commerceProduct.price.toFixed(2)));
    if (mentioned) {
      hardViolations.push({
        code: 'HARD_CONSTRAINT_VIOLATION',
        referent: evidence.commerceProduct.id,
        detail: `Response recommends ${evidence.commerceProduct.id} at $${evidence.commerceProduct.price}, over the stated budget of $${constraints.underPrice}.`,
      });
    }
  }

  if (constraints.exactlyNOptions != null) {
    // Best-effort: count distinct "option" framings the synthesizer would have produced.
    const optionMentions = (text.match(/\blook_\d+\b/gi) || []).length;
    if (optionMentions > 0 && optionMentions !== constraints.exactlyNOptions) {
      softFlags.push({
        code: 'OPTION_COUNT_MISMATCH',
        detail: `Requested exactly ${constraints.exactlyNOptions} options; response structure suggests ${optionMentions}.`,
      });
    }
  }

  return { hardViolations, softFlags };
}

module.exports = { evaluateConstraints };
