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
 * `low-top sneaker` folds into the `sneaker` subtype rather than getting its
 * own canonical value: the low/high-top distinction is a cut detail outside
 * this V1's seven fields, and forcing it into a new subtype would overbuild
 * a category this phase has no evidence needs it.
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
  { value: 'blazer', category: 'outerwear', aliases: ['blazer', 'sport coat'] },
  { value: 'coat', category: 'outerwear', aliases: ['coat', 'overcoat'] },
  { value: 'parka', category: 'outerwear', aliases: ['parka'] },
  // top
  { value: 'shirt', category: 'top', aliases: ['shirt', 'button-up', 'button up', 'button-down'] },
  { value: 't_shirt', category: 'top', aliases: ['t-shirt', 't shirt', 'tshirt', 'tee'] },
  { value: 'blouse', category: 'top', aliases: ['blouse'] },
  { value: 'sweater', category: 'top', aliases: ['sweater', 'jumper', 'pullover'] },
  { value: 'sweatshirt', category: 'top', aliases: ['sweatshirt', 'hoodie'] },
  { value: 'tank_top', category: 'top', aliases: ['tank top', 'tank', 'camisole'] },
  // bottom
  { value: 'trouser', category: 'bottom', aliases: ['trouser', 'trousers', 'pants', 'slacks'] },
  { value: 'jean', category: 'bottom', aliases: ['jean', 'jeans', 'denim pants'] },
  { value: 'short', category: 'bottom', aliases: ['short', 'shorts'] },
  { value: 'skirt', category: 'bottom', aliases: ['skirt'] },
  // footwear
  { value: 'sneaker', category: 'footwear', aliases: ['sneaker', 'sneakers', 'trainer', 'trainers', 'low-top sneaker', 'high-top sneaker'] },
  { value: 'boot', category: 'footwear', aliases: ['boot', 'boots'] },
  { value: 'sandal', category: 'footwear', aliases: ['sandal', 'sandals'] },
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
