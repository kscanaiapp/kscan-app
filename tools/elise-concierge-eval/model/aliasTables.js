'use strict';

/**
 * Shared color/category alias tables — spec section 18 (phrasing realism:
 * "color alias (burgundy/wine), category alias (sneakers/trainers)") and
 * section 28 (EXTRACTION OPERATING CURVE: alias tolerance is one of the
 * sweep dimensions). Used by BOTH the synthesizer (to generate realistic
 * surface variation) and the extractor (to normalize surface text back to a
 * canonical token before matching against fixture ground truth) — a single
 * shared table, so the two sides can never silently drift apart on what
 * counts as "the same word".
 */

const COLOR_ALIASES = Object.freeze({
  burgundy: ['burgundy', 'wine', 'oxblood'],
  brown: ['brown', 'chocolate', 'chestnut', 'tan', 'camel', 'dark brown', 'khaki', 'straw', 'oatmeal'],
  navy: ['navy', 'dark blue', 'midnight blue'],
  black: ['black', 'jet black'],
  grey: ['grey', 'gray', 'charcoal'],
  white: ['white', 'ivory'],
  camel: ['camel', 'sand'],
  blue: ['blue', 'light blue', 'indigo'],
  red: ['red'],
  green: ['green', 'olive'],
  yellow: ['yellow'],
  purple: ['purple'],
  orange: ['orange'],
  teal: ['teal'],
});

const CATEGORY_ALIASES = Object.freeze({
  sneaker: ['sneakers', 'sneaker', 'trainers', 'trainer', 'kicks'],
  loafer: ['loafers', 'loafer', 'slip-ons', 'slip-on'],
  trouser: ['trousers', 'trouser', 'slacks', 'dress pants', 'pants'],
  blazer: ['blazer', 'sport coat', 'sportcoat'],
  't-shirt': ['t-shirt', 'tshirt', 'tee', 'tees'],
  sweater: ['sweater', 'jumper', 'pullover'],
  jean: ['jeans', 'jean'],
  jacket: ['jacket', 'coat'],
  boot: ['boots', 'boot'],
  belt: ['belt', 'belts'],
});

function buildReverse(table) {
  const reverse = new Map();
  for (const [canonical, aliases] of Object.entries(table)) {
    for (const alias of aliases) reverse.set(alias.toLowerCase(), canonical);
    reverse.set(canonical.toLowerCase(), canonical);
  }
  return reverse;
}

const COLOR_REVERSE = buildReverse(COLOR_ALIASES);
const CATEGORY_REVERSE = buildReverse(CATEGORY_ALIASES);

/** Normalize a color word/phrase to its canonical family key, or return it lowercased unchanged if unknown. */
function canonicalColor(word) {
  if (!word) return null;
  const lower = String(word).toLowerCase().trim();
  return COLOR_REVERSE.get(lower) || lower;
}

/** Normalize a category/subcategory word to its canonical key, or return it lowercased unchanged if unknown. */
function canonicalCategory(word) {
  if (!word) return null;
  const lower = String(word).toLowerCase().trim();
  // Try singular form too (strip a trailing 's' as a cheap fallback).
  return (
    CATEGORY_REVERSE.get(lower) ||
    (lower.endsWith('s') ? CATEGORY_REVERSE.get(lower.slice(0, -1)) : undefined) ||
    lower
  );
}

module.exports = {
  COLOR_ALIASES,
  CATEGORY_ALIASES,
  canonicalColor,
  canonicalCategory,
};
