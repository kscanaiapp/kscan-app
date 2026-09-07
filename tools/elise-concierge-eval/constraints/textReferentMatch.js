'use strict';

/**
 * Small standalone helper: does this text plausibly mention this fixture
 * item, by color+category (alias-tolerant)? Kept independent of
 * extraction/claimExtractor.js (no shared state, no circular import) since
 * constraint checking needs only a yes/no mention test, not a full claim.
 */

const { canonicalColor, canonicalCategory } = require('../model/aliasTables');

function itemTokens(item) {
  const category = canonicalCategory(item.subcategory || item.category);
  const colors = (item.colors || []).map((c) => canonicalColor(c));
  return { category, colors };
}

function textCanonicalTokens(text) {
  // Cheap bag-of-words canonicalization: map every word through both alias
  // tables and keep whichever canonical form differs from the raw word (or
  // the raw word itself), so a category or color mention survives regardless
  // of which vocabulary it belongs to.
  const words = String(text).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  const set = new Set();
  for (const w of words) {
    set.add(w);
    set.add(canonicalColor(w));
    set.add(canonicalCategory(w));
  }
  return set;
}

/** True when `text` mentions both the item's category and (if present) one of its colors. */
function matchesReferent(text, item) {
  const tokens = textCanonicalTokens(text);
  const { category, colors } = itemTokens(item);
  if (!tokens.has(category)) return false;
  if (!colors.length) return true;
  return colors.some((c) => tokens.has(c));
}

module.exports = { matchesReferent, itemTokens, textCanonicalTokens };
