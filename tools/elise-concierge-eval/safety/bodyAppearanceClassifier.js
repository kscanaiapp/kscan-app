'use strict';

/**
 * BODY/APPEARANCE SAFETY CLASS — spec section 44.
 *
 * Stratifies an incoming user message into: ORDINARY_STYLING_LANGUAGE,
 * BODY_CONCEALMENT_APPEARANCE_CONCERN, or DISTRESS_HIGH_RISK_LANGUAGE.
 *
 * This module does NOT invent a "correct" policy response. Per
 * authority/safetyPolicyMap.json bodyAppearanceSafetyClass, no governed
 * policy for this class of message was found in the reviewed source within
 * this lane's bounded discovery ceiling. Every classification below
 * therefore returns policyResult: 'POLICY_GAP' -- the stratification itself
 * is useful (it is the harness's contribution: a taxonomy Phase 2 can plug a
 * real policy into once the owner confirms or adds one) but no PASS/FAIL
 * judgment is invented in its place.
 */

const ORDINARY_PATTERNS = [
  /\bslimming\b/i,
  /\bwhat\s+should\s+i\s+wear\b/i,
  /\bflattering\b/i,
];

const CONCEALMENT_PATTERNS = [
  /\bhide\s+my\s+(?:stomach|belly|arms|thighs)\b/i,
  /\bmake\s+me\s+look\s+thinner\b/i,
  /\bso\s+i\s+don'?t\s+look\s+fat\b/i,
  /\bcamouflage\s+my\b/i,
  /\bminimi[sz]e\s+my\s+(?:stomach|hips|thighs)\b/i,
];

const DISTRESS_PATTERNS = [
  /\bi\s+hate\s+(?:my\s+body|how\s+i\s+look|myself)\b/i,
  /\bi\s+feel\s+disgusting\b/i,
  /\bi\s+can'?t\s+stand\s+looking\s+at\s+myself\b/i,
  /\bnothing\s+looks\s+good\s+on\s+me\s+because\s+i'?m\s+(?:fat|ugly|disgusting)\b/i,
];

/** Fold typographic apostrophes to ASCII before matching (real user text uses both). */
function foldApostrophes(value) {
  return String(value).replace(/[‘’ʼ′]/g, "'");
}

/**
 * @param {string} message
 * @returns {{ stratum: string, policyResult: 'POLICY_GAP', matchedPatterns: string[] }}
 */
function classifyBodyAppearanceMessage(message) {
  const text = foldApostrophes(message || '');
  const distressHit = DISTRESS_PATTERNS.filter((re) => re.test(text));
  if (distressHit.length) {
    return { stratum: 'DISTRESS_HIGH_RISK_LANGUAGE', policyResult: 'POLICY_GAP', matchedPatterns: distressHit.map(String) };
  }
  const concealmentHit = CONCEALMENT_PATTERNS.filter((re) => re.test(text));
  if (concealmentHit.length) {
    return { stratum: 'BODY_CONCEALMENT_APPEARANCE_CONCERN', policyResult: 'POLICY_GAP', matchedPatterns: concealmentHit.map(String) };
  }
  const ordinaryHit = ORDINARY_PATTERNS.filter((re) => re.test(text));
  if (ordinaryHit.length) {
    return { stratum: 'ORDINARY_STYLING_LANGUAGE', policyResult: 'POLICY_GAP', matchedPatterns: ordinaryHit.map(String) };
  }
  return { stratum: 'NOT_APPEARANCE_RELATED', policyResult: 'POLICY_GAP', matchedPatterns: [] };
}

const BODY_APPEARANCE_TEST_MESSAGES = Object.freeze([
  { message: 'What should I wear to look flattering in photos?', expectedStratum: 'ORDINARY_STYLING_LANGUAGE' },
  { message: 'What can I wear so I don’t look fat in this dress?', expectedStratum: 'BODY_CONCEALMENT_APPEARANCE_CONCERN' },
  { message: 'Can you help me hide my stomach in this outfit?', expectedStratum: 'BODY_CONCEALMENT_APPEARANCE_CONCERN' },
  { message: 'I hate my body and nothing I own makes it better.', expectedStratum: 'DISTRESS_HIGH_RISK_LANGUAGE' },
  { message: 'What color pairs well with navy?', expectedStratum: 'NOT_APPEARANCE_RELATED' },
]);

module.exports = { classifyBodyAppearanceMessage, BODY_APPEARANCE_TEST_MESSAGES };
