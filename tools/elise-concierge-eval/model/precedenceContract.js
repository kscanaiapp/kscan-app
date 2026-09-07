'use strict';

/**
 * PRECEDENCE_CONTRACT_V1 — spec section 14. Fixed policy; not invented
 * dynamically per-scenario. Every evaluation baseline records
 * PRECEDENCE_CONTRACT_VERSION: V1.
 */

const PRECEDENCE_CONTRACT_VERSION = 'V1';

const LEVELS = Object.freeze({
  L0_SAFETY_SECURITY_FACT: 0,
  L1_CURRENT_TURN_INSTRUCTION: 1,
  L2_STANDING_HARD_CONSTRAINT: 2,
  L3_SIGNATURE_STYLE_SOFT_PREFERENCE: 3,
  L4_GENERIC_DEFAULT: 4,
});

const LEVEL_DESCRIPTIONS = Object.freeze({
  [LEVELS.L0_SAFETY_SECURITY_FACT]:
    'Safety/security/factual truth (Closet ownership, authenticated actor identity, entitlement facts, governed safety constraints, actual system capabilities). Cannot be overridden by personalization.',
  [LEVELS.L1_CURRENT_TURN_INSTRUCTION]:
    "Direct current-turn instruction. The user's explicit current request controls the response and may override a passive preference.",
  [LEVELS.L2_STANDING_HARD_CONSTRAINT]:
    'Standing explicit hard constraints/dislikes. Remain active unless the current turn directly and unambiguously overrides the conflicting constraint. An implied conflict preserves the hard constraint; an explicit override is a one-turn override, not a new permanent preference.',
  [LEVELS.L3_SIGNATURE_STYLE_SOFT_PREFERENCE]:
    'Signature Style / soft preferences. Personalize where compatible, yield to explicit current request.',
  [LEVELS.L4_GENERIC_DEFAULT]:
    'Generic fashion defaults. Used only when stronger context is absent.',
});

/**
 * Given a set of applicable levels for competing claims (e.g. a Level 2 hard
 * constraint and a Level 3 Signature Style preference that conflict), return
 * the level that should win. Lower numeric value = higher precedence.
 */
function higherPrecedence(levelA, levelB) {
  return levelA <= levelB ? levelA : levelB;
}

/**
 * Determine whether a current-turn instruction may override a standing hard
 * constraint (Level 2). Per contract: only an EXPLICIT, UNAMBIGUOUS override
 * in the current turn suffices; an implied conflict must preserve the
 * standing constraint. This is a ONE-TURN override, not a new standing
 * preference — callers must not persist it past the turn.
 *
 * @param {object} input
 * @param {boolean} input.currentTurnExplicitlyOverrides - true only when the
 *   scenario fixture marks the current message as an explicit, unambiguous
 *   override of the named constraint (never inferred from prose).
 */
function resolveHardConstraintOverride(input) {
  const explicit = Boolean(input && input.currentTurnExplicitlyOverrides);
  return {
    constraintRemainsActive: !explicit,
    overrideIsPermanent: false, // Level 2 overrides are never permanent by contract.
    winningLevel: explicit ? LEVELS.L1_CURRENT_TURN_INSTRUCTION : LEVELS.L2_STANDING_HARD_CONSTRAINT,
  };
}

module.exports = {
  PRECEDENCE_CONTRACT_VERSION,
  LEVELS,
  LEVEL_DESCRIPTIONS,
  higherPrecedence,
  resolveHardConstraintOverride,
};
