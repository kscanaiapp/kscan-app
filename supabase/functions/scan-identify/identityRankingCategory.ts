/**
 * Listing category for Scanner identity ranking (B42-SCAN-02). Used ONLY when
 * SCANNER_IDENTITY_RANKING_V1_ENABLED is on.
 *
 * The v122 normaliser (`normalizeCommerceCategoryText`) has no entry for
 * several common product nouns ("clogs", "slides", "mules", "sweatshirt",
 * "rucksack", "gilet", "skirt" ...) and echoes such text back unrecognised. A
 * listing titled "Black Clogs" for a black clog scan therefore reads as
 * "category absent" and scores weak. That vocabulary is pinned with the v122
 * scorer, so instead of changing it (which would change flag-OFF behaviour) this
 * supplement is consulted only when the v122 normaliser returns no category.
 */
import { normalizeCommerceCategoryText } from './commerceRelevanceAgreement.ts';

export const CANONICAL_SCANNER_CATEGORIES: ReadonlySet<string> = new Set([
  'blazer', 'outerwear', 'dress', 'pants', 'top', 'footwear', 'bag', 'accessory',
]);

/** Whole-word nouns (singular or plural) the v122 normaliser does not categorise. */
const SUPPLEMENTAL_NOUNS: ReadonlyArray<[string, readonly string[]]> = Object.freeze([
  ['footwear', ['clog', 'clogs', 'slide', 'slides', 'mule', 'mules', 'espadrille', 'espadrilles', 'flip flop', 'flip flops', 'slipper', 'slippers', 'oxford', 'oxfords', 'slip on', 'slip ons', 'derby', 'derbies', 'brogue', 'brogues']],
  ['accessory', ['glasses', 'eyeglasses', 'spectacles']],
  ['bag', ['rucksack', 'rucksacks', 'knapsack', 'daypack']],
  ['top', ['sweatshirt', 'sweatshirts', 'jersey', 'jerseys']],
  ['outerwear', ['gilet', 'gilets', 'vest', 'vests', 'fleece', 'fleeces']],
  ['dress', ['skirt', 'skirts']],
]);

const key = (value: unknown): string =>
  typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    : '';

/** Canonical category of free text: the v122 result when it has one, else the supplement, else ''. */
export function identityRankingCategory(text: unknown): string {
  const raw = typeof text === 'string' ? text : '';
  const v122 = normalizeCommerceCategoryText(raw);
  if (CANONICAL_SCANNER_CATEGORIES.has(v122)) return v122;
  const k = ` ${key(raw)} `;
  for (const [category, nouns] of SUPPLEMENTAL_NOUNS) {
    if (nouns.some((noun) => k.includes(` ${noun} `))) return category;
  }
  return '';
}
