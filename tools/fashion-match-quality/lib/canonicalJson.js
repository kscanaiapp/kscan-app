'use strict';

/**
 * Canonical (deterministic) JSON serialization + hashing helpers.
 *
 * Used across schema/fixtures/baseline/reports so that two runs over the
 * same logical content produce byte-identical serialization regardless of
 * key insertion order. Per spec section 24 (DETERMINISM):
 *   - object keys are sorted recursively
 *   - arrays keep their given order (order is meaningful for ranked lists)
 *   - callers are responsible for excluding/normalizing genuinely volatile
 *     fields (e.g. a report-generation timestamp) before calling this.
 */

const crypto = require('node:crypto');

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON.stringify with recursively sorted object keys. */
function canonicalStringify(value) {
  return JSON.stringify(sortValue(value));
}

/** SHA-256 hex digest of the canonical serialization of `value`. */
function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

/**
 * Strip a fixed list of top-level (dot-path) fields before hashing/canonical
 * comparison, so intentionally volatile fields never gate determinism tests.
 * Example: stripVolatile(report, ['generatedAt']).
 */
function stripVolatile(value, dotPaths) {
  const clone = JSON.parse(JSON.stringify(value));
  for (const dotPath of dotPaths) {
    const parts = dotPath.split('.');
    let cursor = clone;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (cursor == null || typeof cursor !== 'object') {
        cursor = null;
        break;
      }
      cursor = cursor[parts[i]];
    }
    if (cursor && typeof cursor === 'object') {
      delete cursor[parts[parts.length - 1]];
    }
  }
  return clone;
}

module.exports = { canonicalStringify, canonicalHash, sortValue, stripVolatile };
