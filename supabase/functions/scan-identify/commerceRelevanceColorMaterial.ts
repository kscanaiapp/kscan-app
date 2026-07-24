/**
 * Color and material certainty helpers (v122).
 * Module-scoped maps — never recreated per request.
 * Display distinctions are preserved; search uses canonical / family terms.
 */

export type ColorCertainty = 'high' | 'moderate' | 'low';

export type ResolvedColor = {
  /** Preserved display label (e.g. navy, ivory, camel). */
  displayColor: string;
  /** Canonical search color (e.g. navy, white, brown). */
  canonicalSearchColor: string;
  /** Broader family for moderate/low certainty expansion. */
  relatedSearchFamily: string;
  certainty: ColorCertainty;
};

export type MaterialCertainty = 'supported' | 'likely' | 'appearance_only' | 'unsupported';

export type ResolvedMaterial = {
  displayMaterial: string;
  searchMaterial: string;
  certainty: MaterialCertainty;
  /** Safe appearance synonym usable only in fallback queries. */
  appearanceSynonym: string;
};

/** Display-preserving family map — module-load constant. */
const COLOR_FAMILY_MAP: ReadonlyMap<string, string> = new Map([
  ['navy', 'blue'],
  ['dark blue', 'blue'],
  ['midnight', 'blue'],
  ['cobalt', 'blue'],
  ['burgundy', 'red'],
  ['oxblood', 'red'],
  ['wine', 'red'],
  ['maroon', 'red'],
  ['ivory', 'white'],
  ['ecru', 'white'],
  ['cream', 'white'],
  ['bone', 'white'],
  ['off-white', 'white'],
  ['off white', 'white'],
  ['camel', 'brown'],
  ['taupe', 'brown'],
  ['tan', 'brown'],
  ['beige', 'brown'],
  ['khaki', 'brown'],
  ['charcoal', 'gray'],
  ['slate', 'gray'],
  ['graphite', 'gray'],
  ['blush', 'pink'],
  ['rose', 'pink'],
  ['magenta', 'pink'],
]);

/** Canonical search forms that remain distinct from family peers. */
const CANONICAL_SEARCH_COLOR: ReadonlyMap<string, string> = new Map([
  ['dark blue', 'navy'],
  ['midnight blue', 'navy'],
  ['navy blue', 'navy'],
  ['off-white', 'ivory'],
  ['off white', 'ivory'],
  ['cream', 'ivory'],
  ['bone', 'ivory'],
  ['grey', 'gray'],
  ['dark gray', 'charcoal'],
  ['dark grey', 'charcoal'],
  ['oxblood', 'oxblood'],
  ['burgundy', 'burgundy'],
  ['wine', 'burgundy'],
  ['maroon', 'burgundy'],
]);

const HIGH_CERTAINTY_COLORS: ReadonlySet<string> = new Set([
  'black', 'white', 'navy', 'red', 'blue', 'green', 'brown', 'gray', 'grey',
  'beige', 'cream', 'ivory', 'pink', 'purple', 'yellow', 'orange', 'gold', 'silver',
  'tan', 'camel', 'burgundy', 'charcoal', 'taupe',
]);

const APPEARANCE_MATERIAL_RE =
  /\b(leather[-\s]?look|leather[-\s]?like|suede[-\s]?like|suede[-\s]?look|faux[-\s]?look|looks?\s+like|appears?\s+to\s+be)\b/i;

const LIKELY_MATERIAL_RE =
  /\b(likely|probably|possibly|appears|seems|maybe)\b/i;

const UNSUPPORTED_MATERIAL_RE =
  /\b(lambskin|calfskin|exotic|genuine\s+crocodile|python|ostrich|designer|luxury)\b/i;

const SUPPORTED_MATERIALS: ReadonlySet<string> = new Set([
  'leather', 'faux leather', 'denim', 'wool', 'wool blend', 'cotton', 'satin',
  'silk', 'linen', 'knit', 'suede', 'acetate', 'canvas', 'nylon', 'polyester',
  'cashmere', 'tweed', 'corduroy', 'velvet', 'chiffon', 'jersey', 'ribbed',
  'cotton canvas', 'metal', 'gold tone', 'silver tone',
]);

const APPEARANCE_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['leather-look', 'faux leather'],
  ['leather look', 'faux leather'],
  ['leather-like', 'faux leather'],
  ['suede-like', 'suede'],
  ['suede like', 'suede'],
  ['suede-look', 'suede'],
]);

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function usable(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = collapseSpaces(v);
  if (!t) return '';
  const lower = t.toLowerCase();
  if (lower === 'unknown' || lower === 'n/a' || lower === 'none' || lower === 'null') return '';
  return t;
}

/**
 * Resolve display/canonical/family/certainty for a color string.
 * Does not convert navy↔black, ivory↔white, camel↔brown for display.
 */
export function resolveColorCertainty(
  rawColor: unknown,
  opts?: { confidenceHint?: number | null },
): ResolvedColor | null {
  const display = usable(rawColor);
  if (!display) return null;
  const lower = display.toLowerCase();

  const canonical = CANONICAL_SEARCH_COLOR.get(lower) ||
    (lower === 'grey' ? 'gray' : lower.split(/[\/,]/)[0]!.trim());

  const family = COLOR_FAMILY_MAP.get(canonical) ||
    COLOR_FAMILY_MAP.get(lower) ||
    canonical;

  let certainty: ColorCertainty = 'moderate';
  if (HIGH_CERTAINTY_COLORS.has(canonical) || HIGH_CERTAINTY_COLORS.has(lower)) {
    certainty = 'high';
  }
  if (
    /\b(ish|approx|approximately|maybe|possibly|appears|seems|uncertain)\b/i.test(lower) ||
    lower.includes('/') ||
    lower.includes(' and ')
  ) {
    certainty = 'low';
  }
  if (typeof opts?.confidenceHint === 'number' && Number.isFinite(opts.confidenceHint)) {
    if (opts.confidenceHint < 0.45) certainty = 'low';
    else if (opts.confidenceHint < 0.65 && certainty === 'high') certainty = 'moderate';
  }

  return {
    displayColor: display,
    canonicalSearchColor: canonical,
    relatedSearchFamily: family,
    certainty,
  };
}

/**
 * Color terms for commerce query construction.
 * High → canonical only
 * Moderate → canonical + optional one family term when distinct and concise
 * Low → family only, or empty when color risks suppressing results
 */
export function colorTermsForQuery(
  resolved: ResolvedColor | null,
  opts?: { omitLowCertainty?: boolean },
): string[] {
  if (!resolved) return [];
  if (resolved.certainty === 'high') {
    return [resolved.canonicalSearchColor];
  }
  if (resolved.certainty === 'moderate') {
    const terms = [resolved.canonicalSearchColor];
    if (
      resolved.relatedSearchFamily &&
      resolved.relatedSearchFamily !== resolved.canonicalSearchColor
    ) {
      // One family expansion term max — only when it adds a useful synonym pair
      // (e.g. oxblood + burgundy family red is represented by keeping oxblood).
      // Prefer keeping the distinctive canonical; add family only for rare tones.
      if (['oxblood', 'burgundy', 'wine', 'ecru', 'taupe', 'charcoal', 'slate'].includes(
        resolved.canonicalSearchColor,
      )) {
        // For oxblood: allow "oxblood burgundy" style by using canonical + a peer tone
        if (resolved.canonicalSearchColor === 'oxblood') terms.push('burgundy');
        else if (resolved.relatedSearchFamily !== resolved.canonicalSearchColor) {
          // keep canonical only for most moderate cases to stay concise
        }
      }
    }
    return terms.slice(0, 2);
  }
  // low certainty
  if (opts?.omitLowCertainty) return [];
  if (resolved.relatedSearchFamily) return [resolved.relatedSearchFamily];
  return [];
}

export function resolveMaterialCertainty(rawMaterial: unknown): ResolvedMaterial | null {
  const display = usable(rawMaterial);
  if (!display) return null;
  const lower = display.toLowerCase();

  if (APPEARANCE_MATERIAL_RE.test(lower) || APPEARANCE_SYNONYMS.has(lower)) {
    const synonym = APPEARANCE_SYNONYMS.get(lower) ||
      (/\bleather\b/i.test(lower) ? 'faux leather' : /\bsuede\b/i.test(lower) ? 'suede' : '');
    return {
      displayMaterial: display,
      searchMaterial: '',
      certainty: 'appearance_only',
      appearanceSynonym: synonym,
    };
  }

  if (UNSUPPORTED_MATERIAL_RE.test(lower) && !/\bfaux\b/i.test(lower)) {
    return {
      displayMaterial: display,
      searchMaterial: '',
      certainty: 'unsupported',
      appearanceSynonym: '',
    };
  }

  if (LIKELY_MATERIAL_RE.test(lower)) {
    const cleaned = collapseSpaces(
      lower.replace(/\b(likely|probably|possibly|appears|seems|maybe|to be)\b/gi, ''),
    );
    return {
      displayMaterial: display,
      searchMaterial: cleaned,
      certainty: 'likely',
      appearanceSynonym: '',
    };
  }

  // Supported factual materials (including faux leather — never invent faux from uncertain leather)
  const isSupported = [...SUPPORTED_MATERIALS].some((m) => lower.includes(m)) ||
    SUPPORTED_MATERIALS.has(lower);

  if (isSupported) {
    // Prefer a concise supported token
    let search = lower;
    if (/\bfaux leather\b/.test(lower) || /\bvegan leather\b/.test(lower)) search = 'faux leather';
    else if (/\bleather\b/.test(lower)) search = 'leather';
    else if (/\bsuede\b/.test(lower)) search = 'suede';
    else if (/\bdenim\b/.test(lower)) search = 'denim';
    else if (/\bcotton canvas\b/.test(lower)) search = 'cotton canvas';
    else if (/\bcanvas\b/.test(lower)) search = 'canvas';
    else if (/\bcotton\b/.test(lower)) search = 'cotton';
    else if (/\bacetate\b/.test(lower)) search = 'acetate';
    else if (/\bwool\b/.test(lower)) search = 'wool';

    return {
      displayMaterial: display,
      searchMaterial: search,
      certainty: 'supported',
      appearanceSynonym: '',
    };
  }

  return {
    displayMaterial: display,
    searchMaterial: '',
    certainty: 'unsupported',
    appearanceSynonym: '',
  };
}

/**
 * Material usage matrix for primary vs fallback queries.
 */
export function materialForQuery(
  resolved: ResolvedMaterial | null,
  phase: 'primary' | 'fallback',
  qualityBand?: 'high' | 'moderate' | 'low' | null,
): string {
  if (!resolved) return '';
  if (resolved.certainty === 'unsupported') return '';
  if (resolved.certainty === 'supported') return resolved.searchMaterial;
  if (resolved.certainty === 'likely') {
    if (phase === 'fallback') return resolved.searchMaterial;
    if (qualityBand === 'high' || qualityBand === 'moderate') return resolved.searchMaterial;
    return '';
  }
  // appearance_only
  if (phase === 'fallback') return resolved.appearanceSynonym || '';
  return '';
}
