'use strict';

/**
 * Deterministic canonical JSON serialization and hashing.
 *
 * Required by spec section 52 (DETERMINISM): every generated artifact must be
 * sorted, stable-keyed, and reproducibly hashable so that running corpus /
 * report generation twice yields byte-identical output. Node built-ins only
 * (crypto), matching the rest of this repo's script conventions
 * (security/scripts/*.js).
 */

const crypto = require('node:crypto');

/**
 * Recursively sort object keys and normalize values so JSON.stringify output
 * is stable across property-insertion order. Arrays keep their order (order
 * is semantically meaningful in this domain: candidate rank, sentence order,
 * etc.) — only object key order is normalized.
 */
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) {
    throw new Error('canonicalize: raw Date instances are not allowed; use an ISO string field explicitly');
  }
  if (typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const key of sortedKeys) {
      const v = value[key];
      if (v === undefined) continue; // undefined fields never participate in the hash
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  const text = typeof value === 'string' ? value : canonicalStringify(value);
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Hash a JSON-shaped value AFTER stripping any field path matching one of
 * `volatileFieldNames` at any depth (e.g. `generatedAt`) — section 52 requires
 * timestamps to be excluded from hashed canonical content unless the
 * timestamp is intentionally part of the artifact identity.
 */
function stripVolatile(value, volatileFieldNames) {
  const names = new Set(volatileFieldNames || []);
  function strip(v) {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (names.has(k)) continue;
        out[k] = strip(val);
      }
      return out;
    }
    return v;
  }
  return strip(value);
}

function stableHashExcluding(value, volatileFieldNames) {
  return sha256Hex(canonicalStringify(stripVolatile(value, volatileFieldNames)));
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = {
  canonicalize,
  canonicalStringify,
  sha256Hex,
  stripVolatile,
  stableHashExcluding,
  nowIso,
};
