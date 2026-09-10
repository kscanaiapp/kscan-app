'use strict';

/**
 * Category + subtype vocabulary.
 *
 * CANONICAL_CATEGORIES matches `tools/real-fashion-corpus/lib/constants.js`
 * `CATEGORIES`, which that lab's own comment documents as "Derived from
 * K Scan's own taxonomy rather than invented" — top, dress, outerwear,
 * footwear, bag, accessory carry over verbatim. The one deliberate change is
 * `pants` -> `bottom`: Scanner's production fixtures
 * (__tests__/fashionIdentificationV2Contract.test.js) use the broader
 * `bottom` for the category slot and put the garment-specific word in
 * `subtype`, which is the split this ontology's category/subtype pair is
 * for. `pants` becomes a subtype of `bottom` instead (see SUBTYPES below),
 * not a category of its own — a canonical category has to hold skirts and
 * shorts too, not only trousers. This rename is recorded as an explicit
 * TRANSFORM in compatibility.js, not silently assumed.
 */
const CANONICAL_CATEGORIES = Object.freeze([
  'top',
  'bottom',
  'dress',
  'outerwear',
  'footwear',
  'bag',
  'accessory',
]);

const CATEGORY_ALIASES = Object.freeze({
  top: 'top',
  tops: 'top',
  bottom: 'bottom',
  bottoms: 'bottom',
  dress: 'dress',
  dresses: 'dress',
  outerwear: 'outerwear',
  'outer wear': 'outerwear',
  footwear: 'footwear',
  shoe: 'footwear',
  shoes: 'footwear',
  bag: 'bag',
  bags: 'bag',
  handbag: 'bag',
  accessory: 'accessory',
  accessories: 'accessory',
});

/**
 * Subtypes, each bound to exactly one parent category. Evidence base:
 * Scanner fixtures ('chore jacket', 'low-top sneaker', 'shirt', 'trouser' —
 * __tests__/fashionIdentificationV2Contract.test.js), the Closet
 * characterization fixture ('Bomber'/'Jacket' —
 * __tests__/closetTaxonomyPreservation.test.js), and CPI's corpus generator
 * vocabulary (tools/canonical-product-identity/lib/fashionWorld.js
 * CATEGORY_STYLES: jacket, dress, boot, sweater).
 *
 * Deliberately modest — V1 does not attempt exhaustive subtype coverage
 * (spec section 4: "not the world's most complete fashion ontology").
 *
 * SEMANTIC HARDENING PASS (before this ontology becomes ground truth for
 * Real Fashion Corpus) — garment-subtype doctrine applied: retail language
 * overlap is not sufficient to treat a garment feature as synonymous with
 * a whole other subtype.
 *
 * SPLIT (were unsafe collapses, now distinct subtypes):
 *   `hoodie` was folded into `sweatshirt` — a hood (and usually a kangaroo
 *   pocket) is a structural difference a shopper cares about, not a retail
 *   naming variant of the same garment. Now its own subtype.
 *   `camisole` was folded into `tank_top` — a camisole (thin straps, no
 *   ribbing, often a layering/lingerie-adjacent piece) is constructed
 *   differently from a tank top (thicker straps, often ribbed, casual/
 *   athletic). Now its own subtype.
 *   `sport coat` was folded into `blazer` — classic menswear distinguishes
 *   them (a blazer is traditionally a solid color with metal buttons; a
 *   sport coat is patterned/tweed and more casual) even though modern
 *   retail sometimes blurs the line. Now its own subtype.
 *
 * RETAINED as justified hard aliases (same base garment, not a different
 * one):
 *   `pump`/`pumps` -> `heel`. A pump does not describe a structurally
 *   different shoe than a heel (every pump IS a heel by definition); it is
 *   a more specific/formal retail name for the same shoe category, unlike
 *   hoodie/sweatshirt which differ in actual construction.
 *   `button-down`/`button-up` -> `shirt`. At the garment-subtype
 *   granularity this ontology models, a button-down shirt is a shirt — the
 *   "button-down" collar detail is a collar-level attribute (parallel to
 *   Scanner's separate `attributes.collar` field), one level more specific
 *   than this V1's seven fields go, not a different base garment.
 *
 * `low-top sneaker`/`high-top sneaker` -> `sneaker`: this collapse stays
 * for V1 per explicit instruction (introducing an ankle-height axis is out
 * of this hardening pass's scope), but the collar-height distinction is
 * NOT silently discarded: `canonicalizeSubtype`'s `raw` field always
 * preserves the exact input string ('low-top sneaker' / 'high-top
 * sneaker'), so a consumer that needs the distinction can still read it
 * off `raw` even though `value` collapses both to `sneaker` — see
 * tests/category.test.js for a test proving this survives. This is a
 * DOCUMENTED information-loss boundary, not an oversight: any consumer
 * matching purely on canonical `value` cannot tell a low-top from a
 * high-top sneaker in V1, only a consumer that also reads `raw` can.
 */
const SUBTYPES = Object.freeze([
  // outerwear
  { value: 'jacket', category: 'outerwear', aliases: ['jacket'] },
  {
    value: 'bomber_jacket',
    category: 'outerwear',
    // The task's own worked example (spec section 8): bomber / bomber jacket
    // / flight jacket name the same garment. A flight jacket (MA-1 style
    // lineage) and a bomber are the same silhouette family in retail usage,
    // so this is genuine normalization, not semantic collapse.
    aliases: ['bomber', 'bomber jacket', 'flight jacket'],
  },
  { value: 'chore_jacket', category: 'outerwear', aliases: ['chore jacket', 'chore coat'] },
  { value: 'moto_jacket', category: 'outerwear', aliases: ['moto jacket', 'motorcycle jacket', 'biker jacket'] },
  { value: 'blazer', category: 'outerwear', aliases: ['blazer'] },
  // Split from `blazer` — see SEMANTIC HARDENING PASS above.
  { value: 'sport_coat', category: 'outerwear', aliases: ['sport coat'] },
  { value: 'coat', category: 'outerwear', aliases: ['coat', 'overcoat'] },
  { value: 'parka', category: 'outerwear', aliases: ['parka'] },
  // top
  // `button-down`/`button-up` retained as a justified alias — see header.
  { value: 'shirt', category: 'top', aliases: ['shirt', 'button-up', 'button up', 'button-down'] },
  { value: 't_shirt', category: 'top', aliases: ['t-shirt', 't shirt', 'tshirt', 'tee'] },
  { value: 'blouse', category: 'top', aliases: ['blouse'] },
  { value: 'sweater', category: 'top', aliases: ['sweater', 'jumper', 'pullover'] },
  { value: 'sweatshirt', category: 'top', aliases: ['sweatshirt'] },
  // Split from `sweatshirt` — see SEMANTIC HARDENING PASS above.
  { value: 'hoodie', category: 'top', aliases: ['hoodie'] },
  { value: 'tank_top', category: 'top', aliases: ['tank top', 'tank'] },
  // Split from `tank_top` — see SEMANTIC HARDENING PASS above.
  { value: 'camisole', category: 'top', aliases: ['camisole'] },
  // bottom
  { value: 'trouser', category: 'bottom', aliases: ['trouser', 'trousers', 'pants', 'slacks'] },
  { value: 'jean', category: 'bottom', aliases: ['jean', 'jeans', 'denim pants'] },
  { value: 'short', category: 'bottom', aliases: ['short', 'shorts'] },
  { value: 'skirt', category: 'bottom', aliases: ['skirt'] },
  // footwear
  // `low-top sneaker`/`high-top sneaker` retained as a documented,
  // information-preserving collapse — see header.
  { value: 'sneaker', category: 'footwear', aliases: ['sneaker', 'sneakers', 'trainer', 'trainers', 'low-top sneaker', 'high-top sneaker'] },
  { value: 'boot', category: 'footwear', aliases: ['boot', 'boots'] },
  { value: 'sandal', category: 'footwear', aliases: ['sandal', 'sandals'] },
  // `pump`/`pumps` retained as a justified alias — see header.
  { value: 'heel', category: 'footwear', aliases: ['heel', 'heels', 'pump', 'pumps'] },
  { value: 'flat', category: 'footwear', aliases: ['flat', 'flats'] },
  // bag
  { value: 'handbag', category: 'bag', aliases: ['handbag', 'purse'] },
  { value: 'tote', category: 'bag', aliases: ['tote', 'tote bag'] },
  { value: 'backpack', category: 'bag', aliases: ['backpack'] },
  { value: 'crossbody', category: 'bag', aliases: ['crossbody', 'crossbody bag'] },
  { value: 'clutch', category: 'bag', aliases: ['clutch'] },
  // accessory
  { value: 'belt', category: 'accessory', aliases: ['belt'] },
  { value: 'scarf', category: 'accessory', aliases: ['scarf'] },
  { value: 'hat', category: 'accessory', aliases: ['hat', 'cap'] },
  { value: 'sunglasses', category: 'accessory', aliases: ['sunglasses'] },
]);

function buildSubtypeAliasMap() {
  const map = Object.create(null);
  for (const subtype of SUBTYPES) {
    // Idempotent: a canonical value always resolves to itself.
    map[subtype.value] = subtype.value;
    for (const alias of subtype.aliases) {
      map[alias] = subtype.value;
    }
  }
  return Object.freeze(map);
}

function buildSubtypeToCategoryMap() {
  const map = Object.create(null);
  for (const subtype of SUBTYPES) {
    map[subtype.value] = subtype.category;
  }
  return Object.freeze(map);
}

const SUBTYPE_ALIASES = buildSubtypeAliasMap();
const SUBTYPE_TO_CATEGORY = buildSubtypeToCategoryMap();

module.exports = {
  CANONICAL_CATEGORIES,
  CATEGORY_ALIASES,
  SUBTYPES,
  SUBTYPE_ALIASES,
  SUBTYPE_TO_CATEGORY,
};
