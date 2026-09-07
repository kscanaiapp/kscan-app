'use strict';

/**
 * Ground-truth grading and identity eligibility (mission sections 5, 6, 19).
 *
 * THE CENTRAL RULE OF THIS FILE: a grade is DERIVED from the evidence
 * actually present, never read from a field an operator typed. An operator's
 * asserted grade is treated as a claim to be checked, not as truth. That is
 * what makes grade inflation a validation error instead of a typo that
 * survives into a headline metric.
 */

const {
  GROUND_TRUTH_GRADES,
  ALLOWED_EVIDENCE_TYPES,
  FORBIDDEN_EVIDENCE_TYPES,
  GRADE_RULES_VERSION,
} = require('./constants');

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A durable identifier is one that survives the retailer page disappearing:
 * a manufacturer style/model code, or a GTIN/UPC/EAN. A retailer's own
 * internal product id is NOT durable - it dies with the listing - so it is
 * deliberately not accepted here (mission section 19).
 */
function hasDurableIdentifier(identity) {
  if (!identity || typeof identity !== 'object') return false;
  const style = identity.style || {};
  const variant = identity.variant || {};
  return nonEmptyString(style.styleCode) || nonEmptyString(variant.gtin);
}

/**
 * Colorway-level truth: we know WHICH colorway of the style this is. Required
 * for an EXACT identity claim (mission section 6) because "the right style in
 * the wrong colour" is a different product to a shopper.
 */
function hasColorwayLevelTruth(identity) {
  if (!identity || typeof identity !== 'object') return false;
  const variant = identity.variant || {};
  return nonEmptyString(variant.colorwayName) || nonEmptyString(variant.colorwayCode);
}

/** Evidence records that are neither model-derived nor structurally empty. */
function usableEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (record) =>
      record &&
      typeof record === 'object' &&
      ALLOWED_EVIDENCE_TYPES.includes(record.evidenceType) &&
      nonEmptyString(record.verifiedOn) &&
      nonEmptyString(record.verifiedBy),
  );
}

/** Any model-derived evidence at all poisons the record (mission section 5). */
function findModelDerivedEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.filter(
    (record) =>
      record &&
      typeof record === 'object' &&
      (FORBIDDEN_EVIDENCE_TYPES.includes(record.evidenceType) || record.modelDerived === true),
  );
}

/**
 * Derive the ground-truth grade from the evidence actually present.
 *
 *   IDENTIFIER_GRADE - usable evidence AND a durable identifier AND brand AND
 *                      productName. "Reliable manufacturer/product identifier
 *                      chain" in mission section 6's words.
 *   PARTIAL          - usable evidence AND a brand, but no complete
 *                      identifier chain.
 *   VISUAL_ONLY      - anything less. This is a legitimate, honest outcome,
 *                      not a failure - it simply cannot support an exact
 *                      identity claim.
 *
 * Returns { grade, reasons } - reasons explains what was missing, so an
 * operator can see WHY a garment did not reach the grade they expected.
 */
function deriveGrade(groundTruth) {
  const reasons = [];
  if (!groundTruth || typeof groundTruth !== 'object') {
    return { grade: 'VISUAL_ONLY', reasons: ['groundTruth is missing or not an object'] };
  }

  const modelDerived = findModelDerivedEvidence(groundTruth.evidence);
  if (modelDerived.length > 0) {
    // Not a downgrade - a hard refusal. A record carrying model-derived
    // evidence is invalid, not merely weak. Callers must reject it outright;
    // returning VISUAL_ONLY here would let it survive as a usable case.
    return {
      grade: null,
      invalid: true,
      reasons: modelDerived.map(
        (record) =>
          `model-derived evidence is forbidden (mission section 5): ${record.evidenceType || 'modelDerived:true'}`,
      ),
    };
  }

  const identity = groundTruth.identity || {};
  const style = identity.style || {};
  const evidence = usableEvidence(groundTruth.evidence);

  if (evidence.length === 0) {
    reasons.push('no usable non-model evidence record (needs evidenceType + verifiedOn + verifiedBy)');
    return { grade: 'VISUAL_ONLY', reasons };
  }

  const brandPresent = nonEmptyString(style.brand);
  const productNamePresent = nonEmptyString(style.productName);
  const durable = hasDurableIdentifier(identity);

  if (brandPresent && productNamePresent && durable) {
    return { grade: 'IDENTIFIER_GRADE', reasons: [] };
  }

  if (!durable) reasons.push('no durable identifier (needs identity.style.styleCode or identity.variant.gtin)');
  if (!productNamePresent) reasons.push('identity.style.productName is missing');

  if (brandPresent) {
    return { grade: 'PARTIAL', reasons };
  }

  reasons.push('identity.style.brand is missing');
  return { grade: 'VISUAL_ONLY', reasons };
}

/**
 * Identity eligibility (mission section 6's denominator rule).
 *
 * A garment is eligible to appear in an EXACT-product-identity denominator
 * only if it could, in principle, establish exact identity. Anything less
 * would make the denominator a lie: cases that CANNOT be got right would
 * count as cases that were got wrong.
 *
 * Returns { eligible, grade, reasons }.
 */
function evaluateIdentityEligibility(garment) {
  const groundTruth = garment && garment.groundTruth;
  const derived = deriveGrade(groundTruth);

  if (derived.invalid) {
    return { eligible: false, grade: null, invalid: true, reasons: derived.reasons };
  }

  const reasons = [];
  if (derived.grade !== 'IDENTIFIER_GRADE') {
    reasons.push(`grade is ${derived.grade}, exact identity requires IDENTIFIER_GRADE`);
  }
  const identity = (groundTruth && groundTruth.identity) || {};
  if (!hasColorwayLevelTruth(identity)) {
    reasons.push('no colorway-level truth (needs identity.variant.colorwayName or colorwayCode)');
  }
  if (!hasDurableIdentifier(identity)) {
    reasons.push('no durable identifier (needs identity.style.styleCode or identity.variant.gtin)');
  }

  return { eligible: reasons.length === 0, grade: derived.grade, reasons };
}

/**
 * Provenance self-containment (mission section 19).
 *
 * A ground-truth record must remain reviewable after every retailer URL in it
 * dies. So: strip every URL pointer, and check the record still says what the
 * product is. If it does not, the URL was carrying the evidence, which is
 * precisely the link-rot failure section 19 forbids.
 *
 * This is implemented as an actual removal-and-recheck rather than a
 * field-presence assertion, because the only convincing proof that a record
 * does not depend on its URLs is to evaluate it without them.
 */
function checkProvenanceSelfContained(garment) {
  const groundTruth = garment && garment.groundTruth;
  if (!groundTruth) {
    return { selfContained: false, reasons: ['groundTruth is missing'] };
  }

  const stripped = JSON.parse(JSON.stringify(groundTruth));
  for (const record of stripped.evidence || []) {
    delete record.urlPointer;
  }

  const reasons = [];
  const withoutUrls = usableEvidence(stripped.evidence);
  if (withoutUrls.length === 0) {
    reasons.push('every evidence record becomes unusable once its URL pointer is removed');
  }

  for (const record of withoutUrls) {
    const facts = record.observedFacts;
    if (!facts || typeof facts !== 'object' || Object.keys(facts).length === 0) {
      reasons.push(
        `evidence record ${record.evidenceType} carries no observedFacts, so its URL was the only evidence`,
      );
    }
  }

  // The derived grade must survive URL removal unchanged. If a record drops a
  // grade when its URLs go away, the identifiers were never actually recorded.
  const gradeWithUrls = deriveGrade(groundTruth);
  const gradeWithoutUrls = deriveGrade(stripped);
  if (gradeWithUrls.grade !== gradeWithoutUrls.grade) {
    reasons.push(
      `ground-truth grade degrades from ${gradeWithUrls.grade} to ${gradeWithoutUrls.grade} when URL pointers are removed`,
    );
  }

  return { selfContained: reasons.length === 0, reasons };
}

module.exports = {
  GRADE_RULES_VERSION,
  GROUND_TRUTH_GRADES,
  deriveGrade,
  evaluateIdentityEligibility,
  checkProvenanceSelfContained,
  hasDurableIdentifier,
  hasColorwayLevelTruth,
  usableEvidence,
  findModelDerivedEvidence,
  nonEmptyString,
};
