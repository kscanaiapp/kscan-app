'use strict';

/**
 * The one normalization path for CanonicalFashionAttributesV1 — mirrors the
 * "exactly one normalization" discipline of
 * supabase/functions/_shared/fashionIdentificationV2.ts (normalizeToV2):
 * every canonicalize* function here is pure, deterministic, and never
 * throws on malformed input. Equivalent inputs resolve identically on every
 * call (spec section 7, 16).
 */

const { CATEGORY_ALIASES, SUBTYPE_ALIASES, SUBTYPE_TO_CATEGORY } = require('./categories');
const { COLOR_ALIASES } = require('./colors');
const { MATERIAL_ALIASES } = require('./materials');
const { PATTERN_ALIASES } = require('./patterns');
const { SILHOUETTE_ALIASES } = require('./silhouettes');
const {
  CONTRACT_VERSION,
  createUnknownAttributeValue,
  createUnknownColorValue,
} = require('./schema');

/**
 * Tokens that mean "no evidence", observed directly in the codebase this
 * ontology integrates with: Scanner's raw provider layer defaults every
 * missing attribute to the literal string 'unknown'
 * (supabase/functions/scan-identify/index.ts), and the display layer
 * (services/scannerV2Display.ts NON_PATTERN_LABELS) blanks the same family
 * of generic labels. Treating them as absent here — rather than as a
 * canonical value named "unknown" — keeps unknown a status, not a guess.
 */
const UNKNOWN_TOKENS = new Set([
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'not applicable',
  'not specified',
  'no pattern',
  'other',
  '',
]);

/** Lowercase, trim, and collapse internal whitespace. Never throws. */
function normalizeRawString(input) {
  if (typeof input !== 'string') return null;
  const collapsed = input.trim().toLowerCase().replace(/\s+/g, ' ');
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Reduces a raw candidate — a string, an array of strings, or anything else
 * — to an ordered list of normalized, non-unknown strings. Malformed entries
 * (numbers, objects, booleans, null) are dropped rather than coerced, so a
 * malformed value can never silently become a valid taxonomy value.
 */
function normalizedCandidates(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const entry of values) {
    const normalized = normalizeRawString(entry);
    if (normalized !== null && !UNKNOWN_TOKENS.has(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Resolves the first candidate that has an alias-table entry. Returns the
 * resolved payload plus the raw string that resolved it, or null if nothing
 * in `raw` is recognized. Order-preserving and deterministic: the same
 * input list always yields the same result.
 */
function resolveFirstAlias(raw, aliasTable) {
  for (const candidate of normalizedCandidates(raw)) {
    if (Object.prototype.hasOwnProperty.call(aliasTable, candidate)) {
      return { resolved: aliasTable[candidate], raw: candidate };
    }
  }
  const candidates = normalizedCandidates(raw);
  return { resolved: null, raw: candidates.length > 0 ? candidates[0] : null };
}

function canonicalizeSimpleField(raw, aliasTable) {
  const { resolved, raw: rawCandidate } = resolveFirstAlias(raw, aliasTable);
  if (resolved === null) return { value: null, raw: rawCandidate };
  return { value: resolved, raw: rawCandidate };
}

function canonicalizeCategory(raw) {
  return canonicalizeSimpleField(raw, CATEGORY_ALIASES);
}

function canonicalizeSubtype(raw) {
  return canonicalizeSimpleField(raw, SUBTYPE_ALIASES);
}

function canonicalizeSilhouette(raw) {
  return canonicalizeSimpleField(raw, SILHOUETTE_ALIASES);
}

function canonicalizeMaterial(raw) {
  return canonicalizeSimpleField(raw, MATERIAL_ALIASES);
}

function canonicalizePattern(raw) {
  return canonicalizeSimpleField(raw, PATTERN_ALIASES);
}

function canonicalizeColor(raw) {
  const { resolved, raw: rawCandidate } = resolveFirstAlias(raw, COLOR_ALIASES);
  if (resolved === null) return { value: null, family: null, raw: rawCandidate };
  return { value: resolved.value, family: resolved.family, raw: rawCandidate };
}

/** The canonical category a resolved subtype implies, or null if none/unresolved. */
function impliedCategoryFromSubtype(subtypeValue) {
  if (typeof subtypeValue !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SUBTYPE_TO_CATEGORY, subtypeValue)
    ? SUBTYPE_TO_CATEGORY[subtypeValue]
    : null;
}

/**
 * Builds a full CanonicalFashionAttributesV1 record from loosely-shaped
 * input carrying (a subset of) the seven field names. Each field accepts a
 * string, a string array, null/undefined, or a malformed value — never
 * throws. Absent or unresolved fields come back explicitly unknown; nothing
 * is guessed.
 */
function canonicalizeFashionAttributes(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    contractVersion: CONTRACT_VERSION,
    category: 'category' in source ? canonicalizeCategory(source.category) : createUnknownAttributeValue(),
    subtype: 'subtype' in source ? canonicalizeSubtype(source.subtype) : createUnknownAttributeValue(),
    primaryColor: 'primaryColor' in source ? canonicalizeColor(source.primaryColor) : createUnknownColorValue(),
    secondaryColor: 'secondaryColor' in source ? canonicalizeColor(source.secondaryColor) : createUnknownColorValue(),
    silhouette: 'silhouette' in source ? canonicalizeSilhouette(source.silhouette) : createUnknownAttributeValue(),
    material: 'material' in source ? canonicalizeMaterial(source.material) : createUnknownAttributeValue(),
    pattern: 'pattern' in source ? canonicalizePattern(source.pattern) : createUnknownAttributeValue(),
  };
}

module.exports = {
  UNKNOWN_TOKENS,
  normalizeRawString,
  normalizedCandidates,
  canonicalizeCategory,
  canonicalizeSubtype,
  canonicalizeColor,
  canonicalizeSilhouette,
  canonicalizeMaterial,
  canonicalizePattern,
  impliedCategoryFromSubtype,
  canonicalizeFashionAttributes,
};
