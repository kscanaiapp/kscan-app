'use strict';

/**
 * CLAIM EXTRACTION SCHEMA — spec section 26. Load-bearing; versioned
 * separately from the defect taxonomy because the extraction RULES can
 * change independently of what defects exist.
 */

const EXTRACTION_RULES_VERSION = 'EXTRACTION_RULES_V1';

const CLAIM_TYPES = Object.freeze({
  OWNERSHIP: 'OWNERSHIP',
  NON_OWNERSHIP: 'NON_OWNERSHIP',
  PREFERENCE: 'PREFERENCE',
  DISLIKE: 'DISLIKE',
  CLOSET_FACT: 'CLOSET_FACT',
  SIGNATURE_STYLE_FACT: 'SIGNATURE_STYLE_FACT',
  CONSTRAINT: 'CONSTRAINT',
  ENTITLEMENT_FACT: 'ENTITLEMENT_FACT',
  EXTERNAL_PRODUCT_FACT: 'EXTERNAL_PRODUCT_FACT',
});

const SUPPORT_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  CONTRADICTED: 'CONTRADICTED',
  UNKNOWN: 'UNKNOWN',
  UNDECIDABLE: 'UNDECIDABLE',
});

/**
 * @typedef {Object} ExtractedClaim
 * @property {string} text - the exact sentence/span the claim was found in
 * @property {string} type - one of CLAIM_TYPES
 * @property {string|null} referent - the garment/category/fact token the claim is about
 * @property {'SUPPORTED'|'CONTRADICTED'|'UNKNOWN'|'UNDECIDABLE'} supportStatus
 * @property {string[]} evidenceIds - fixture/candidate ids that support or contradict this claim
 */

/** Build a well-formed ExtractedClaim, validating required fields. */
function makeClaim({ text, type, referent, supportStatus, evidenceIds }) {
  if (!Object.values(CLAIM_TYPES).includes(type)) {
    throw new Error(`makeClaim: invalid claim type "${type}"`);
  }
  if (!Object.values(SUPPORT_STATUS).includes(supportStatus)) {
    throw new Error(`makeClaim: invalid supportStatus "${supportStatus}"`);
  }
  return {
    text: String(text),
    type,
    referent: referent === undefined ? null : referent,
    supportStatus,
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds.slice() : [],
  };
}

module.exports = {
  EXTRACTION_RULES_VERSION,
  CLAIM_TYPES,
  SUPPORT_STATUS,
  makeClaim,
};
