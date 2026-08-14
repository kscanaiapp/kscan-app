/**
 * Garment role derivation for Room Intelligence (E4.1).
 *
 * WHY THIS EXISTS: room-level reasoning ("what is missing", "what would you
 * remove", "which piece anchors this") needs to know what STRUCTURAL job each
 * item does, not just its category string. Asking the model to infer that from
 * a free-text category on every turn is both wasteful and non-deterministic —
 * the same room would classify differently between turns, which is exactly what
 * breaks multi-turn continuity.
 *
 * Deliberately DERIVED, never invented. A category the vocabulary does not
 * recognise yields `unknown`, and `unknown` is passed to the model as unknown.
 * Guessing "probably a top" from an unrecognised string would manufacture the
 * false confidence the grounding invariant exists to prevent.
 *
 * This module is pure and shared: stylechat-generate and style-outfit-generate
 * must classify the same room identically, or the composer and the chat would
 * disagree about what the room contains.
 */

export type GarmentRole =
  | 'one_piece'
  | 'top'
  | 'bottom'
  | 'outer_layer'
  | 'footwear'
  | 'accessory'
  | 'unknown';

/**
 * Ordered most-specific first. Order matters: "jumpsuit" must be tested before
 * a generic "suit" substring, and "swim trunks" must not be read as trousers.
 */
const ROLE_VOCABULARY: Array<{ role: GarmentRole; terms: string[] }> = [
  {
    role: 'one_piece',
    terms: [
      'jumpsuit', 'romper', 'playsuit', 'boilersuit', 'overall', 'dungaree',
      'dress', 'gown', 'frock', 'kaftan', 'caftan', 'sundress', 'bodysuit',
      'leotard', 'unitard',
    ],
  },
  {
    role: 'outer_layer',
    terms: [
      'coat', 'overcoat', 'trench', 'parka', 'anorak', 'puffer', 'peacoat',
      'jacket', 'blazer', 'bomber', 'windbreaker', 'raincoat', 'mac',
      'cardigan', 'poncho', 'cape', 'gilet', 'vest jacket', 'shacket',
      'outerwear',
    ],
  },
  {
    role: 'footwear',
    terms: [
      'shoe', 'boot', 'sneaker', 'trainer', 'loafer', 'oxford', 'derby',
      'brogue', 'sandal', 'heel', 'pump', 'stiletto', 'mule', 'clog',
      'espadrille', 'moccasin', 'slipper', 'flip flop', 'flipflop',
      'footwear', 'plimsoll',
    ],
  },
  {
    role: 'bottom',
    terms: [
      'trouser', 'pant', 'jean', 'denim', 'chino', 'short', 'skirt', 'legging',
      'jogger', 'sweatpant', 'culotte', 'capri', 'slack', 'cargo', 'bermuda',
      'bottom',
    ],
  },
  {
    role: 'top',
    terms: [
      'shirt', 'tee', 't-shirt', 'tshirt', 'blouse', 'top', 'sweater',
      'jumper', 'pullover', 'hoodie', 'sweatshirt', 'knit', 'polo', 'tank',
      'camisole', 'cami', 'turtleneck', 'henley', 'tunic', 'crop',
    ],
  },
  {
    role: 'accessory',
    terms: [
      'bag', 'handbag', 'tote', 'clutch', 'backpack', 'purse', 'belt', 'scarf',
      'hat', 'cap', 'beanie', 'glove', 'sunglass', 'glasses', 'watch',
      'jewellery', 'jewelry', 'necklace', 'bracelet', 'earring', 'ring',
      'tie', 'bowtie', 'sock', 'hosiery', 'tights', 'accessory', 'wallet',
      'headband',
    ],
  },
];

function normalize(value: string | null | undefined): string {
  return typeof value === 'string' ? value.toLowerCase().trim() : '';
}

/**
 * Derive the structural role of an item.
 *
 * `subtype` is consulted before `category` because it is the more specific
 * signal when both are present — a category of "outerwear" with a subtype of
 * "gilet" is still an outer layer, but a category of "clothing" with a subtype
 * of "loafer" is footwear and the category alone would have said nothing.
 *
 * NOTE the field name: the identification contract produces `subtype`. The
 * Elise context envelope calls the same value `subcategory`. Callers pass
 * whichever their own contract defines; this module does not care, but it must
 * not be given a value that was never produced.
 */
export function deriveGarmentRole(input: {
  category?: string | null;
  subtype?: string | null;
  title?: string | null;
}): GarmentRole {
  // Title is the weakest signal and is user-controlled, so it is consulted
  // last and only when the structured fields say nothing at all.
  for (const field of [normalize(input.subtype), normalize(input.category), normalize(input.title)]) {
    if (!field) continue;
    const role = classifyField(field);
    if (role !== 'unknown') return role;
  }
  return 'unknown';
}

/**
 * Classify one field by its HEAD NOUN.
 *
 * English compound garment names are head-final: an "oxford shirt" is a shirt,
 * a "shirt dress" is a dress, a "denim jacket" is a jacket. Taking the first
 * vocabulary hit instead got these backwards — "oxford shirt" matched the
 * footwear term "oxford" and classified a shirt as a shoe, which then made the
 * room look like it had footwear and no top.
 *
 * So: match every term, and let the one appearing LATEST in the string win.
 * Ties break on the longer term, which prefers the more specific word.
 */
function classifyField(field: string): GarmentRole {
  let best: { role: GarmentRole; index: number; length: number } | null = null;

  for (const { role, terms } of ROLE_VOCABULARY) {
    for (const term of terms) {
      const index = field.lastIndexOf(term);
      if (index === -1) continue;
      if (
        !best ||
        index > best.index ||
        (index === best.index && term.length > best.length)
      ) {
        best = { role, index, length: term.length };
      }
    }
  }

  return best ? best.role : 'unknown';
}

/**
 * Whether a set of roles can physically form a complete outfit.
 *
 * NOT a completeness rule and deliberately not exposed to the model as one:
 * E4.1 must be able to answer "nothing is missing". This exists so the server
 * can describe what the room structurally HAS, letting the model reason about
 * gaps itself rather than being handed a verdict.
 */
export function roleCoverage(roles: GarmentRole[]): {
  hasUpperBody: boolean;
  hasLowerBody: boolean;
  hasFootwear: boolean;
  counts: Record<GarmentRole, number>;
} {
  const counts: Record<GarmentRole, number> = {
    one_piece: 0, top: 0, bottom: 0, outer_layer: 0,
    footwear: 0, accessory: 0, unknown: 0,
  };
  for (const role of roles) counts[role] += 1;

  return {
    // A one-piece covers both halves on its own, which is why a dress-only
    // room is not "missing a top".
    hasUpperBody: counts.one_piece > 0 || counts.top > 0,
    hasLowerBody: counts.one_piece > 0 || counts.bottom > 0,
    hasFootwear: counts.footwear > 0,
    counts,
  };
}
