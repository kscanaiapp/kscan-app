'use strict';

/**
 * Golden accuracy fixtures for the identification-accuracy sprint (v1).
 *
 * These are TEXT proxies for real scans. They exercise the deterministic parts
 * of the pipeline (category normalization, confidence calibration, JSON repair)
 * that drive catalog retrieval and the displayed result. Real visual accuracy
 * must still be confirmed by a human running equivalent image scans on-device.
 *
 * Catalog canonical categories that exist today (verified against
 * public.product_catalog on App Staging): outerwear, blazer, dress, footwear,
 * bag, accessory. "pants"/"top" normalize correctly but have no catalog rows
 * yet, so those scans are expected to return an empty product shelf.
 */

// item_type (what the model emits) → expected canonicalCategory.
const CATEGORY_CASES = [
  // Outerwear (the prior normalizer missed several of these).
  { itemType: 'puffer jacket', expected: 'outerwear' },
  { itemType: 'puffer', expected: 'outerwear' },
  { itemType: 'black puffer jacket', expected: 'outerwear' },
  { itemType: 'wool coat', expected: 'outerwear' },
  { itemType: 'cream wool coat', expected: 'outerwear' },
  { itemType: 'raincoat', expected: 'outerwear' },
  { itemType: 'overcoat', expected: 'outerwear' },
  { itemType: 'bomber jacket', expected: 'outerwear' },
  { itemType: 'parka', expected: 'outerwear' },
  { itemType: 'trench coat', expected: 'outerwear' },
  // Blazer is its own catalog category.
  { itemType: 'blazer', expected: 'blazer' },
  { itemType: 'navy blazer', expected: 'blazer' },
  { itemType: 'suit jacket', expected: 'blazer' },
  // Footwear (plural forms were the main regression).
  { itemType: 'sneakers', expected: 'footwear' },
  { itemType: 'white sneakers', expected: 'footwear' },
  { itemType: 'boots', expected: 'footwear' },
  { itemType: 'ankle boots', expected: 'footwear' },
  { itemType: 'loafers', expected: 'footwear' },
  { itemType: 'sandals', expected: 'footwear' },
  { itemType: 'heels', expected: 'footwear' },
  // Dress.
  { itemType: 'dress', expected: 'dress' },
  { itemType: 'midi dress', expected: 'dress' },
  { itemType: 'floral midi dress', expected: 'dress' },
  { itemType: 'gown', expected: 'dress' },
  // Bag.
  { itemType: 'handbag', expected: 'bag' },
  { itemType: 'brown leather handbag', expected: 'bag' },
  { itemType: 'tote bag', expected: 'bag' },
  { itemType: 'backpack', expected: 'bag' },
  // Accessory.
  { itemType: 'belt', expected: 'accessory' },
  { itemType: 'baseball hat', expected: 'accessory' },
  { itemType: 'silk scarf', expected: 'accessory' },
  { itemType: 'sunglasses', expected: 'accessory' },
  // Non-fashion.
  { itemType: 'NON_FASHION', expected: 'NON_FASHION' },
  // Bottoms / tops (normalize correctly; no catalog rows today).
  { itemType: 'jeans', expected: 'pants' },
  { itemType: 'bootcut jeans', expected: 'pants' }, // must NOT become footwear
  { itemType: 'cotton t-shirt', expected: 'top' },
  { itemType: 'hoodie', expected: 'top' },
];

// Dominant-item scenarios: a garment keyword must win over a co-present bag /
// accessory so a jacket scan never returns the bag category.
const DOMINANT_CASES = [
  { phrase: 'black tote bag next to a jacket', expected: 'outerwear' },
  { phrase: 'person wearing a jacket and carrying a bag', expected: 'outerwear' },
  { phrase: 'full outfit with a coat, shoes, and a bag', expected: 'outerwear' },
];

// Confidence calibration: High >= 0.80, Medium 0.60–0.79, Low < 0.60, with
// downgrades for quality notes and unknown/non-fashion item types.
const CONFIDENCE_CASES = [
  { score: 0.95, expected: 'High' },
  { score: 0.80, expected: 'High' },
  { score: 0.79, expected: 'Medium' },
  { score: 0.65, expected: 'Medium' }, // would have been "Low" under the old 0.70 cut
  { score: 0.60, expected: 'Medium' },
  { score: 0.59, expected: 'Low' },
  { score: 0.30, expected: 'Low' },
  { score: 0.90, opts: { hasQualityNote: true }, expected: 'Medium' },
  { score: 0.92, opts: { itemType: 'unknown' }, expected: 'Medium' },
  { score: 0.92, opts: { itemType: 'NON_FASHION' }, expected: 'Medium' },
  { score: undefined, expected: undefined },
];

// JSON parse / repair cases.
const PARSE_CASES = [
  {
    name: 'markdown fenced json',
    raw: '```json\n{"status":"completed","attributes":{"category":"blazer"}}\n```',
    expectKey: 'status',
    expectValue: 'completed',
  },
  {
    name: 'trailing comma in object',
    raw: '{"status":"completed","attributes":{"category":"dress",},}',
    expectKey: 'status',
    expectValue: 'completed',
  },
  {
    name: 'trailing comma in array',
    raw: '{"colors":["black","white",],"status":"completed"}',
    expectKey: 'status',
    expectValue: 'completed',
  },
  {
    name: 'prose wrapped around object',
    raw: 'Here is the result: {"status":"non_fashion"} thanks!',
    expectKey: 'status',
    expectValue: 'non_fashion',
  },
];

module.exports = { CATEGORY_CASES, DOMINANT_CASES, CONFIDENCE_CASES, PARSE_CASES };
