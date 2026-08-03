/**
 * Product Match Foundation V1 — identity derivation.
 *
 * Every key here is a pure function of normalized text. No randomness, no
 * clock, no database. Two runs over the same provider output must produce
 * identical keys or the offline benchmark cannot be reproduced and dedupe
 * cannot be reasoned about.
 *
 * The keys are intentionally readable rather than hashed. A `familyKey` of
 * `nike|air-force-1|footwear` can be eyeballed in a failing test or a telemetry
 * row; a 64-character digest cannot, and this phase is going to be debugged
 * from evidence far more often than it is going to be indexed.
 */

/** Characters that carry no identity signal in any of our sources. */
const PUNCTUATION = /[‘’“”'"`´,.;:!?()[\]{}<>+*/\\|@#$%^&~=_]/g;

/** Collapsed to a single space, then to a single hyphen in slugs. */
const WHITESPACE = /\s+/g;

/**
 * Tokens that appear in retailer titles and describe the listing rather than
 * the product. Removing them is what lets "Nike Air Force 1 '07 — Men's Shoes
 * (Sale)" and "Nike Air Force 1 07" resolve to one family.
 *
 * Deliberately conservative: only words that are never part of a model name.
 * `air`, `force`, `low`, `high`, `mid` are NOT here — they are model tokens.
 */
const LISTING_NOISE = new Set([
  'buy', 'shop', 'sale', 'clearance', 'outlet', 'official', 'store', 'online',
  'free', 'shipping', 'new', 'authentic', 'genuine', 'original', 'brand',
  'mens', 'womens', 'unisex', 'adult', 'adults', 'kids', 'youth',
  'size', 'sizes', 'colour', 'color', 'colours', 'colors',
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'in', 'of', 'by', 'to',
]);

/**
 * Colour vocabulary, normalized to a canonical head term.
 *
 * Only colours the scanner and the catalog actually emit. An unrecognized
 * colour is preserved verbatim rather than dropped — an unknown colourway that
 * matches exactly is still evidence, and silently discarding it would weaken
 * real matches to make the table shorter.
 */
const COLOR_SYNONYMS: Record<string, string> = {
  'off white': 'white', 'offwhite': 'white', 'ivory': 'white', 'cream': 'white',
  'triple white': 'white', 'all white': 'white',
  'jet black': 'black', 'triple black': 'black', 'all black': 'black', 'onyx': 'black',
  'charcoal': 'grey', 'gray': 'grey', 'slate': 'grey', 'silver': 'grey', 'heather': 'grey',
  'navy blue': 'navy', 'midnight': 'navy', 'indigo': 'navy',
  'burgundy': 'red', 'maroon': 'red', 'wine': 'red', 'crimson': 'red',
  'tan': 'beige', 'camel': 'beige', 'sand': 'beige', 'khaki': 'beige', 'taupe': 'beige',
  'olive': 'green', 'forest': 'green', 'sage': 'green',
  'blush': 'pink', 'rose': 'pink',
  'gold': 'yellow', 'mustard': 'yellow',
};

/** Lowercase, strip punctuation, collapse whitespace. Never returns null. */
export function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(PUNCTUATION, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** Normalized text as a hyphenated slug. Empty input yields an empty string. */
export function slugify(value: unknown): string {
  const normalized = normalizeText(value).replace(/-+/g, ' ').replace(WHITESPACE, ' ').trim();
  if (!normalized) return '';
  return normalized.replace(WHITESPACE, '-');
}

/** Normalized, noise-stripped tokens. Order preserved, duplicates removed. */
export function contentTokens(value: unknown): string[] {
  const normalized = normalizeText(value).replace(/-/g, ' ');
  if (!normalized) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of normalized.split(' ')) {
    if (!token || LISTING_NOISE.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function normalizeBrand(value: unknown): string | null {
  const slug = slugify(value);
  return slug || null;
}

/**
 * Canonical colour head term, or the normalized input when unrecognized.
 * Returns null only for genuinely absent input.
 */
export function normalizeColor(value: unknown): string | null {
  // Hyphens are word separators here, not content: retailers write "off-white",
  // "off white" and "offwhite" for the same colour, and the synonym table is
  // keyed on the spaced form.
  const normalized = normalizeText(value).replace(/-/g, ' ').replace(WHITESPACE, ' ').trim();
  if (!normalized) return null;
  const mapped = COLOR_SYNONYMS[normalized];
  if (mapped) return mapped;
  // Multi-word colours ("triple white sneaker") — take the longest known phrase.
  for (const [phrase, canonical] of Object.entries(COLOR_SYNONYMS)) {
    if (normalized.includes(phrase)) return canonical;
  }
  const first = normalized.split(' ')[0];
  return first || null;
}

/**
 * Model/style name, derived from a title once the brand is removed.
 *
 * Returns null rather than a guess when nothing distinctive survives. A model
 * of `""` would silently collide every listing of a brand into one family, so
 * "no model" is represented explicitly and handled by `familyKeyOf`.
 */
export function normalizeModel(title: unknown, brand?: string | null): string | null {
  const brandTokens = new Set(contentTokens(brand ?? ''));
  const tokens = contentTokens(title).filter((token) => !brandTokens.has(token));
  if (tokens.length === 0) return null;
  // Model names are short. Taking the leading run keeps "air force 1" and drops
  // the marketing tail that follows it in retailer titles.
  return tokens.slice(0, 4).join('-');
}

/**
 * Canonical product URL: scheme+host+path, with tracking parameters removed.
 *
 * Query parameters are dropped entirely rather than filtered against a
 * denylist. Retailer product pages identify the product in the path; a
 * surviving `?size=10` or `?variant=4471` would split one listing into many,
 * and there is no parameter we currently need to keep.
 */
export function canonicalizeProductUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${host}${path}`;
}

/** Registrable-ish host, used as a retailer fallback label. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const UNKNOWN = 'unknown';

/**
 * Family identity: brand + model + category.
 *
 * When the model is unknown, the family key falls back to the category alone
 * under the brand. That is a real family ("some Nike footwear") and grouping it
 * is correct; what would be wrong is pretending it is a specific model, which
 * is why `ProductFamily.model` stays null and the tier ceiling drops.
 */
export function familyKeyOf(input: {
  brand: string | null;
  model: string | null;
  canonicalCategory: string | null;
}): string {
  const brand = input.brand || UNKNOWN;
  const model = input.model || UNKNOWN;
  const category = slugify(input.canonicalCategory) || UNKNOWN;
  return `${brand}|${model}|${category}`;
}

/**
 * Variant identity: family + colourway, or family + exact id when one exists.
 *
 * An exact identifier wins over colourway because it is strictly more precise:
 * two listings carrying the same SKU are the same variant regardless of how
 * each retailer spells the colour.
 */
export function variantKeyOf(input: {
  familyKey: string;
  colorway: string | null;
  exactProductId: string | null;
}): string {
  if (input.exactProductId) {
    return `${input.familyKey}#id:${slugify(input.exactProductId)}`;
  }
  return `${input.familyKey}#color:${input.colorway || UNKNOWN}`;
}

/**
 * Listing identity: the canonical URL when there is one, otherwise
 * source + provider id. Two sources returning the same canonical URL are one
 * listing — that is the cross-source dedupe signal, and it is exact.
 */
export function listingKeyOf(input: {
  productUrl: string | null;
  source: string;
  providerId: string | null;
}): string {
  if (input.productUrl) return `url:${input.productUrl}`;
  return `src:${input.source}:${slugify(input.providerId) || UNKNOWN}`;
}
