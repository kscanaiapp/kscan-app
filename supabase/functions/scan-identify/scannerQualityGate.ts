/**
 * Deterministic internal quality + consistency gate (v121).
 * Runs after model parsing and v120 normalization.
 * Does not expose quality score as a required client field.
 */

import {
  normalizeCategory,
  normalizeColor,
  normalizeMaterial,
  normalizeSilhouette,
} from '../_shared/scanHelpers.ts';
import { isGenericFashionLabel } from './qualityTuneNormalize.ts';

// ── Score weights (named constants) ──────────────────────────────────────────

export const SCORE_VALID_CATEGORY = 25;
export const SCORE_VALID_SUBTYPE = 20;
export const SCORE_DOMINANT_COLOR = 10;
export const SCORE_MATERIAL_SUPPORTED = 10;
export const SCORE_SILHOUETTE = 10;
export const SCORE_FIT_DETAIL = 5;
export const SCORE_PATTERN = 5;
export const SCORE_CATEGORY_SUBTYPE_COMPATIBLE = 10;
export const SCORE_SPECIFIC_LABEL = 5;

export const PENALTY_GENERIC_LABEL = -25;
export const PENALTY_CATEGORY_SUBTYPE_CONFLICT = -30;
export const PENALTY_UNSUPPORTED_BRAND = -20;
export const PENALTY_UNSUPPORTED_MATERIAL = -10;
export const PENALTY_DUPLICATE_DESCRIPTORS = -5;
export const PENALTY_MALFORMED_FIELD = -10;
export const PENALTY_EXCESSIVELY_VERBOSE = -5;
export const PENALTY_MISSING_CATEGORY_SUBTYPE = -30;

export const QUALITY_SCORE_HIGH_THRESHOLD = 80;
export const QUALITY_SCORE_MODERATE_THRESHOLD = 60;

export type QualityScoreBand = 'high' | 'moderate' | 'low';
export type CommerceQueryDetailLevel = 'specific' | 'moderate' | 'broad';

export type ConsistencyConflict = {
  code: string;
  field: string;
};

export type QualityGateResult = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  qualityScore: number;
  qualityBand: QualityScoreBand;
  consistencyConflicts: ConsistencyConflict[];
  suppressedAttributes: string[];
  label: string;
  commerceQueryDetailLevel: CommerceQueryDetailLevel;
  brandSuppressed: boolean;
  materialSuppressed: boolean;
};

/** Static O(1) subtype families accepted per catalog category — module-load init. */
const COMPATIBLE_SUBTYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  outerwear: new Set([
    'jacket', 'moto jacket', 'biker jacket', 'motorcycle jacket', 'bomber', 'bomber jacket',
    'puffer', 'parka', 'trench', 'trench coat', 'coat', 'raincoat', 'windbreaker', 'anorak',
    'overcoat', 'peacoat', 'vest',
  ]),
  blazer: new Set([
    'blazer', 'sport coat', 'sportcoat', 'suit jacket', 'double-breasted blazer',
  ]),
  dress: new Set([
    'dress', 'slip dress', 'midi dress', 'maxi dress', 'gown', 'sundress',
    'pleated skirt', 'skirt', 'midi skirt', 'mini skirt', 'maxi skirt',
  ]),
  pants: new Set([
    'pants', 'trousers', 'wide-leg trousers', 'wide leg trousers', 'jeans', 'chino',
    'jogger', 'legging', 'shorts', 'culotte', 'straight-leg trousers',
  ]),
  top: new Set([
    'top', 'shirt', 'blouse', 'sweater', 'knit sweater', 't-shirt', 'tee', 'hoodie',
    'polo', 'cardigan', 'tank', 'bodysuit', 'jumpsuit', 'romper',
  ]),
  footwear: new Set([
    'sneakers', 'sneaker', 'boots', 'boot', 'ankle boots', 'chelsea boot', 'heels',
    'heel', 'loafers', 'loafer', 'sandals', 'sandal', 'oxfords', 'oxford', 'mules',
    'mule', 'ballet flats', 'ballet flat', 'flats', 'pumps', 'pump', 'slippers',
    'slingback pump', 'low-profile sneaker',
  ]),
  bag: new Set([
    'handbag', 'tote', 'crossbody', 'clutch', 'backpack', 'shoulder bag', 'satchel',
    'bucket bag', 'purse',
  ]),
  accessory: new Set([
    'belt', 'scarf', 'sunglasses', 'hat', 'jewelry', 'earrings', 'earring',
    'necklace', 'bracelet', 'brooch', 'watch', 'cap',
  ]),
};

/** Category → attribute fields that are incompatible (suppress attribute only). */
const INCOMPATIBLE_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  bag: new Set(['neckline_or_lapel', 'sleeve_length', 'fit', 'shaft_height', 'heel_type', 'heel_height', 'toe_shape']),
  footwear: new Set(['neckline_or_lapel', 'sleeve_length', 'waist_treatment']),
  accessory: new Set(['sleeve_length', 'shaft_height', 'heel_type', 'heel_height', 'toe_shape', 'fit']),
  blazer: new Set(['shaft_height', 'heel_type', 'heel_height', 'toe_shape', 'sole_type']),
  outerwear: new Set(['shaft_height', 'heel_type', 'heel_height', 'toe_shape']),
  dress: new Set(['shaft_height', 'heel_type', 'heel_height', 'toe_shape', 'sole_type']),
  pants: new Set(['shaft_height', 'heel_type', 'heel_height', 'toe_shape', 'neckline_or_lapel', 'sleeve_length']),
  top: new Set(['shaft_height', 'heel_type', 'heel_height', 'toe_shape', 'sole_type']),
};

const SUPPORTED_MATERIALS: ReadonlySet<string> = new Set([
  'leather', 'faux leather', 'denim', 'wool/wool blend', 'wool', 'cotton', 'satin',
  'silk', 'linen', 'knit', 'suede', 'acetate', 'canvas', 'nylon', 'polyester',
  'cashmere', 'tweed', 'corduroy', 'velvet', 'chiffon', 'jersey', 'ribbed',
]);

const SPECULATIVE_MATERIAL_RE =
  /\b(possibly|appears to be|looks like|maybe|probably|designer-looking|luxury|lambskin|vintage-inspired|inspired)\b/i;

const SPECULATIVE_BRAND_RE =
  /\b(style|inspired|looking|esque|-like|designer|luxury|miumiu|miu\s*miu)\b/i;

const LUXURY_FILLER_RE =
  /\b(luxury|designer|vintage|inspired|minimalist|aesthetic|vibes|boyfriend|high-end|premium)\b/i;

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function qualityBandFromScore(score: number): QualityScoreBand {
  if (score >= QUALITY_SCORE_HIGH_THRESHOLD) return 'high';
  if (score >= QUALITY_SCORE_MODERATE_THRESHOLD) return 'moderate';
  return 'low';
}

export function detailLevelFromBand(band: QualityScoreBand): CommerceQueryDetailLevel {
  if (band === 'high') return 'specific';
  if (band === 'moderate') return 'moderate';
  return 'broad';
}

function hasBrandEvidence(id: Record<string, unknown>): boolean {
  if (id.logo_detected === true) return true;
  if (typeof id.visible_brand_text === 'string' && collapseSpaces(id.visible_brand_text).length > 0) {
    return true;
  }
  return false;
}

function isSupportedMaterial(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const t = collapseSpaces(raw);
  if (!t || isGenericFashionLabel(t)) return false;
  if (SPECULATIVE_MATERIAL_RE.test(t)) return false;
  const canon = normalizeMaterial(t);
  if (!canon || isGenericFashionLabel(canon)) return false;
  if (SUPPORTED_MATERIALS.has(canon)) return true;
  // Allow other concrete non-speculative materials from repository normalizer
  return canon.length >= 3 && !SPECULATIVE_MATERIAL_RE.test(canon);
}

function isMalformedStringField(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false;
  return typeof v !== 'string';
}

function countDuplicateDescriptors(id: Record<string, unknown>): number {
  const bags: string[][] = [];
  for (const field of ['distinctive_features', 'style_tags', 'secondary_colors', 'search_queries']) {
    const arr = id[field];
    if (!Array.isArray(arr)) continue;
    const seen = new Set<string>();
    let dups = 0;
    for (const entry of arr) {
      if (typeof entry !== 'string') continue;
      const key = collapseSpaces(entry).toLowerCase();
      if (!key) continue;
      if (seen.has(key)) dups += 1;
      else seen.add(key);
    }
    bags.push([String(dups)]);
  }
  // Also detect stacked duplicate tokens in subtype/label-like strings
  let total = 0;
  for (const b of bags) total += Number(b[0] || 0);
  const subtype = typeof id.subtype === 'string' ? id.subtype : '';
  const words = collapseSpaces(subtype).toLowerCase().split(' ').filter(Boolean);
  const seenW = new Set<string>();
  for (const w of words) {
    if (seenW.has(w)) total += 1;
    else seenW.add(w);
  }
  return total;
}

function subtypeCompatible(category: string, subtype: string): boolean {
  const cat = normalizeCategory(category);
  if (!cat || cat === 'NON_FASHION') return false;
  const key = collapseSpaces(subtype).toLowerCase();
  if (!key || isGenericFashionLabel(key)) return false;
  const allowed = COMPATIBLE_SUBTYPES[cat];
  if (!allowed) {
    // Unknown taxonomy category — do not strip merely for missing sample map.
    // Accept when subtype normalizes to same family via normalizeCategory.
    const subCat = normalizeCategory(subtype);
    return !subCat || subCat === cat || subCat === 'NON_FASHION';
  }
  if (allowed.has(key)) return true;
  // Soft match: any allowed token appears in subtype or vice versa
  for (const a of allowed) {
    if (key.includes(a) || a.includes(key)) return true;
  }
  const subCat = normalizeCategory(subtype);
  return subCat === cat;
}

/**
 * Whether a broader taxonomy label and a narrower one under it contradict.
 *
 * EXPORTED FOR PHASE 7.1 (identification recheck) rather than reimplemented
 * there. The recheck's hierarchy validation needs exactly this predicate over
 * two tier pairs — category↔clothingType and clothingType↔subtype — and a
 * second copy of the rule is precisely how the two would drift into disagreeing
 * about what a coherent garment identity is. The parameter names still read
 * `category`/`subtype` because the rule is about broader-vs-narrower, not about
 * which of the three named tiers is being compared.
 *
 * Deliberately NOT a new fashion ontology: it reuses the COMPATIBLE_SUBTYPES
 * families and `normalizeCategory` that this gate already ships.
 */
export function categorySubtypeConflict(category: string, subtype: string): boolean {
  if (!category || !subtype) return false;
  if (isGenericFashionLabel(category) || isGenericFashionLabel(subtype)) return false;
  if (subtypeCompatible(category, subtype)) return false;
  const cat = normalizeCategory(category);
  const subCat = normalizeCategory(subtype);
  if (subCat && subCat !== 'NON_FASHION' && cat && subCat !== cat) return true;
  // Explicit hostile pairs
  if (/skirt/i.test(category) && /\b(trouser|pants|jeans)\b/i.test(subtype)) return true;
  if (/\b(sneaker|trainer)\b/i.test(subtype) && /\b(stiletto|heel)\b/i.test(subtype) && /sneaker/i.test(subtype)) {
    // sneaker + stiletto heel as combined subtype
    if (/\bstiletto\b/i.test(subtype)) return true;
  }
  if (cat === 'footwear' && /\b(stiletto)\b/i.test(subtype) && /\b(sneaker|trainer)\b/i.test(subtype)) {
    return true;
  }
  return !subtypeCompatible(category, subtype);
}

function usable(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = collapseSpaces(v);
  if (!t || isGenericFashionLabel(t)) return '';
  if (/^(unknown|n\/a|none|null)$/i.test(t)) return '';
  return t;
}

function titleCaseLabel(parts: string[]): string {
  return parts
    .map((p) =>
      p
        .split(' ')
        .filter(Boolean)
        .map((w) => (w.includes('-')
          ? w.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join('-')
          : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
        .join(' ')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulWordCount(s: string): number {
  return collapseSpaces(s).split(' ').filter((w) => w && !/^(and|the|a|an|of|with|in|for)$/i.test(w)).length;
}

/**
 * Build a concise result label (≈8 meaningful words max).
 */
export function buildQualityResultLabel(
  id: Record<string, unknown>,
  band: QualityScoreBand,
): string {
  const color = usable(id.primary_color);
  const subtype = usable(id.subtype);
  const category = usable(id.item_type);
  const material = band === 'high' ? usable(id.material_estimate) : '';
  const silhouette = band === 'high' ? usable(id.silhouette) : band === 'moderate' ? '' : '';
  const silMod = band === 'moderate' ? usable(id.silhouette) : silhouette;

  let parts: string[] = [];
  if (band === 'high') {
    parts = [silMod, color, material, subtype || category].filter(Boolean) as string[];
  } else if (band === 'moderate') {
    parts = [color, subtype || category].filter(Boolean) as string[];
    if (silMod && meaningfulWordCount(parts.join(' ')) < 6) parts = [silMod, ...parts];
  } else {
    parts = [color, category || (subtype && subtypeCompatible(String(category || ''), subtype) ? subtype : category)]
      .filter(Boolean) as string[];
    if (!parts.length && subtype) parts = [subtype];
  }

  let label = titleCaseLabel(parts);
  // Strip luxury filler
  label = label.replace(LUXURY_FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
  const words = label.split(' ').filter(Boolean);
  if (words.length > 8) {
    // Prefer keeping trailing garment term — trim from middle filler
    label = [...words.slice(0, 3), ...words.slice(-5)].slice(0, 8).join(' ');
  }
  return label || titleCaseLabel([subtype || category || 'Fashion Item'].filter(Boolean));
}

/**
 * Apply consistency validation + attribute suppression, then score.
 */
export function applyScannerQualityGate(
  identificationIn: Record<string, unknown> | null | undefined,
  attributesIn?: Record<string, unknown> | null,
): QualityGateResult {
  const identification: Record<string, unknown> = identificationIn && typeof identificationIn === 'object'
    ? { ...identificationIn }
    : {};
  const attributes: Record<string, unknown> | undefined = attributesIn && typeof attributesIn === 'object'
    ? { ...attributesIn }
    : undefined;

  const conflicts: ConsistencyConflict[] = [];
  const suppressed: string[] = [];
  let brandSuppressed = false;
  let materialSuppressed = false;
  let malformed = false;
  let duplicateCount = 0;

  for (const field of [
    'item_type', 'subtype', 'primary_color', 'pattern', 'material_estimate',
    'silhouette', 'fit', 'length', 'sleeve_length', 'neckline_or_lapel', 'closure',
  ]) {
    if (isMalformedStringField(identification[field])) {
      identification[field] = '';
      malformed = true;
      suppressed.push(field);
    }
  }

  for (const field of ['distinctive_features', 'style_tags', 'secondary_colors', 'search_queries']) {
    if (identification[field] != null && !Array.isArray(identification[field])) {
      identification[field] = [];
      malformed = true;
      suppressed.push(field);
    }
  }

  duplicateCount = countDuplicateDescriptors(identification);

  const categoryRaw = typeof identification.item_type === 'string' ? identification.item_type : '';
  const subtypeRaw = typeof identification.subtype === 'string' ? identification.subtype : '';
  const canonCat = normalizeCategory(categoryRaw);

  // Category / subtype conflict → suppress subtype, keep category
  if (categoryRaw && subtypeRaw && categorySubtypeConflict(categoryRaw, subtypeRaw)) {
    conflicts.push({ code: 'category_subtype_conflict', field: 'subtype' });
    identification.subtype = '';
    suppressed.push('subtype');
  }

  // Category-specific incompatible attributes
  const incompat = canonCat ? INCOMPATIBLE_ATTRIBUTES[canonCat] : undefined;
  if (incompat) {
    for (const field of incompat) {
      const v = identification[field];
      if (typeof v === 'string' && collapseSpaces(v) && !/^(unknown|n\/a|none)$/i.test(v)) {
        identification[field] = '';
        suppressed.push(field);
        conflicts.push({ code: 'incompatible_attribute', field });
      }
    }
  }

  // Brand without evidence
  const brandGuess = typeof identification.brand_guess === 'string'
    ? collapseSpaces(identification.brand_guess)
    : '';
  if (brandGuess) {
    const evidence = hasBrandEvidence(identification);
    const speculative = SPECULATIVE_BRAND_RE.test(brandGuess) || /style$/i.test(brandGuess);
    if (!evidence || speculative) {
      identification.brand_guess = null;
      brandSuppressed = true;
      suppressed.push('brand_guess');
      if (!evidence) conflicts.push({ code: 'unsupported_brand', field: 'brand_guess' });
    }
  }

  // Unsupported / speculative material
  const matRaw = typeof identification.material_estimate === 'string'
    ? identification.material_estimate
    : '';
  if (matRaw && (SPECULATIVE_MATERIAL_RE.test(matRaw) || !isSupportedMaterial(matRaw))) {
    if (SPECULATIVE_MATERIAL_RE.test(matRaw) || /luxury|designer/i.test(matRaw)) {
      identification.material_estimate = '';
      materialSuppressed = true;
      suppressed.push('material_estimate');
      conflicts.push({ code: 'unsupported_material', field: 'material_estimate' });
    }
  }

  // Verbose style tags / features — trim for low-noise labels
  for (const field of ['style_tags', 'distinctive_features'] as const) {
    const arr = identification[field];
    if (!Array.isArray(arr)) continue;
    const cleaned = arr
      .filter((x): x is string => typeof x === 'string')
      .map((x) => collapseSpaces(x))
      .filter((x) => x && !LUXURY_FILLER_RE.test(x));
    if (cleaned.length !== arr.length) {
      identification[field] = cleaned;
      suppressed.push(field);
    }
  }

  // Score
  let score = 0;
  const validCategory = !!(canonCat && canonCat !== 'NON_FASHION' && !isGenericFashionLabel(canonCat));
  const subtypeNow = typeof identification.subtype === 'string' ? identification.subtype : '';
  const validSubtype = !!(subtypeNow && !isGenericFashionLabel(subtypeNow));
  const compatible = validCategory && validSubtype && subtypeCompatible(canonCat, subtypeNow);

  if (validCategory) score += SCORE_VALID_CATEGORY;
  if (validSubtype) score += SCORE_VALID_SUBTYPE;
  if (compatible) score += SCORE_CATEGORY_SUBTYPE_COMPATIBLE;

  const color = usable(identification.primary_color);
  if (color && normalizeColor(color)) score += SCORE_DOMINANT_COLOR;

  if (isSupportedMaterial(identification.material_estimate) && !materialSuppressed) {
    score += SCORE_MATERIAL_SUPPORTED;
  }

  const sil = usable(identification.silhouette);
  if (sil && normalizeSilhouette(sil)) score += SCORE_SILHOUETTE;

  if (usable(identification.fit)) score += SCORE_FIT_DETAIL;

  const pattern = usable(identification.pattern);
  if (pattern && pattern.toLowerCase() !== 'solid') score += SCORE_PATTERN;
  else if (pattern) score += Math.floor(SCORE_PATTERN / 2);

  const provisionalLabel = [color, subtypeNow || categoryRaw].filter(Boolean).join(' ');
  if (provisionalLabel && meaningfulWordCount(provisionalLabel) >= 2 && !isGenericFashionLabel(provisionalLabel)) {
    score += SCORE_SPECIFIC_LABEL;
  }

  if (isGenericFashionLabel(categoryRaw) || (!validCategory && !validSubtype)) {
    score += PENALTY_GENERIC_LABEL;
  }
  if (conflicts.some((c) => c.code === 'category_subtype_conflict')) {
    score += PENALTY_CATEGORY_SUBTYPE_CONFLICT;
  }
  if (brandSuppressed) score += PENALTY_UNSUPPORTED_BRAND;
  if (materialSuppressed) score += PENALTY_UNSUPPORTED_MATERIAL;
  if (duplicateCount > 0) score += PENALTY_DUPLICATE_DESCRIPTORS;
  if (malformed) score += PENALTY_MALFORMED_FIELD;

  const vo = typeof identification.visual_observation === 'string'
    ? identification.visual_observation
    : '';
  if (meaningfulWordCount(vo) > 40 || meaningfulWordCount(provisionalLabel) > 12) {
    score += PENALTY_EXCESSIVELY_VERBOSE;
  }

  if (!validCategory && !validSubtype) {
    score += PENALTY_MISSING_CATEGORY_SUBTYPE;
  }

  const qualityScore = clampScore(score);
  const qualityBand = qualityBandFromScore(qualityScore);
  const commerceQueryDetailLevel = detailLevelFromBand(qualityBand);

  // Tiered attribute suppression for commerce-facing fields (keep category)
  if (qualityBand === 'low') {
    if (!hasBrandEvidence(identification) && identification.brand_guess) {
      identification.brand_guess = null;
      brandSuppressed = true;
      if (!suppressed.includes('brand_guess')) suppressed.push('brand_guess');
    }
    if (identification.material_estimate) {
      identification.material_estimate = '';
      materialSuppressed = true;
      if (!suppressed.includes('material_estimate')) suppressed.push('material_estimate');
    }
    // Suppress weak fit / aesthetic speculation
    if (usable(identification.fit) && /relaxed|oversized|boyfriend/i.test(String(identification.fit))) {
      identification.fit = '';
      suppressed.push('fit');
    }
  } else if (qualityBand === 'moderate') {
    if (!hasBrandEvidence(identification) && identification.brand_guess) {
      identification.brand_guess = null;
      brandSuppressed = true;
      if (!suppressed.includes('brand_guess')) suppressed.push('brand_guess');
    }
    if (matRaw && (SPECULATIVE_MATERIAL_RE.test(matRaw) || !isSupportedMaterial(matRaw))) {
      identification.material_estimate = '';
      materialSuppressed = true;
      if (!suppressed.includes('material_estimate')) suppressed.push('material_estimate');
    }
  }

  const label = buildQualityResultLabel(identification, qualityBand);

  // Improve search_queries[0] toward concise label without inventing category
  if (Array.isArray(identification.search_queries) || qualityBand !== 'low') {
    const q = label.toLowerCase();
    if (q && !isGenericFashionLabel(q)) {
      identification.search_queries = [q];
    }
  }

  // Sync attributes lightly (no rename)
  if (attributes) {
    if (validCategory && typeof identification.item_type === 'string') {
      attributes.category = identification.item_type;
    }
    if (typeof identification.subtype === 'string' && identification.subtype) {
      attributes.itemType = identification.subtype;
    } else if (suppressed.includes('subtype')) {
      // leave attributes.itemType if coherent; else clear generic
      if (isGenericFashionLabel(attributes.itemType)) attributes.itemType = identification.item_type || attributes.itemType;
    }
  }

  return {
    identification,
    attributes,
    qualityScore,
    qualityBand,
    consistencyConflicts: conflicts,
    suppressedAttributes: [...new Set(suppressed)],
    label,
    commerceQueryDetailLevel,
    brandSuppressed,
    materialSuppressed,
  };
}

/**
 * Deterministic quality score for a (possibly already gated) identification.
 * Same input → same score.
 */
export function scoreIdentificationQuality(
  identification: Record<string, unknown>,
  attributes?: Record<string, unknown>,
): { score: number; band: QualityScoreBand } {
  const gated = applyScannerQualityGate(identification, attributes);
  return { score: gated.qualityScore, band: gated.qualityBand };
}
