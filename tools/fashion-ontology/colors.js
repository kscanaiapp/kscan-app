'use strict';

/**
 * Color model (spec section 9): core color family, canonical color name,
 * aliases. Kept bounded and testable — thirty canonical colors across
 * thirteen families, not "hundreds of arbitrary color names."
 *
 * SEMANTIC HARDENING PASS (before this ontology becomes ground truth for
 * Real Fashion Corpus). Doctrine applied to every alias below: "a hard
 * alias means the terms can safely be treated as the same canonical
 * fashion concept for K Scan matching." Shared family, relatedness, or
 * common retail *misuse* are not sufficient — when uncertain, a value is
 * split out to its own canonical entry (still grouped by family) rather
 * than collapsed. This pass reviewed every alias in the file, not only the
 * ones that changed; entries with no comment below were reviewed and kept
 * as genuine same-concept synonyms (e.g. `poly` = `polyester`-style naming
 * variants, weave/brand-name variants of one fiber, etc. — see
 * `materials.js` for that file's own pass).
 *
 * REMOVED as unsafe collapses (now distinct canonical values):
 *   gold -> was folded into `yellow`. Gold is a metallic, not a hue variant
 *     of yellow (parallel to `silver` already being its own value rather
 *     than a shade of `grey`).
 *   print -> was folded into `multicolor`. "Print" alone names no color at
 *     all (a floral print, an animal print, and a graphic print are not
 *     the same color, or even necessarily multicolor) — removed outright,
 *     not reassigned.
 *   maroon -> was folded into `burgundy`. Maroon reads more brown/muted
 *     (collegiate branding, American football) than the wine-purple of
 *     burgundy; genuinely different enough in retail practice to matter
 *     for matching. Now its own value in the `red` family.
 *   lavender/lilac -> were folded into `purple`. Both are pale pastels,
 *     commercially distinct from a bold "purple" (a shopper searching
 *     lavender does not want purple results). Lavender and lilac ARE
 *     safely merged with each other (near-identical pale-purple retail
 *     terms) — see RETAINED below.
 *   charcoal -> was folded into `grey`. Charcoal is specifically a dark,
 *     near-black grey and is sold/searched as its own shade, the same
 *     reasoning that already kept BLACK distinct from NAVY.
 *   rust/terracotta -> were folded into `orange`. Both are muted
 *     brownish-orange earth tones, distinct from a bright/true orange.
 *     Rust and terracotta ARE safely merged with each other — see
 *     RETAINED below.
 *   emerald / forest green -> were folded into `green`. Emerald is a
 *     vivid jewel tone; forest green is dark and muted; plain `green` is
 *     neither. The three read as different colors in a product photo and
 *     are kept as three distinct values, not two-into-one.
 *   royal blue/cobalt -> were folded into `blue`. Both name a specific
 *     saturated, vivid mid-blue, distinct from a generic "blue" or from
 *     `navy`. Royal blue and cobalt ARE safely merged with each other —
 *     see RETAINED below.
 *   blush/rose -> were folded into `pink`. Both describe a muted, dusty
 *     pink distinct from a bright/true pink. Blush and rose ARE safely
 *     merged with each other — see RETAINED below.
 *
 * RETAINED as justified hard aliases (same concept, not merely related):
 *   oxblood -> burgundy. Oxblood is retail/footwear terminology for the
 *     identical dark wine-red leather hue as burgundy (e.g. the Dr. Martens
 *     "Oxblood" colorway), not a visually distinct shade in practice —
 *     unlike maroon, this is a naming variant, not a different color.
 *   wine / wine red / deep burgundy / bordeaux -> burgundy (unchanged from
 *     the original worked example — these literally name burgundy).
 *   lilac -> lavender. Near-identical pale-purple retail terms, used
 *     interchangeably far more often than either is used for true purple.
 *   terracotta -> rust. Near-identical muted brownish-orange retail terms.
 *   cobalt (+ cobalt blue) -> royal_blue. Near-identical vivid-blue retail
 *     terms.
 *   rose / dusty rose -> blush. Near-identical dusty-pink retail terms;
 *     kept as one bounded value rather than proliferating pink shades.
 */
const CANONICAL_COLORS = Object.freeze([
  { value: 'black', family: 'black', aliases: ['black', 'jet black', 'onyx'] },
  { value: 'white', family: 'white', aliases: ['white', 'optic white', 'bright white'] },
  // WHITE vs CREAM: distinct canonical values, distinct alias sets, even
  // though both sit in the same broad "white" family.
  { value: 'cream', family: 'white', aliases: ['cream', 'ivory', 'off-white', 'off white', 'eggshell'] },
  { value: 'grey', family: 'grey', aliases: ['grey', 'gray', 'heather grey', 'heather gray'] },
  // Split from `grey`: a specifically dark, near-black grey, sold/searched
  // as its own shade (same reasoning as BLACK vs NAVY staying distinct).
  { value: 'charcoal', family: 'grey', aliases: ['charcoal'] },
  { value: 'silver', family: 'grey', aliases: ['silver', 'metallic silver'] },
  // BEIGE vs TAN: distinct canonical values. Khaki is folded into tan
  // (common retail usage for the color, not the trouser style — the
  // trouser is `trouser`/`chino` at the subtype layer).
  { value: 'beige', family: 'beige', aliases: ['beige', 'sand', 'stone', 'oatmeal'] },
  { value: 'tan', family: 'beige', aliases: ['tan', 'khaki'] },
  { value: 'camel', family: 'brown', aliases: ['camel', 'camel tan'] },
  { value: 'brown', family: 'brown', aliases: ['brown', 'chocolate', 'espresso', 'cognac'] },
  { value: 'red', family: 'red', aliases: ['red', 'cherry red', 'scarlet'] },
  // RED vs BURGUNDY: the task's own worked example. Wine/oxblood are folded
  // in as retail naming variants of the same dark-red; maroon is not (see
  // header) — a bright/true red never is either.
  { value: 'burgundy', family: 'red', aliases: ['burgundy', 'wine', 'wine red', 'deep burgundy', 'oxblood', 'bordeaux'] },
  // Split from `burgundy`: reads browner/more muted than burgundy's
  // wine-purple in common retail use (collegiate branding, football).
  { value: 'maroon', family: 'red', aliases: ['maroon'] },
  { value: 'orange', family: 'orange', aliases: ['orange'] },
  // Split from `orange`: muted brownish-orange earth tone, distinct enough
  // from a bright/true orange to matter for matching. Terracotta merges
  // into it as a near-identical retail term.
  { value: 'rust', family: 'orange', aliases: ['rust', 'terracotta'] },
  // Split from `yellow`: gold is a metallic, not a shade of yellow —
  // parallel to `silver` already being its own value rather than a shade
  // of grey.
  { value: 'gold', family: 'yellow', aliases: ['gold', 'metallic gold'] },
  { value: 'yellow', family: 'yellow', aliases: ['yellow'] },
  { value: 'mustard', family: 'yellow', aliases: ['mustard'] },
  { value: 'green', family: 'green', aliases: ['green'] },
  // Split from `green`: a vivid jewel tone, visually distinct from both
  // plain green and forest green in a product photo.
  { value: 'emerald', family: 'green', aliases: ['emerald', 'emerald green'] },
  // Split from `green`: dark and muted, distinct from both plain green and
  // emerald.
  { value: 'forest_green', family: 'green', aliases: ['forest green', 'hunter green'] },
  { value: 'olive', family: 'green', aliases: ['olive', 'olive green'] },
  { value: 'blue', family: 'blue', aliases: ['blue'] },
  // Split from `blue`: a specific saturated, vivid mid-blue, distinct from
  // a generic "blue" or from `navy`. Cobalt merges into it as a
  // near-identical retail term.
  { value: 'royal_blue', family: 'blue', aliases: ['royal blue', 'cobalt', 'cobalt blue'] },
  // BLACK vs NAVY: different families entirely (black vs blue), so they can
  // never collapse into each other even loosely.
  { value: 'navy', family: 'blue', aliases: ['navy', 'navy blue', 'midnight blue'] },
  { value: 'purple', family: 'purple', aliases: ['purple'] },
  // Split from `purple`: a pale pastel, commercially distinct from bold
  // "purple." Lilac merges into it as a near-identical retail term.
  { value: 'lavender', family: 'purple', aliases: ['lavender', 'lilac'] },
  { value: 'pink', family: 'pink', aliases: ['pink'] },
  // Split from `pink`: a muted, dusty pink, commercially distinct from a
  // bright/true pink. Rose merges into it as a near-identical retail term
  // (kept as one bounded value rather than proliferating pink shades).
  { value: 'blush', family: 'pink', aliases: ['blush', 'rose', 'dusty rose'] },
  // `print` removed outright (not reassigned) — it names no color.
  { value: 'multicolor', family: 'multicolor', aliases: ['multicolor', 'multi-color', 'multi'] },
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
