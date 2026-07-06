/**
 * Deterministic scan display title builder.
 *
 * Builds a clean, premium-feeling title from vision and commerce data.
 * - No network calls.
 * - Side-effect free (does not mutate input arrays).
 * - Runs in well under 100ms for typical inputs.
 */

export type BrandConfidence = 'high' | 'medium' | 'low';

export type ScanTitleBuilderInput = {
  /** Raw vision text, e.g. visual_observation or userMessage. */
  rawVisionTitle?: string | null;
  /** Dominant item name from vision (e.g. item_type or subtype). */
  primaryItem?: string | null;
  /** Clean category to display. */
  displayCategory?: string | null;
  /** Dominant color. */
  color?: string | null;
  /** Brand candidate (from Gemini visible text / logo / guess). */
  brand?: string | null;
  /** Pre-computed brand confidence. If omitted, brand is treated as low-confidence. */
  brandConfidence?: BrandConfidence | null;
  /** Fit descriptor from vision. */
  fit?: string | null;
  /** Material guess from vision. */
  material?: string | null;
  /** Style descriptors / tags from vision. */
  styleDescriptors?: string[] | null;
  /** Live commerce products for fallback brand corroboration (read-only). */
  recommendedProducts?: Array<Record<string, unknown>> | null;
};

const SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'nor',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'vs',
  'with',
]);

const FALLBACK_TITLE = 'Fashion Item';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  // Preserve acronyms like "NBA" or mixed-case brand tokens.
  if (/^[A-Z]+$/.test(word) && word.length <= 5) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Title-case a phrase, keeping small words lowercase unless they are first/last.
 */
function titleCase(value: string): string {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return trimmed;
  const words = trimmed.split(' ');
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const isFirstOrLast = index === 0 || index === words.length - 1;
      if (!isFirstOrLast && SMALL_WORDS.has(lower)) {
        return lower;
      }
      return titleCaseWord(word);
    })
    .join(' ');
}

/**
 * Remove trailing "Match" (case-insensitive, whole word), trailing punctuation,
 * duplicated consecutive words, and extra whitespace.
 */
export function cleanRawTitle(value: string): string {
  if (!isNonEmptyString(value)) return '';
  let cleaned = normalizeWhitespace(value);

  // Strip whole-word "Match" anywhere it appears.
  cleaned = cleaned.replace(/\bMatch\b/gi, '');

  // Trim trailing punctuation and whitespace.
  cleaned = cleaned.replace(/[\s.,;:!?-]+$/g, '').trim();

  // Remove duplicated consecutive words (case-insensitive).
  const words = normalizeWhitespace(cleaned).split(' ');
  const deduped: string[] = [];
  for (const word of words) {
    if (
      deduped.length > 0 &&
      word.toLowerCase() === deduped[deduped.length - 1].toLowerCase()
    ) {
      continue;
    }
    deduped.push(word);
  }

  return deduped.join(' ').replace(/[\s.,;:!?-]+$/g, '').trim();
}

function normalizeCategory(value: string): string {
  const cleaned = cleanRawTitle(value);
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  if (lower === 'unknown' || lower === 'non_fashion' || lower === 'non-fashion') return '';
  return titleCase(cleaned);
}

function normalizeColor(value: string): string {
  const cleaned = cleanRawTitle(value);
  if (!cleaned) return '';
  return titleCase(cleaned);
}

function normalizeBrand(value: string): string {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return '';
  return cleaned;
}

function pickStyleDescriptor(
  descriptors: string[] | null | undefined,
  forbiddenWords: Set<string>
): string | null {
  if (!Array.isArray(descriptors)) return null;
  for (const d of descriptors) {
    const raw = isNonEmptyString(d) ? normalizeWhitespace(d) : '';
    if (!raw) continue;
    const lower = raw.toLowerCase();
    const words = lower.split(/\s+/);
    if (words.some((w) => forbiddenWords.has(w))) continue;
    // Avoid unsupported hype adjectives unless explicitly provided by vision.
    return titleCase(raw);
  }
  return null;
}

function buildPhrase(parts: string[]): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const part of parts) {
    if (!isNonEmptyString(part)) continue;
    for (const raw of part.split(/\s+/)) {
      const normalized = raw.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      words.push(raw);
    }
  }
  return words.join(' ');
}

/**
 * Derive brand confidence from image evidence and commerce corroboration.
 *
 * - High: visible brand text/logo, or Gemini brand corroborated by commerce,
 *         or 3+ distinct retailer/provider results with the same brand and no
 *         contradictory Gemini brand.
 * - Medium: commerce suggests a brand but image evidence is unclear.
 * - Low: weak / no evidence.
 *
 * Does not mutate recommendedProducts.
 */
export function deriveBrandConfidence(
  geminiBrand: string | null | undefined,
  logoDetected: boolean | undefined,
  visibleBrandText: string | null | undefined,
  recommendedProducts?: Array<Record<string, unknown>> | null
): { brand: string | null; confidence: BrandConfidence } {
  const imageBrand = geminiBrand || visibleBrandText || null;
  const hasImageEvidence =
    logoDetected === true || isNonEmptyString(visibleBrandText);

  // If Gemini explicitly saw a logo or visible brand text, image evidence is
  // high even if we could not extract the exact brand name.
  if (hasImageEvidence) {
    return { brand: imageBrand, confidence: 'high' };
  }

  // Commerce brand votes from explicit brand fields (top 10 only).
  const votes = new Map<string, Set<string>>();
  const products = Array.isArray(recommendedProducts)
    ? recommendedProducts.slice(0, 10)
    : [];
  for (const p of products) {
    const brandField = p?.brand;
    if (!isNonEmptyString(brandField)) continue;
    const brand = normalizeWhitespace(brandField);
    const retailer =
      (isNonEmptyString(p.retailer) ? p.retailer : undefined) ??
      (isNonEmptyString(p.source) ? p.source : undefined) ??
      'unknown';
    if (!votes.has(brand)) votes.set(brand, new Set());
    votes.get(brand)!.add(retailer);
  }

  // Find the strongest commerce brand by distinct retailer count.
  let topCommerceBrand: string | null = null;
  let topVotes = 0;
  for (const [brand, retailers] of votes) {
    if (retailers.size > topVotes) {
      topVotes = retailers.size;
      topCommerceBrand = brand;
    }
  }

  // Contradiction: if Gemini sees/suggests a brand, commerce cannot override
  // the title brand. Image evidence already returned above, so here Gemini did
  // not have strong image evidence.
  if (imageBrand) {
    if (topCommerceBrand && equalsIgnoreCase(topCommerceBrand, imageBrand)) {
      return { brand: imageBrand, confidence: 'high' };
    }
    // Gemini suggested a brand but commerce does not corroborate: still treat
    // as medium (conservative) rather than forcing it into the title.
    return { brand: imageBrand, confidence: 'medium' };
  }

  if (topCommerceBrand) {
    if (topVotes >= 3) return { brand: topCommerceBrand, confidence: 'high' };
    if (topVotes >= 2) return { brand: topCommerceBrand, confidence: 'medium' };
    return { brand: topCommerceBrand, confidence: 'low' };
  }

  return { brand: null, confidence: 'low' };
}

function equalsIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Build a clean, deterministic scan display title.
 *
 * Priority:
 * 1. High-confidence brand + category + color  → {Color} {Brand} {Category}
 * 2. High-confidence brand + category          → {Brand} {Category}
 * 3. Style descriptor + color + category       → {Style} {Color} {Category}
 * 4. Color + category                          → {Color} {Category}
 * 5. Category only                             → {Category}
 * 6. Cleaned raw vision title
 * 7. Final fallback                            → Fashion Item
 */
export function buildScanTitle(input: ScanTitleBuilderInput): string {
  const category = normalizeCategory(input.displayCategory ?? input.primaryItem ?? '');
  const color = normalizeColor(input.color ?? '');
  const rawTitle = cleanRawTitle(input.rawVisionTitle ?? '');
  const brand = normalizeBrand(input.brand ?? '');
  const brandConfidence = input.brandConfidence ?? 'low';

  const styleDescriptors = Array.isArray(input.styleDescriptors)
    ? input.styleDescriptors
    : null;
  const forbiddenWords = new Set<string>();
  if (color) color.toLowerCase().split(/\s+/).forEach((w) => forbiddenWords.add(w));
  if (category) category.toLowerCase().split(/\s+/).forEach((w) => forbiddenWords.add(w));
  if (brand) forbiddenWords.add(brand.toLowerCase());
  const styleDescriptor = pickStyleDescriptor(styleDescriptors, forbiddenWords);

  // 1. High-confidence brand + color + category.
  if (brand && brandConfidence === 'high' && category && color) {
    return titleCase(buildPhrase([color, brand, category]));
  }

  // 2. High-confidence brand + category.
  if (brand && brandConfidence === 'high' && category) {
    return titleCase(buildPhrase([brand, category]));
  }

  // 3. Style descriptor + color + category.
  if (styleDescriptor && color && category) {
    return titleCase(buildPhrase([styleDescriptor, color, category]));
  }

  // 4. Color + category.
  if (color && category) {
    return titleCase(buildPhrase([color, category]));
  }

  // 5. Category only.
  if (category) {
    return category;
  }

  // 6. Cleaned raw vision title.
  if (rawTitle) {
    return titleCase(rawTitle);
  }

  // 7. Final fallback.
  return FALLBACK_TITLE;
}
