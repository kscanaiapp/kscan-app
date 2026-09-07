'use strict';

/**
 * Core data-model + ground-truth/decision taxonomy for the Canonical Product
 * Identity Lab (spec sections 5, 8, 39; Addendum A.4 which supersedes
 * section 8's mixed ground-truth/decision labels).
 *
 * Style -> Variant -> Offer (section 5):
 *   RetailOffer   - one retailer/provider listing. Never the canonical identity.
 *   (generator-only) canonical style/variant graph the corpus is built from -
 *   the RESOLVER never sees style/variant ids; it only ever sees offers and
 *   must reconstruct clusters from evidence, exactly like production would.
 */

const { assertPrivacySafe, scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');

const SCHEMA_VERSION = 'cpil-identity-schema-v1';

// Addendum A.4 - GROUND TRUTH (generator-known, exhaustive, mutually exclusive).
const GROUND_TRUTH_LABELS = [
  'SAME_VARIANT',
  'SIBLING_VARIANT',
  'NEAR_DUPLICATE_DISTINCT',
  'DISTINCT',
  'UNDECIDABLE',
];

// Addendum A.4 - RESOLVER DECISION (one per evaluated pair).
const RESOLVER_DECISIONS = ['AUTO_MERGE', 'PROPOSED_REVIEW', 'ABSTAIN', 'SEPARATE'];

const VALID_CORPUS_TIERS = ['SYNTHETIC', 'APPROVED_REAL'];
const VALID_GROUND_TRUTH_SOURCES = [
  'synthetic_generator_construction',
  'retailer_pdp',
  'manufacturer_specification',
  'known_sku_metadata',
  'owner_annotation',
];
const VALID_SELLER_TYPES = ['authorized_retailer', 'marketplace_seller', 'reseller', 'outlet'];

const REQUIRED_OFFER_FIELDS = ['offerId', 'retailer'];

// Fields a RetailOffer may legitimately carry. Anything outside this list is
// still allowed (forward-compatible), but the privacy guard still recurses
// into it - unknown fields do not get a free pass on privacy.
const OFFER_SIGNAL_FIELDS = [
  'gtin', 'mpn', 'manufacturerStyleCode', 'retailerSku', 'brand', 'title',
  'category', 'color', 'material', 'pattern', 'silhouette',
  'constructionDetails', 'imageUrl', 'canonicalUrl', 'url', 'price',
  'currency', 'availability', 'sizeAvailable', 'season', 'sellerType',
  'externalProductId',
];

function err(errors, msg) {
  errors.push(msg);
}

function validateOffer(offer) {
  const errors = [];
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    return { valid: false, errors: ['offer must be a non-null object'] };
  }
  for (const field of REQUIRED_OFFER_FIELDS) {
    if (typeof offer[field] !== 'string' || !offer[field].trim()) {
      err(errors, `offer.${field} is required and must be a non-empty string`);
    }
  }
  if (offer.sellerType !== undefined && !VALID_SELLER_TYPES.includes(offer.sellerType)) {
    err(errors, `offer.sellerType must be one of ${VALID_SELLER_TYPES.join(', ')}, got ${JSON.stringify(offer.sellerType)}`);
  }
  if (offer.price !== undefined && offer.price !== null && typeof offer.price !== 'number') {
    err(errors, 'offer.price, when present, must be a number');
  }
  if (offer.sizeAvailable !== undefined && offer.sizeAvailable !== null && !Array.isArray(offer.sizeAvailable)) {
    err(errors, 'offer.sizeAvailable, when present, must be an array');
  }
  const privacy = scanForPrivacyViolations(offer);
  if (!privacy.safe) {
    for (const v of privacy.violations) err(errors, `privacy_violation at ${v.path}: ${v.reason}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a full corpus artifact (generator output). Section 43#29 -
 * duplicate fixture/offer ids fail; missing provenance fails.
 */
function validateCorpus(corpus) {
  const errors = [];
  if (!corpus || typeof corpus !== 'object') {
    return { valid: false, errors: ['corpus must be an object'] };
  }
  if (typeof corpus.corpusId !== 'string' || !corpus.corpusId.trim()) {
    err(errors, 'corpus.corpusId is required');
  }
  if (typeof corpus.generatorVersion !== 'string' || !corpus.generatorVersion.trim()) {
    err(errors, 'corpus.generatorVersion is required (provenance)');
  }
  if (typeof corpus.seed !== 'string' || !corpus.seed.trim()) {
    err(errors, 'corpus.seed is required (provenance / determinism)');
  }
  if (!VALID_CORPUS_TIERS.includes(corpus.corpusTier)) {
    err(errors, `corpus.corpusTier must be one of ${VALID_CORPUS_TIERS.join(', ')}`);
  }
  if (!VALID_GROUND_TRUTH_SOURCES.includes(corpus.groundTruthSource)) {
    err(errors, `corpus.groundTruthSource must be one of ${VALID_GROUND_TRUTH_SOURCES.join(', ')}`);
  }
  if (corpus.corpusTier === 'SYNTHETIC' && corpus.groundTruthSource !== 'synthetic_generator_construction') {
    err(errors, "SYNTHETIC corpus must set groundTruthSource = 'synthetic_generator_construction'");
  }

  if (!Array.isArray(corpus.offers)) {
    err(errors, 'corpus.offers must be an array');
  } else {
    const seenIds = new Set();
    corpus.offers.forEach((offer, idx) => {
      const { valid, errors: offerErrors } = validateOffer(offer);
      if (!valid) offerErrors.forEach((e) => err(errors, `offers[${idx}] (${offer && offer.offerId}): ${e}`));
      if (offer && typeof offer.offerId === 'string') {
        if (seenIds.has(offer.offerId)) err(errors, `duplicate offerId across corpus: ${offer.offerId}`);
        seenIds.add(offer.offerId);
      }
    });
  }

  if (!Array.isArray(corpus.canonicalStyles)) {
    err(errors, 'corpus.canonicalStyles must be an array (the generator-known graph; never seen by the resolver)');
  }

  if (!Array.isArray(corpus.cases)) {
    err(errors, 'corpus.cases must be an array (one entry per required/adversarial case, section 21/22 traceability)');
  }

  const privacy = scanForPrivacyViolations(corpus);
  if (!privacy.safe) {
    for (const v of privacy.violations) err(errors, `privacy_violation at ${v.path}: ${v.reason}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  GROUND_TRUTH_LABELS,
  RESOLVER_DECISIONS,
  VALID_CORPUS_TIERS,
  VALID_GROUND_TRUTH_SOURCES,
  VALID_SELLER_TYPES,
  REQUIRED_OFFER_FIELDS,
  OFFER_SIGNAL_FIELDS,
  validateOffer,
  validateCorpus,
  assertOfferPrivacySafe: (offer) => assertPrivacySafe(offer, 'offer'),
  assertCorpusPrivacySafe: (corpus) => assertPrivacySafe(corpus, 'corpus'),
};
