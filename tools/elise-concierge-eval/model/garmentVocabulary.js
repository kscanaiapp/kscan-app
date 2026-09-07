'use strict';

/**
 * Garment/category head-noun vocabulary used by the extractor to decide
 * whether a sentence names a checkable item. Written fresh for this harness
 * (not copied from production's eliseOwnershipProseSafety.ts GARMENT_NOUNS,
 * though it covers similar everyday vocabulary because that is simply what
 * garments are called — see parallel-lane firewall / independent-authorship
 * note in extraction/claimExtractor.js).
 */

const GARMENT_NOUNS = [
  'loafer', 'sneaker', 'trainer', 'boot', 'heel', 'pump', 'sandal', 'oxford', 'shoe',
  'blazer', 'jacket', 'coat', 'bomber', 'cardigan', 'sweater', 'jumper', 'hoodie', 'vest',
  'shirt', 'blouse', 'tee', 'tshirt', 't-shirt', 'top', 'turtleneck', 'sportcoat', 'tuxedo', 'raincoat',
  'trouser', 'pant', 'jean', 'chino', 'short', 'skirt', 'jogger',
  'dress', 'gown', 'jumpsuit',
  'bag', 'purse', 'tote', 'belt', 'scarf', 'hat', 'cap', 'tie',
];

const CATEGORY_ROLE_NOUNS = [
  'outerwear', 'footwear', 'knitwear', 'activewear', 'swimwear', 'accessory', 'accessories',
];

function wordVariants(value) {
  const lower = String(value).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (lower.length < 3) return lower ? [lower] : [];
  const variants = new Set([lower]);
  if (lower.length > 3 && lower.endsWith('ies')) variants.add(`${lower.slice(0, -3)}y`);
  if (lower.length > 3 && lower.endsWith('es')) variants.add(lower.slice(0, -2));
  if (lower.length > 2 && lower.endsWith('s') && !lower.endsWith('ss')) variants.add(lower.slice(0, -1));
  return [...variants];
}

/** The garment class a word names, or null. */
function garmentClassOf(word) {
  for (const variant of wordVariants(word)) {
    if (GARMENT_NOUNS.includes(variant)) return variant;
  }
  return null;
}

function categoryRoleOf(word) {
  for (const variant of wordVariants(word)) {
    if (CATEGORY_ROLE_NOUNS.includes(variant)) return variant;
  }
  return null;
}

module.exports = { GARMENT_NOUNS, CATEGORY_ROLE_NOUNS, wordVariants, garmentClassOf, categoryRoleOf };
