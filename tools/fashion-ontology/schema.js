'use strict';

/**
 * CanonicalFashionAttributesV1 — the versioned contract shape.
 *
 * Seven fields (spec section 4): category, subtype, primaryColor,
 * secondaryColor, silhouette, material, pattern. Every field is a small
 * wrapper object rather than a bare string — that wrapper is the "small
 * supporting primitive" this package adds, and it exists only because a bare
 * string cannot represent "explicitly unresolved" distinctly from a real
 * value without a second sentinel string (which is exactly the
 * 'unknown'-as-a-guessed-value trap the corpus/Scanner/Closet labs already
 * fought — see provenance.md and compatibility.js).
 *
 * `value` is null when the field is unresolved. `raw` preserves the original
 * (post-normalization-input, pre-alias-resolution) string for traceability;
 * it is never itself a canonical value. Color fields additionally carry
 * `family` (the core color family — spec section 9).
 */

const CONTRACT_VERSION = 'canonical-fashion-attributes-v1';

/** Fields that are plain { value, raw }. */
const SIMPLE_FIELDS = Object.freeze(['category', 'subtype', 'silhouette', 'material', 'pattern']);

/** Fields that additionally carry a color family. */
const COLOR_FIELDS = Object.freeze(['primaryColor', 'secondaryColor']);

const ALL_FIELDS = Object.freeze([...SIMPLE_FIELDS.slice(0, 2), 'primaryColor', 'secondaryColor', 'silhouette', 'material', 'pattern']);

function createUnknownAttributeValue() {
  return { value: null, raw: null };
}

function createUnknownColorValue() {
  return { value: null, family: null, raw: null };
}

/** Builds an all-unknown record — the deterministic zero value of the contract. */
function createUnknownCanonicalFashionAttributes() {
  return {
    contractVersion: CONTRACT_VERSION,
    category: createUnknownAttributeValue(),
    subtype: createUnknownAttributeValue(),
    primaryColor: createUnknownColorValue(),
    secondaryColor: createUnknownColorValue(),
    silhouette: createUnknownAttributeValue(),
    material: createUnknownAttributeValue(),
    pattern: createUnknownAttributeValue(),
  };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSimpleAttributeValue(value) {
  return (
    isPlainObject(value) &&
    (value.value === null || typeof value.value === 'string') &&
    (value.raw === null || typeof value.raw === 'string') &&
    Object.keys(value).length === 2
  );
}

function isColorAttributeValue(value) {
  return (
    isPlainObject(value) &&
    (value.value === null || typeof value.value === 'string') &&
    (value.family === null || typeof value.family === 'string') &&
    (value.raw === null || typeof value.raw === 'string') &&
    Object.keys(value).length === 3
  );
}

/**
 * Validates a CanonicalFashionAttributesV1 record. Never throws — returns
 * { valid, errors }, matching the sibling labs' validator convention
 * (fixtureSchema.js, identitySchema.js).
 */
function validateCanonicalFashionAttributes(record) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!isPlainObject(record)) {
    return { valid: false, errors: ['record must be a non-null object'] };
  }
  if (record.contractVersion !== CONTRACT_VERSION) {
    err(`contractVersion must be ${JSON.stringify(CONTRACT_VERSION)}, got ${JSON.stringify(record.contractVersion)}`);
  }
  for (const field of ['category', 'subtype', 'silhouette', 'material', 'pattern']) {
    if (!isSimpleAttributeValue(record[field])) {
      err(`${field} must be a { value, raw } attribute value`);
    } else if (record[field].value === null && record[field].raw !== null && typeof record[field].raw !== 'string') {
      err(`${field}.raw must be null or a string`);
    }
  }
  for (const field of ['primaryColor', 'secondaryColor']) {
    if (!isColorAttributeValue(record[field])) {
      err(`${field} must be a { value, family, raw } color value`);
    } else if (record[field].value === null && record[field].family !== null) {
      err(`${field}.family must be null when ${field}.value is null (never a guessed family without a resolved value)`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  CONTRACT_VERSION,
  ALL_FIELDS,
  SIMPLE_FIELDS,
  COLOR_FIELDS,
  createUnknownAttributeValue,
  createUnknownColorValue,
  createUnknownCanonicalFashionAttributes,
  validateCanonicalFashionAttributes,
  isPlainObject,
};
