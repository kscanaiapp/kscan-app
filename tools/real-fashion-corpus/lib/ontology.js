'use strict';

/**
 * Canonical Fashion Ontology V1 integration (Real Fashion Corpus V2).
 *
 * This module is the ONLY place this lane touches `tools/fashion-ontology/`.
 * It never modifies the ontology package - that package is the accepted,
 * hardened authority (Build 35 Workstream 01, PR #399) this lane now treats
 * as ground truth, not something to extend or fork.
 *
 * A garment's `ontology` block is the ontology's OWN CanonicalFashionAttributesV1
 * record shape verbatim - `{ value, raw }` per field, `{ value, family, raw }`
 * for colors - so raw evidence ("high-top sneaker") and the canonical, coarser
 * value ("sneaker") are both present by construction, never one discarding the
 * other (spec section 5).
 */

const {
  canonicalizeFashionAttributes,
  impliedCategoryFromSubtype,
} = require('../../fashion-ontology/canonicalize');
const {
  CONTRACT_VERSION,
  validateCanonicalFashionAttributes,
} = require('../../fashion-ontology/schema');
const { CANONICAL_CATEGORIES, SUBTYPES } = require('../../fashion-ontology/categories');
const { CANONICAL_COLORS } = require('../../fashion-ontology/colors');
const { CANONICAL_SILHOUETTES } = require('../../fashion-ontology/silhouettes');
const { CANONICAL_MATERIALS } = require('../../fashion-ontology/materials');
const { CANONICAL_PATTERNS } = require('../../fashion-ontology/patterns');

const ONTOLOGY_VERSION = CONTRACT_VERSION;

const KNOWN_SUBTYPES = new Set(SUBTYPES.map((s) => s.value));
const KNOWN_CATEGORIES = new Set(CANONICAL_CATEGORIES);
const KNOWN_COLORS = new Set(CANONICAL_COLORS.map((c) => c.value));
const COLOR_VALUE_TO_FAMILY = new Map(CANONICAL_COLORS.map((c) => [c.value, c.family]));
const KNOWN_SILHOUETTES = new Set(CANONICAL_SILHOUETTES.map((s) => s.value));
const KNOWN_MATERIALS = new Set(CANONICAL_MATERIALS.map((m) => m.value));
const KNOWN_PATTERNS = new Set(CANONICAL_PATTERNS.map((p) => p.value));

/**
 * Builds a garment's ontology block from its existing raw attributes.
 *
 * Deliberately reads only fields the corpus already collects
 * (`garment.category`, `garment.attributes.*`) - a collector never enters
 * anything new to get ontology coverage; it is fully derived.
 */
function buildGarmentOntology(garment) {
  const attributes = (garment && garment.attributes) || {};
  return canonicalizeFashionAttributes({
    category: garment && garment.category,
    subtype: attributes.subtype,
    primaryColor: attributes.colorFamily,
    secondaryColor: attributes.secondaryColorFamily,
    silhouette: attributes.silhouette,
    material: attributes.material,
    pattern: attributes.pattern,
  });
}

/**
 * True if `value` is a genuine member of the named field's canonical
 * vocabulary. `validateCanonicalFashionAttributes` (imported above) only
 * checks SHAPE (`{value, raw}` etc.) - this checks that a non-null value is
 * actually one of the ontology's real taxonomy entries, not an invented or
 * corrupted string that happens to be shaped correctly. This is what makes
 * the ontology negative control (spec section 16) possible: a tampered
 * canonical value fails this check even though it still "looks like" a
 * valid attribute value.
 */
function isKnownCanonicalValue(field, value) {
  if (value === null) return true;
  switch (field) {
    case 'category':
      return KNOWN_CATEGORIES.has(value);
    case 'subtype':
      return KNOWN_SUBTYPES.has(value);
    case 'silhouette':
      return KNOWN_SILHOUETTES.has(value);
    case 'material':
      return KNOWN_MATERIALS.has(value);
    case 'pattern':
      return KNOWN_PATTERNS.has(value);
    default:
      return false;
  }
}

function isKnownCanonicalColor(value, family) {
  if (value === null && family === null) return true;
  if (value === null || family === null) return false;
  // Must be the REAL pairing, not just two independently-valid strings - a
  // record claiming {value:'navy', family:'black'} is corrupted even though
  // both 'navy' and 'black' are each real taxonomy members on their own.
  return KNOWN_COLORS.has(value) && COLOR_VALUE_TO_FAMILY.get(value) === family;
}

/**
 * Validates a garment's `ontology` block. Returns { valid, errors }, the
 * same convention as every other validator in this lane.
 *
 * Checks, in order:
 *   1. shape + contractVersion, via the ontology package's own validator;
 *   2. every non-null value is a real member of its taxonomy (catches a
 *      corrupted/invented canonical value the shape check alone would miss);
 *   3. category/subtype cross-consistency: a resolved subtype's implied
 *      parent category must agree with the resolved category, when both are
 *      present (spec section 15 - "category/subtype mismatch").
 */
function validateGarmentOntology(ontology) {
  const errors = [];

  const shape = validateCanonicalFashionAttributes(ontology);
  if (!shape.valid) {
    return { valid: false, errors: shape.errors.map((e) => `ontology.${e}`) };
  }

  if (!isKnownCanonicalValue('category', ontology.category.value)) {
    errors.push(`ontology.category.value ${JSON.stringify(ontology.category.value)} is not a known canonical category`);
  }
  if (!isKnownCanonicalValue('subtype', ontology.subtype.value)) {
    errors.push(`ontology.subtype.value ${JSON.stringify(ontology.subtype.value)} is not a known canonical subtype`);
  }
  if (!isKnownCanonicalValue('silhouette', ontology.silhouette.value)) {
    errors.push(`ontology.silhouette.value ${JSON.stringify(ontology.silhouette.value)} is not a known canonical silhouette`);
  }
  if (!isKnownCanonicalValue('material', ontology.material.value)) {
    errors.push(`ontology.material.value ${JSON.stringify(ontology.material.value)} is not a known canonical material`);
  }
  if (!isKnownCanonicalValue('pattern', ontology.pattern.value)) {
    errors.push(`ontology.pattern.value ${JSON.stringify(ontology.pattern.value)} is not a known canonical pattern`);
  }
  if (!isKnownCanonicalColor(ontology.primaryColor.value, ontology.primaryColor.family)) {
    errors.push(`ontology.primaryColor ${JSON.stringify(ontology.primaryColor)} is not a known canonical color/family pair`);
  }
  if (!isKnownCanonicalColor(ontology.secondaryColor.value, ontology.secondaryColor.family)) {
    errors.push(`ontology.secondaryColor ${JSON.stringify(ontology.secondaryColor)} is not a known canonical color/family pair`);
  }

  if (ontology.category.value !== null && ontology.subtype.value !== null) {
    const impliedCategory = impliedCategoryFromSubtype(ontology.subtype.value);
    if (impliedCategory !== null && impliedCategory !== ontology.category.value) {
      errors.push(
        `ontology.category.value is ${JSON.stringify(ontology.category.value)} but ontology.subtype.value ` +
          `${JSON.stringify(ontology.subtype.value)} belongs to category ${JSON.stringify(impliedCategory)} - ` +
          'category/subtype mismatch',
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ONTOLOGY_VERSION,
  buildGarmentOntology,
  validateGarmentOntology,
  isKnownCanonicalValue,
  isKnownCanonicalColor,
};
