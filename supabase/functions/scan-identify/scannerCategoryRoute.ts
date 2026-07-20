/**
 * Category-aware prompt routing (v121).
 * Deterministic, side-effect free. Adds zero model calls.
 *
 * Canonical routes: apparel | footwear | bags | accessories | general
 */

import { normalizeCategory } from '../_shared/scanHelpers.ts';

export type ScannerCategoryRoute =
  | 'apparel'
  | 'footwear'
  | 'bags'
  | 'accessories'
  | 'general';

export type ScannerRequestMode =
  | 'multi_item_detection'
  | 'selected_item'
  | 'legacy_single_item'
  | 'text';

/** Catalog / model categories that map into apparel prompt route. */
const APPAREL_CATEGORIES: ReadonlySet<string> = new Set([
  'outerwear',
  'blazer',
  'dress',
  'pants',
  'top',
  'jumpsuit',
  'romper',
  'bodysuit',
  'vest',
  'skirt',
]);

const FOOTWEAR_CATEGORIES: ReadonlySet<string> = new Set(['footwear']);
const BAG_CATEGORIES: ReadonlySet<string> = new Set(['bag']);
const ACCESSORY_CATEGORIES: ReadonlySet<string> = new Set(['accessory']);

const VALID_TAXONOMY_CATEGORIES: ReadonlySet<string> = new Set([
  ...APPAREL_CATEGORIES,
  ...FOOTWEAR_CATEGORIES,
  ...BAG_CATEGORIES,
  ...ACCESSORY_CATEGORIES,
]);

/** TextScan keyword groups — static, case-insensitive whole-word matching. */
const TEXT_KEYWORDS: Readonly<Record<Exclude<ScannerCategoryRoute, 'general'>, readonly string[]>> = {
  apparel: [
    'jacket', 'coat', 'blazer', 'cardigan', 'shirt', 'blouse', 'top', 'sweater',
    'pants', 'jeans', 'trousers', 'skirt', 'dress', 'jumpsuit', 'romper',
    'vest', 'parka', 'bodysuit',
  ],
  footwear: [
    'shoe', 'shoes', 'boot', 'boots', 'sneaker', 'sneakers', 'heel', 'heels',
    'loafer', 'loafers', 'sandal', 'sandals', 'mule', 'mules', 'oxford',
    'ballet flat', 'flats',
  ],
  bags: [
    'bag', 'handbag', 'purse', 'tote', 'backpack', 'clutch', 'satchel',
    'crossbody', 'shoulder bag',
  ],
  accessories: [
    'sunglasses', 'glasses', 'belt', 'scarf', 'hat', 'jewelry', 'jewellery',
    'earring', 'earrings', 'necklace', 'bracelet', 'brooch', 'watch',
  ],
};

const MULTIWORD_KEYWORDS: ReadonlyArray<{ route: Exclude<ScannerCategoryRoute, 'general'>; phrase: string }> = [
  { route: 'footwear', phrase: 'ballet flat' },
  { route: 'bags', phrase: 'shoulder bag' },
];

const SUBTYPE_ROUTE_PATTERNS: ReadonlyArray<{ pattern: RegExp; route: ScannerCategoryRoute }> = [
  { pattern: /\b(moto|biker|bomber|puffer|parka|trench|peacoat|raincoat|windbreaker|anorak|overcoat|blazer|sport\s?coat|suit\s?jacket|dress|gown|skirt|trouser|pants|jeans|chino|jogger|legging|short|culotte|wide-?leg|sweater|hoodie|tee|t-?shirt|blouse|polo|cardigan|tank|shirt|bodysuit|jumpsuit|romper|vest)\b/i, route: 'apparel' },
  { pattern: /\b(sneaker|trainer|loafer|heel|sandal|boot|pump|flat|oxford|mule|slipper|chelsea)\b/i, route: 'footwear' },
  { pattern: /\b(handbag|tote|clutch|backpack|satchel|crossbody|purse|bucket\s?bag|shoulder\s?bag)\b/i, route: 'bags' },
  { pattern: /\b(belt|scarf|hat|cap|sunglass|watch|jewelry|jewellery|earring|necklace|bracelet|brooch)\b/i, route: 'accessories' },
];

const LABEL_ROUTE_PATTERNS = SUBTYPE_ROUTE_PATTERNS;

export type ResolveScannerCategoryRouteInput = {
  requestMode: ScannerRequestMode;
  /** Selected-item candidate evidence (Call 2). */
  selectedCandidate?: {
    category?: string | null;
    subtype?: string | null;
    label?: string | null;
    providerCategory?: string | null;
  } | null;
  /** Legacy single-image optional pre-known evidence (rarely present). */
  knownCategory?: string | null;
  knownSubtype?: string | null;
  /** TextScan query — never logged by this module. */
  textQuery?: string | null;
};

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isGenericToken(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const t = collapseSpaces(value).toLowerCase();
  if (!t) return true;
  return [
    'fashion item', 'clothing', 'apparel', 'unknown', 'item', 'clothes',
    'garment', 'fashion', 'product', 'n/a', 'na', 'none', 'null',
  ].includes(t);
}

/** Map a repository taxonomy category to a prompt route. */
export function categoryToScannerRoute(category: string | null | undefined): ScannerCategoryRoute | null {
  if (!category || typeof category !== 'string') return null;
  const canon = normalizeCategory(category);
  if (!canon || canon === 'NON_FASHION' || isGenericToken(canon)) return null;
  if (APPAREL_CATEGORIES.has(canon)) return 'apparel';
  if (FOOTWEAR_CATEGORIES.has(canon)) return 'footwear';
  if (BAG_CATEGORIES.has(canon)) return 'bags';
  if (ACCESSORY_CATEGORIES.has(canon)) return 'accessories';
  // Preserve additional taxonomy values that normalize to themselves (e.g. bodysuit).
  if (APPAREL_CATEGORIES.has(canon.toLowerCase())) return 'apparel';
  return null;
}

export function isValidTaxonomyCategory(category: string | null | undefined): boolean {
  if (!category || typeof category !== 'string') return false;
  const canon = normalizeCategory(category);
  if (!canon || canon === 'NON_FASHION' || isGenericToken(canon)) return false;
  if (VALID_TAXONOMY_CATEGORIES.has(canon)) return true;
  // Accept additional repository-normalized fashion tokens that are non-generic.
  return canon.length > 1 && canon !== 'unknown';
}

function routeFromSubtype(subtype: string | null | undefined): ScannerCategoryRoute | null {
  if (!subtype || isGenericToken(subtype)) return null;
  for (const row of SUBTYPE_ROUTE_PATTERNS) {
    if (row.pattern.test(subtype)) return row.route;
  }
  const cat = normalizeCategory(subtype);
  return categoryToScannerRoute(cat);
}

function routeFromLabelHeuristic(label: string | null | undefined): ScannerCategoryRoute | null {
  if (!label || isGenericToken(label)) return null;
  for (const row of LABEL_ROUTE_PATTERNS) {
    if (row.pattern.test(label)) return row.route;
  }
  return categoryToScannerRoute(normalizeCategory(label));
}

/**
 * Provider/candidate category is authoritative only when it maps to taxonomy,
 * is structurally valid, and does not conflict with a coherent normalized subtype.
 */
export function isAuthoritativeProviderCategory(
  providerCategory: string | null | undefined,
  subtype: string | null | undefined,
): boolean {
  if (!isValidTaxonomyCategory(providerCategory)) return false;
  const providerRoute = categoryToScannerRoute(providerCategory);
  if (!providerRoute) return false;
  if (!subtype || isGenericToken(subtype)) return true;
  const subtypeRoute = routeFromSubtype(subtype);
  if (!subtypeRoute) return true;
  return providerRoute === subtypeRoute;
}

/**
 * Deterministic TextScan keyword pre-pass.
 * Ambiguous multi-group matches → general. No NLP / no model call.
 */
export function resolveTextScanCategoryRoute(textQuery: string | null | undefined): ScannerCategoryRoute {
  if (!textQuery || typeof textQuery !== 'string') return 'general';
  const text = collapseSpaces(textQuery).toLowerCase();
  if (!text) return 'general';

  const matched = new Set<Exclude<ScannerCategoryRoute, 'general'>>();

  for (const { route, phrase } of MULTIWORD_KEYWORDS) {
    if (text.includes(phrase)) matched.add(route);
  }

  for (const [route, words] of Object.entries(TEXT_KEYWORDS) as Array<
    [Exclude<ScannerCategoryRoute, 'general'>, readonly string[]]
  >) {
    for (const word of words) {
      if (word.includes(' ')) continue; // handled above
      const re = new RegExp(`(?:^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
      if (re.test(text)) {
        matched.add(route);
        break;
      }
    }
  }

  if (matched.size === 1) return [...matched][0]!;
  return 'general';
}

function resolveSelectedItemRoute(
  candidate: NonNullable<ResolveScannerCategoryRouteInput['selectedCandidate']>,
): ScannerCategoryRoute {
  const subtype = candidate.subtype ?? null;
  const providerCat = candidate.providerCategory ?? candidate.category ?? null;

  // 1. Valid provider/candidate category (authoritative when compatible)
  if (isAuthoritativeProviderCategory(providerCat, subtype)) {
    return categoryToScannerRoute(providerCat!) ?? 'general';
  }

  // 2. Normalized subtype mapped to a valid category route
  const fromSubtype = routeFromSubtype(subtype);
  if (fromSubtype) return fromSubtype;

  // 3. Valid model-detected category already present (even if weaker than subtype conflict case)
  if (isValidTaxonomyCategory(candidate.category)) {
    const r = categoryToScannerRoute(candidate.category!);
    if (r) return r;
  }

  // 4. Deterministic label heuristic
  const fromLabel = routeFromLabelHeuristic(candidate.label ?? null);
  if (fromLabel) return fromLabel;

  // 5. general
  return 'general';
}

/**
 * Canonical routing function — deterministic, side-effect free.
 */
export function resolveScannerCategoryRoute(
  input: ResolveScannerCategoryRouteInput,
): ScannerCategoryRoute {
  switch (input.requestMode) {
    case 'multi_item_detection':
      // Call 1: categories not yet reliably known — always general.
      return 'general';
    case 'selected_item':
      if (!input.selectedCandidate) return 'general';
      return resolveSelectedItemRoute(input.selectedCandidate);
    case 'text':
      return resolveTextScanCategoryRoute(input.textQuery);
    case 'legacy_single_item': {
      if (input.knownCategory && isAuthoritativeProviderCategory(input.knownCategory, input.knownSubtype)) {
        return categoryToScannerRoute(input.knownCategory) ?? 'general';
      }
      const fromSub = routeFromSubtype(input.knownSubtype);
      if (fromSub) return fromSub;
      if (isValidTaxonomyCategory(input.knownCategory)) {
        return categoryToScannerRoute(input.knownCategory) ?? 'general';
      }
      return 'general';
    }
    default:
      return 'general';
  }
}

/** Shared brand / schema safety rules appended to every route. */
const ROUTE_SAFETY_FOOTER = `
Shared route safety (mandatory):
- Preserve the exact existing JSON response schema and field names.
- Do not invent unsupported brands, materials, luxury claims, or era claims.
- Brand may be retained only with visible readable wordmark, logo, readable label, or existing high-confidence evidence marker.
- Never infer brand from shape, aesthetic, resemblance, or vibe.
- Prefer "unknown" over speculative specificity.
`;

const ROUTE_INSTRUCTIONS: Readonly<Record<ScannerCategoryRoute, string>> = {
  apparel: `
Category route: apparel
Prioritize: category, subtype, silhouette, fit, length, neckline, sleeve style, waist treatment, closure, material, pattern, dominant color, construction details.
Examples of preferred specificity: cropped double-breasted blazer; high-waisted wide-leg trousers; ribbed mock-neck sweater; midi bias-cut slip dress.
`,
  footwear: `
Category route: footwear
Prioritize: category, subtype, upper material, sole type, heel type, heel height, toe shape, shaft height, closure, dominant color, construction details.
Examples of preferred specificity: low-profile leather sneaker; square-toe ankle boot; block-heel slingback pump; lug-sole Chelsea boot.
`,
  bags: `
Category route: bags
Prioritize: category, shape, size class, carry method, strap type, closure, material, structure, hardware color, dominant color.
Examples of preferred specificity: structured top-handle handbag; small chain-strap shoulder bag; crescent crossbody bag; soft oversized tote.
`,
  accessories: `
Category route: accessories
Prioritize: category, subtype, shape, material, finish, color, pattern, visible construction.
Examples of preferred specificity: rectangular acetate sunglasses; wide leather waist belt; silk square scarf; chunky gold-tone hoop earrings.
`,
  general: `
Category route: general
Preserve existing fashion-specific behavior with conservative specificity.
Identify each distinct fashion item when applicable; assign a normalized category; assign a subtype when supported; avoid speculative brands and unsupported materials.
`,
};

/**
 * Category-specific prompt instructions appended inside the existing model call.
 * Does not change schema or model settings.
 */
export function getCategoryRoutePromptAddendum(route: ScannerCategoryRoute): string {
  return `${ROUTE_INSTRUCTIONS[route] || ROUTE_INSTRUCTIONS.general}${ROUTE_SAFETY_FOOTER}`;
}

export function buildRoutedIdentifyPrompt(basePrompt: string, route: ScannerCategoryRoute): string {
  return `${basePrompt}${getCategoryRoutePromptAddendum(route)}`;
}
