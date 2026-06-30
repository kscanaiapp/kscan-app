/**
 * Deno-safe shared helpers for scan-identify Edge Function.
 * No Node APIs. All imports must be Deno/web standard.
 */

// ── Minimal local type aliases (Edge Function cannot import root types/) ───────

export type MatchConfidenceTier =
  | 'exact_candidate'
  | 'closest_match'
  | 'similar_style'
  | 'discovery_fallback';

export type NormalizedIdentification = {
  visual_observation?: string;
  item_type?: string;
  subtype?: string;
  primary_color?: string;
  secondary_colors?: string[];
  pattern?: string;
  material_estimate?: string;
  silhouette?: string;
  fit?: string;
  length?: string;
  sleeve_length?: string;
  neckline_or_lapel?: string;
  closure?: string;
  distinctive_features?: string[];
  style_tags?: string[];
  occasion_tags?: string[];
  visible_brand_text?: string | null;
  logo_detected?: boolean;
  brand_guess?: string | null;
  confidence_score?: number;
  search_queries?: string[];
  non_fashion?: boolean;
  styling_suggestions?: string[];
  scan_quality_note?: string | null;
  canonicalCategory: string;
  canonicalColor: string;
  canonicalMaterial: string;
  canonicalSilhouette: string;
  normalizedFeatures: string[];
  normalizedStyleTags: string[];
  normalizedSearchQueries: string[];
};

export type RankedScanProduct = Record<string, unknown> & {
  id?: string;
  name?: string;
  title?: string;
  displayName?: string;
  matchScore?: number;
  similarityPercentage?: number;
  confidenceTier?: MatchConfidenceTier;
  matchReasons?: Record<string, number | boolean | string>;
};

export type ScanAuditEvent = {
  event: 'scan_identification_audit';
  scan_id: string;
  timestamp: string;
  status: 'completed' | 'non_fashion' | 'failed';
  normalized_attributes: {
    canonicalCategory: string;
    canonicalColor: string;
    canonicalMaterial: string;
    canonicalSilhouette: string;
  } | null;
  generated_queries: string[];
  top_matched_product_ids: string[];
  highest_similarity_score: number;
  assigned_confidence_tier: MatchConfidenceTier | null;
  latency_ms: number;
  is_non_fashion: boolean;
  error_reason?: string;
};

// ── JSON Parsing ──────────────────────────────────────────────────────────────

export function cleanAiJsonText(raw: string): string {
  let t = raw.trim();
  // Strip markdown fences
  t = t.replace(/^```json\s*/im, '');
  t = t.replace(/^```JSON\s*/im, '');
  t = t.replace(/^```\s*/im, '');
  t = t.replace(/```\s*$/im, '');
  t = t.trim();
  return t;
}

/** Remove trailing commas before } or ] which are invalid JSON but common in
 * loosely-generated model output. */
export function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, '$1');
}

export function safeParseAiJson(raw: string): unknown {
  const cleaned = cleanAiJsonText(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Retry after stripping trailing commas (common model defect).
    try {
      return JSON.parse(stripTrailingCommas(cleaned));
    } catch {
      // Extract first complete JSON object between first { and last }
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const slice = cleaned.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch {
          try {
            return JSON.parse(stripTrailingCommas(slice));
          } catch {
            throw new Error('ai_json_parse_failed');
          }
        }
      }
      throw new Error('ai_json_parse_failed');
    }
  }
}

// ── Normalizers ─────────────────────────────────────────────────────────────────

// Canonical categories present in product_catalog today: outerwear, blazer,
// dress, footwear, bag, accessory. "pants"/"top" have no catalog rows yet but
// are kept so future catalog rows resolve correctly. All patterns are
// plural-tolerant (s?) — the prior version missed "sneakers", "boots",
// "raincoat", "puffer", etc., which produced wrong canonical categories and
// therefore zero catalog matches.
export function normalizeCategory(input?: string | null): string {
  if (!input || typeof input !== 'string') return '';
  const lower = input.toLowerCase().trim();
  if (lower === 'non_fashion' || lower === 'non-fashion') return 'NON_FASHION';
  // Blazer is a distinct catalog category; check before generic outerwear.
  if (/\b(blazers?|suit jackets?|tailored jackets?|sports? coats?|sport coats?)\b/.test(lower)) return 'blazer';
  // Outerwear: jackets, coats, and synonyms.
  if (/\b(jackets?|coats?|outerwear|parkas?|trench(?:\s?coats?)?|puffers?|puffer jackets?|down jackets?|bombers?|bomber jackets?|windbreakers?|overcoats?|peacoats?|pea coats?|anoraks?|raincoats?|rain jackets?)\b/.test(lower)) return 'outerwear';
  // Dress / gown.
  if (/\b(dress(?:es)?|gowns?|sundress(?:es)?|frocks?)\b/.test(lower)) return 'dress';
  // Bottoms — checked before footwear so "bootcut jeans" maps to pants.
  if (/\b(jeans|pants|trousers|slacks|leggings|shorts|chinos|joggers|sweatpants|culottes)\b/.test(lower)) return 'pants';
  // Tops.
  if (/\b(shirts?|blouses?|tops?|tanks?|tank tops?|tees?|t-shirts?|tshirts?|sweaters?|hoodies?|jumpers?|pullovers?|polos?|cardigans?)\b/.test(lower)) return 'top';
  // Footwear (plural-tolerant; "bootcut" already routed to pants above).
  if (/\b(sneakers?|shoes?|boots?|heels?|loafers?|sandals?|pumps?|trainers?|flats?|footwear)\b/.test(lower)) return 'footwear';
  // Bags.
  if (/\b(bags?|handbags?|purses?|totes?|clutch(?:es)?|backpacks?|satchels?|crossbody|cross-body|duffels?|duffles?)\b/.test(lower)) return 'bag';
  // Accessories.
  if (/\b(belts?|jewelry|jewellery|necklaces?|bracelets?|rings?|earrings?|sunglasses|scarf|scarves|hats?|caps?|beanies?|gloves?|watch(?:es)?|ties?|wallets?)\b/.test(lower)) return 'accessory';
  return lower;
}

export function normalizeColor(input?: string | null): string {
  if (!input || typeof input !== 'string') return '';
  const lower = input.toLowerCase().trim();
  if (lower === 'black') return 'black';
  if (lower === 'white') return 'white';
  if (/\b(ivory|cream|bone|off[-\s]?white)\b/.test(lower)) return 'white/cream';
  if (/\b(charcoal|graphite|slate|dark[-\s]?(gray|grey))\b/.test(lower)) return 'gray/charcoal';
  if (/\b(gray|grey)\b/.test(lower)) return 'gray';
  if (lower === 'navy') return 'navy';
  if (/\b(brown|tan|camel|beige|khaki)\b/.test(lower)) return 'brown/tan';
  if (lower === 'gold') return 'gold';
  if (lower === 'silver') return 'silver';
  if (/\b(multicolor|multi|floral|print|patterned)\b/.test(lower)) return 'multicolor';
  return lower;
}

export function normalizeMaterial(input?: string | null): string {
  if (!input || typeof input !== 'string') return '';
  const lower = input.toLowerCase().trim();
  if (/\b(vegan leather|faux leather|pu leather|synthetic leather)\b/.test(lower)) return 'faux leather';
  if (/\b(leather)\b/.test(lower) && !/\b(faux|vegan|pu|synthetic)\b/.test(lower)) return 'leather';
  if (lower === 'denim') return 'denim';
  if (/\b(wool|cashmere|tweed)\b/.test(lower)) return 'wool/wool blend';
  if (lower === 'cotton') return 'cotton';
  if (lower === 'satin') return 'satin';
  if (lower === 'silk') return 'silk';
  if (lower === 'linen') return 'linen';
  if (/\b(knit|ribbed|jersey)\b/.test(lower)) return 'knit';
  if (lower === 'suede') return 'suede';
  return lower;
}

export function normalizeSilhouette(input?: string | null): string {
  if (!input || typeof input !== 'string') return '';
  const lower = input.toLowerCase().trim();
  if (/\b(boxy|oversized|relaxed|loose|oversize)\b/.test(lower)) return 'oversized/relaxed';
  if (/\b(tailored|structured|sharp|fitted blazer)\b/.test(lower)) return 'tailored/structured';
  if (/\b(slim|fitted|bodycon|tight)\b/.test(lower)) return 'fitted';
  if (/\b(a[-\s]?line|aline)\b/.test(lower)) return 'a-line';
  if (lower === 'cropped') return 'cropped';
  if (lower === 'straight') return 'straight';
  if (/\b(flowing|flowy|maxi)\b/.test(lower)) return 'flowing';
  return lower;
}

/**
 * Confidence label calibration (sprint v1):
 *   >= 0.80 -> High, 0.60-0.79 -> Medium, < 0.60 -> Low.
 * A scan-quality note (blurry/dark/far/partial) or an unknown/non-fashion item
 * type can never read as High confidence.
 */
export function deriveConfidenceLabel(
  score: number | undefined,
  opts?: { hasQualityNote?: boolean; itemType?: string | null },
): 'High' | 'Medium' | 'Low' | undefined {
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  let label: 'High' | 'Medium' | 'Low' =
    score >= 0.80 ? 'High' : score >= 0.60 ? 'Medium' : 'Low';
  if (opts?.hasQualityNote && label === 'High') label = 'Medium';
  const it = typeof opts?.itemType === 'string' ? opts.itemType.toLowerCase() : '';
  if (label === 'High' && (it === 'unknown' || it === 'non_fashion' || it === 'non-fashion')) {
    label = 'Medium';
  }
  return label;
}

export function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export function normalizeIdentification(
  input?: Partial<NormalizedIdentification> | null,
): NormalizedIdentification | null {
  if (!input || typeof input !== 'object') return null;
  const src = input as Record<string, unknown>;

  const canonicalCategory = normalizeCategory(src.item_type as string | null);
  const canonicalColor = normalizeColor(src.primary_color as string | null);
  const canonicalMaterial = normalizeMaterial(src.material_estimate as string | null);
  const canonicalSilhouette = normalizeSilhouette(src.silhouette as string | null);

  const normalizedFeatures = normalizeStringArray(src.distinctive_features);
  const normalizedStyleTags = normalizeStringArray(src.style_tags);
  const normalizedSearchQueries = normalizeStringArray(src.search_queries);

  const out: NormalizedIdentification = {
    canonicalCategory,
    canonicalColor,
    canonicalMaterial,
    canonicalSilhouette,
    normalizedFeatures,
    normalizedStyleTags,
    normalizedSearchQueries,
  };

  const safeString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  const vo = safeString(src.visual_observation);
  if (vo) out.visual_observation = vo;
  const it = safeString(src.item_type);
  if (it) out.item_type = it;
  const st = safeString(src.subtype);
  if (st) out.subtype = st;
  const pc = safeString(src.primary_color);
  if (pc) out.primary_color = pc;
  const sc = normalizeStringArray(src.secondary_colors);
  if (sc.length) out.secondary_colors = sc;
  const pat = safeString(src.pattern);
  if (pat) out.pattern = pat;
  const me = safeString(src.material_estimate);
  if (me) out.material_estimate = me;
  const sil = safeString(src.silhouette);
  if (sil) out.silhouette = sil;
  const fit = safeString(src.fit);
  if (fit) out.fit = fit;
  const len = safeString(src.length);
  if (len) out.length = len;
  const sl = safeString(src.sleeve_length);
  if (sl) out.sleeve_length = sl;
  const nl = safeString(src.neckline_or_lapel);
  if (nl) out.neckline_or_lapel = nl;
  const cl = safeString(src.closure);
  if (cl) out.closure = cl;
  const df = normalizeStringArray(src.distinctive_features);
  if (df.length) out.distinctive_features = df;
  const stt = normalizeStringArray(src.style_tags);
  if (stt.length) out.style_tags = stt;
  const ot = normalizeStringArray(src.occasion_tags);
  if (ot.length) out.occasion_tags = ot;
  const vbt = typeof src.visible_brand_text === 'string' || src.visible_brand_text === null
    ? src.visible_brand_text
    : null;
  if (vbt !== undefined) out.visible_brand_text = vbt;
  const lg = typeof src.logo_detected === 'boolean' ? src.logo_detected : false;
  out.logo_detected = lg;
  const bg = typeof src.brand_guess === 'string' || src.brand_guess === null
    ? src.brand_guess
    : null;
  if (bg !== undefined) out.brand_guess = bg;
  const conf = typeof src.confidence_score === 'number' ? src.confidence_score : typeof src.confidence_score === 'string' ? Number(src.confidence_score) : 0;
  out.confidence_score = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0;
  const sq = normalizeStringArray(src.search_queries);
  if (sq.length) out.search_queries = sq;
  const nf = typeof src.non_fashion === 'boolean' ? src.non_fashion : false;
  out.non_fashion = nf;
  const ss = normalizeStringArray(src.styling_suggestions);
  if (ss.length) out.styling_suggestions = ss;
  const sqn = typeof src.scan_quality_note === 'string' || src.scan_quality_note === null
    ? src.scan_quality_note
    : null;
  if (sqn !== undefined) out.scan_quality_note = sqn;

  return out;
}

// ── Silhouette token overlap helper ─────────────────────────────────────────────

function canonicalSilhouetteTokensOverlap(productSilhouette?: string, canonicalSilhouette?: string): boolean {
  if (!productSilhouette || !canonicalSilhouette) return false;
  const pTokens = productSilhouette.toLowerCase().split(/[\s\/]+/).filter(Boolean);
  const cTokens = canonicalSilhouette.toLowerCase().split(/[\s\/]+/).filter(Boolean);
  if (pTokens.length === 0 || cTokens.length === 0) return false;
  return pTokens.some((pt) => cTokens.includes(pt)) || cTokens.some((ct) => pTokens.includes(ct));
}

// ── Legacy Attributes Derivation ────────────────────────────────────────────────

export function deriveLegacyAttributesFromIdentification(
  identification: NormalizedIdentification | null | undefined,
): Record<string, unknown> | undefined {
  if (!identification) return undefined;
  const out: Record<string, unknown> = {};

  const itemType = identification.item_type || 'unknown';
  const subtype = identification.subtype || itemType;
  out.category = itemType;
  out.itemType = subtype;

  out.silhouette = identification.silhouette || 'unknown';

  const colors: string[] = [];
  if (identification.primary_color) colors.push(identification.primary_color);
  if (identification.secondary_colors?.length) colors.push(...identification.secondary_colors);
  out.colorPalette = colors.filter(Boolean);

  out.materialEstimate = identification.material_estimate || 'unknown';
  out.pattern = identification.pattern || 'unknown';
  out.texture = identification.material_estimate || 'unknown';
  out.styleTags = identification.style_tags?.length ? identification.style_tags : [];
  out.occasion = identification.occasion_tags?.length ? identification.occasion_tags[0] : 'unknown';
  out.confidenceScore = identification.confidence_score ?? 0;

  return out;
}

export function ensureLegacyAttributes(response: Record<string, unknown>): Record<string, unknown> {
  const status = typeof response.status === 'string' ? response.status : '';
  let attrs = response.attributes;
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || Object.keys(attrs).length === 0) {
    // Derive from identification if present
    const idRaw = response.identification;
    const normalizedId = idRaw && typeof idRaw === 'object' && !Array.isArray(idRaw)
      ? normalizeIdentification(idRaw as Record<string, unknown>)
      : null;
    if (normalizedId) {
      attrs = deriveLegacyAttributesFromIdentification(normalizedId);
    }
  }

  if (status === 'non_fashion' || (!attrs || Object.keys(attrs as object).length === 0)) {
    const safeAttrs: Record<string, unknown> = {
      category: 'unknown',
      itemType: 'NON_FASHION',
      silhouette: 'unknown',
      colorPalette: [],
      materialEstimate: 'unknown',
      pattern: 'unknown',
      texture: 'unknown',
      styleTags: [],
      occasion: 'unknown',
      confidenceScore: 0.95,
    };
    if (status === 'completed' && attrs && Object.keys(attrs as object).length > 0) {
      return { ...response, attributes: attrs };
    }
    return { ...response, attributes: safeAttrs };
  }

  return { ...response, attributes: attrs };
}

// ── Ranking ─────────────────────────────────────────────────────────────────────

function scoreRecommendedProduct(
  product: Record<string, unknown>,
  normalizedIdentification: NormalizedIdentification | null,
): { score: number; reasons: Record<string, number | boolean | string> } {
  if (!normalizedIdentification) return { score: 0, reasons: {} };
  let score = 0;
  const reasons: Record<string, number | boolean | string> = {};

  const pCat = typeof product.category === 'string' ? product.category : '';
  const pItemType = typeof product.itemType === 'string' ? product.itemType : '';
  const pTags = normalizeStringArray(product.tags);
  const pStyleTags = normalizeStringArray(product.styleTags);
  const pBrand = typeof product.brand === 'string' ? product.brand : '';
  const pName = typeof product.name === 'string' ? product.name : '';
  const pTitle = typeof product.title === 'string' ? product.title : '';
  const pDisplay = typeof product.displayName === 'string' ? product.displayName : '';
  const pColor = typeof product.color === 'string' ? product.color : '';
  const pColorPalette = normalizeStringArray(product.colorPalette);
  const allText = `${pCat} ${pItemType} ${pTags.join(' ')} ${pStyleTags.join(' ')} ${pBrand} ${pName} ${pTitle} ${pDisplay} ${pColor} ${pColorPalette.join(' ')}`.toLowerCase();

  // Category match (0.35)
  const catMatch = normalizedIdentification.canonicalCategory &&
    (allText.includes(normalizedIdentification.canonicalCategory) ||
      pCat.toLowerCase() === normalizedIdentification.canonicalCategory ||
      pItemType.toLowerCase() === normalizedIdentification.canonicalCategory);
  if (catMatch) {
    score += 0.35;
    reasons.category_match = true;
  }

  // Color match (0.20)
  const colorMatch = normalizedIdentification.canonicalColor &&
    (allText.includes(normalizedIdentification.canonicalColor) ||
      normalizedIdentification.canonicalColor.split('/').some((c) => allText.includes(c.trim())));
  if (colorMatch) {
    score += 0.20;
    reasons.color_match = true;
  }

  // Distinctive feature overlap (0.15)
  const features = normalizedIdentification.normalizedFeatures;
  const featureOverlap = features.length > 0 && features.some((f) => allText.includes(f.toLowerCase()));
  if (featureOverlap) {
    score += 0.15;
    reasons.feature_overlap = true;
  }

  // Silhouette/fit match (0.10)
  const pSil = typeof product.silhouette === 'string' ? product.silhouette : '';
  const pFit = typeof product.fit === 'string' ? product.fit : '';
  const silMatch = canonicalSilhouetteTokensOverlap(pSil, normalizedIdentification.canonicalSilhouette) ||
    canonicalSilhouetteTokensOverlap(pFit, normalizedIdentification.canonicalSilhouette);
  if (silMatch) {
    score += 0.10;
    reasons.silhouette_match = true;
  }

  // Material match (0.08)
  const pMat = typeof product.material === 'string' ? product.material : '';
  const pMatEst = typeof product.materialEstimate === 'string' ? product.materialEstimate : '';
  const matText = `${pMat} ${pMatEst}`.toLowerCase();
  const matMatch = normalizedIdentification.canonicalMaterial &&
    matText.includes(normalizedIdentification.canonicalMaterial);
  if (matMatch) {
    score += 0.08;
    reasons.material_match = true;
  }

  // Style tag match (0.07)
  const styleOverlap = normalizedIdentification.normalizedStyleTags.length > 0 &&
    normalizedIdentification.normalizedStyleTags.some((st) => pStyleTags.includes(st) || pTags.includes(st));
  if (styleOverlap) {
    score += 0.07;
    reasons.style_match = true;
  }

  // Product has image AND purchase URL (0.03)
  const hasImage = !!(product.imageUrl || product.image_url);
  const hasUrl = !!(product.purchaseUrl || product.purchase_url || product.url);
  if (hasImage && hasUrl) {
    score += 0.03;
    reasons.has_image_and_url = true;
  }

  // Product appears available/in stock (0.02)
  const inStock = product.availability === 'in stock' || product.inStock === true || product.in_stock === true;
  if (inStock) {
    score += 0.02;
    reasons.in_stock = true;
  }

  return { score: Math.min(1.0, score), reasons };
}

export function rankRecommendedProducts(
  products: unknown[],
  normalizedIdentification: NormalizedIdentification | null,
): RankedScanProduct[] {
  if (!Array.isArray(products) || products.length === 0 || !normalizedIdentification) {
    return [];
  }

  const scored = products.map((p) => {
    const product = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    const { score, reasons } = scoreRecommendedProduct(product, normalizedIdentification);
    const id = typeof product.id === 'string' ? product.id : undefined;
    const name = typeof product.name === 'string' ? product.name : undefined;
    const title = typeof product.title === 'string' ? product.title : undefined;
    const displayName = name || title || id || 'Product';

    let confidenceTier: MatchConfidenceTier = 'discovery_fallback';
    const hasBrandEvidence = !!(
      normalizedIdentification.visible_brand_text &&
      typeof normalizedIdentification.visible_brand_text === 'string' &&
      normalizedIdentification.visible_brand_text.trim().length > 0
    ) || normalizedIdentification.logo_detected === true;

    if (score >= 0.90 && hasBrandEvidence) {
      confidenceTier = 'exact_candidate';
    } else if (score >= 0.75) {
      confidenceTier = 'closest_match';
    } else if (score >= 0.55) {
      confidenceTier = 'similar_style';
    } else {
      confidenceTier = 'discovery_fallback';
    }

    return {
      ...product,
      displayName,
      matchScore: score,
      similarityPercentage: Math.round(score * 100),
      confidenceTier,
      matchReasons: reasons,
    } as RankedScanProduct;
  });

  scored.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  return scored;
}

// ── Audit Logging ─────────────────────────────────────────────────────────────

export function logScanIdentificationAudit(event: ScanAuditEvent): void {
  try {
    console.info(JSON.stringify(event));
  } catch {
    // Logging must never throw
  }
}

export function buildAuditEvent(
  response: Record<string, unknown>,
  normalizedIdentification: NormalizedIdentification | null,
  rankedProducts: RankedScanProduct[],
  latencyMs: number,
  scanId?: string,
): ScanAuditEvent {
  const status = typeof response.status === 'string' ? response.status : 'failed';
  const isNonFashion = status === 'non_fashion';
  const id = scanId || (typeof response.scanId === 'string' ? response.scanId : crypto.randomUUID());

  const topIds = rankedProducts
    .slice(0, 5)
    .map((p) => p.id)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);

  const highestScore = rankedProducts.length > 0 ? (rankedProducts[0].matchScore ?? 0) : 0;
  const topTier = rankedProducts.length > 0 ? (rankedProducts[0].confidenceTier ?? null) : null;

  const normalizedAttributes = normalizedIdentification
    ? {
        canonicalCategory: normalizedIdentification.canonicalCategory,
        canonicalColor: normalizedIdentification.canonicalColor,
        canonicalMaterial: normalizedIdentification.canonicalMaterial,
        canonicalSilhouette: normalizedIdentification.canonicalSilhouette,
      }
    : null;

  const generatedQueries = normalizedIdentification?.normalizedSearchQueries ?? [];

  return {
    event: 'scan_identification_audit',
    scan_id: id,
    timestamp: new Date().toISOString(),
    status: status as 'completed' | 'non_fashion' | 'failed',
    normalized_attributes: normalizedAttributes,
    generated_queries: generatedQueries,
    top_matched_product_ids: topIds,
    highest_similarity_score: highestScore,
    assigned_confidence_tier: topTier,
    latency_ms: latencyMs,
    is_non_fashion: isNonFashion,
  };
}
