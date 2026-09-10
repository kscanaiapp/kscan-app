'use strict';

/**
 * Color model (spec section 9): core color family, canonical color name,
 * aliases. Kept bounded and testable — twenty canonical colors across
 * thirteen families, not "hundreds of arbitrary color names."
 *
 * Every alias group is deliberate normalization grounded in retail-fashion
 * usage, not an assumption: burgundy/wine/oxblood/maroon are genuinely sold
 * as interchangeable names for the same dark-red family in K Scan's own
 * corpus vocabulary (tools/canonical-product-identity/lib/fashionWorld.js
 * uses 'navy'/'camel'/'olive' as first-class colors, which this table
 * mirrors), while colors the task calls out as needing to stay distinct
 * (BLACK vs NAVY, RED vs BURGUNDY, BEIGE vs TAN, WHITE vs CREAM) are never
 * folded into the same canonical value or the same alias group.
 */
const CANONICAL_COLORS = Object.freeze([
  { value: 'black', family: 'black', aliases: ['black', 'jet black', 'onyx'] },
  { value: 'white', family: 'white', aliases: ['white', 'optic white', 'bright white'] },
  // WHITE vs CREAM: distinct canonical values, distinct alias sets, even
  // though both sit in the same broad "white" family.
  { value: 'cream', family: 'white', aliases: ['cream', 'ivory', 'off-white', 'off white', 'eggshell'] },
  { value: 'grey', family: 'grey', aliases: ['grey', 'gray', 'charcoal', 'heather grey', 'heather gray'] },
  { value: 'silver', family: 'grey', aliases: ['silver', 'metallic silver'] },
  // BEIGE vs TAN: distinct canonical values. Khaki is folded into tan
  // (common retail usage for the color, not the trouser style — the
  // trouser is `trouser`/`chino` at the subtype layer).
  { value: 'beige', family: 'beige', aliases: ['beige', 'sand', 'stone', 'oatmeal'] },
  { value: 'tan', family: 'beige', aliases: ['tan', 'khaki'] },
  { value: 'camel', family: 'brown', aliases: ['camel', 'camel tan'] },
  { value: 'brown', family: 'brown', aliases: ['brown', 'chocolate', 'espresso', 'cognac'] },
  { value: 'red', family: 'red', aliases: ['red', 'cherry red', 'scarlet'] },
  // RED vs BURGUNDY: the task's own worked example. Wine/oxblood/maroon are
  // folded in as the same dark-red retail color; a bright/true red never is.
  { value: 'burgundy', family: 'red', aliases: ['burgundy', 'wine', 'wine red', 'deep burgundy', 'oxblood', 'maroon', 'bordeaux'] },
  { value: 'orange', family: 'orange', aliases: ['orange', 'rust', 'terracotta'] },
  { value: 'yellow', family: 'yellow', aliases: ['yellow', 'gold'] },
  { value: 'mustard', family: 'yellow', aliases: ['mustard'] },
  { value: 'green', family: 'green', aliases: ['green', 'emerald', 'forest green'] },
  { value: 'olive', family: 'green', aliases: ['olive', 'olive green'] },
  { value: 'blue', family: 'blue', aliases: ['blue', 'royal blue', 'cobalt'] },
  // BLACK vs NAVY: different families entirely (black vs blue), so they can
  // never collapse into each other even loosely.
  { value: 'navy', family: 'blue', aliases: ['navy', 'navy blue', 'midnight blue'] },
  { value: 'purple', family: 'purple', aliases: ['purple', 'lavender', 'lilac'] },
  { value: 'pink', family: 'pink', aliases: ['pink', 'blush', 'rose'] },
  { value: 'multicolor', family: 'multicolor', aliases: ['multicolor', 'multi-color', 'multi', 'print'] },
]);

function buildColorAliasMap() {
  const map = Object.create(null);
  for (const color of CANONICAL_COLORS) {
    // Idempotent: a canonical value always resolves to itself.
    map[color.value] = { value: color.value, family: color.family };
    for (const alias of color.aliases) {
      map[alias] = { value: color.value, family: color.family };
    }
  }
  return Object.freeze(map);
}

const COLOR_ALIASES = buildColorAliasMap();

module.exports = {
  CANONICAL_COLORS,
  COLOR_ALIASES,
};
