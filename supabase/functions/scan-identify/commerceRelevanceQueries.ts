/**
 * Category-specific commerce query templates (v122), with confidence-aware
 * identity enrichment (v125).
 *
 * Retailer-neutral. Target 3–5 key terms; absolute cap 8 meaningful words.
 *
 * v125 does not widen the budget — it changes what the budget is spent on.
 * Without `commerceIdentity` every code path below is the untouched v122/v124
 * template, so a disabled v125 produces byte-identical queries.
 */

import {
  ABSOLUTE_QUERY_MEANINGFUL_WORDS,
  TARGET_QUERY_KEY_TERMS_MAX,
} from './commerceRelevanceConfig.ts';
import {
  type CommerceQueryStrategy,
  DISCRIMINATING_PATTERN_TOKENS,
  GENERIC_FEATURE_TOKENS,
  HIGH_SIGNAL_FEATURE_TOKENS,
  KNOWN_CATALOG_CATEGORIES,
  MAX_QUERY_DISTINCTIVE_FEATURES,
  MAX_QUERY_FEATURE_WORDS,
} from './commerceRetrievalConfig.ts';
import { normalizeCategory } from '../_shared/scanHelpers.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';
import {
  colorTermsForQuery,
  materialForQuery,
  resolveColorCertainty,
  resolveMaterialCertainty,
} from './commerceRelevanceColorMaterial.ts';
import type { ScannerCategoryRoute } from './scannerCategoryRoute.ts';
import { isGenericFashionLabel } from './qualityTuneNormalize.ts';

export type RelevanceQueryInput = {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  categoryRoute: ScannerCategoryRoute;
  detailLevel?: 'specific' | 'moderate' | 'broad';
  qualityBand?: 'high' | 'moderate' | 'low' | null;
  materialAllowed?: boolean;
  brandAllowed?: boolean;
  originalText?: string;
  /**
   * v125 graded commercial identity (from the v124 quality gate). Omit for
   * exact v124 query construction — this is the only channel through which
   * identity may influence retrieval.
   */
  commerceIdentity?: CommerceIdentityEvidence;
};

export type RelevanceQueries = {
  primary: string;
  fallback: string;
  colorCertainty: string | null;
  materialCertainty: string | null;
  template: ScannerCategoryRoute;
  /** v125 — present only when identity evidence was supplied. */
  strategy?: CommerceQueryStrategy;
  /** v125 diagnostics — bounded, never contains the query string itself. */
  identityTerms?: {
    brandIncluded: boolean;
    exactHypothesisIncluded: boolean;
    distinctiveFeatureCount: number;
  };
};

const FILLER: ReadonlySet<string> = new Set([
  'with', 'and', 'the', 'a', 'an', 'of', 'for', 'featuring', 'some', 'plus', 'in', 'to', 'on', 'at', 'by',
  'oversized', 'minimalist', 'luxury', 'vintage', 'inspired', 'boyfriend', 'designer', 'premium',
  'high-end', 'aesthetic', 'vibes', 'look',
]);

/** Apparel-only fields that must never enter footwear/bag queries. */
const APPAREL_ONLY_ATTRS: ReadonlySet<string> = new Set([
  'fit', 'neckline', 'neckline_or_lapel', 'sleeve', 'sleeve_length', 'waist', 'waist_treatment',
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
  if (isGenericFashionLabel(t)) return '';
  return t;
}

function meaningfulWords(s: string): string[] {
  return collapseSpaces(s).split(' ').filter((w) => {
    if (!w) return false;
    const lw = w.toLowerCase();
    if (FILLER.has(lw)) return false;
    return true;
  });
}

function dedupeTokens(raw: string): string {
  const words = collapseSpaces(raw).split(' ');
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!lw || FILLER.has(lw) || seen.has(lw)) continue;
    seen.add(lw);
    kept.push(w);
  }
  return kept.join(' ');
}

/**
 * Cap to ≤8 meaningful words; target 3–5 key phrases/terms.
 * Drops lower-priority trailing attribute phrases first — never truncates
 * mid-phrase (e.g. keeps "faux leather", "square toe").
 */
function finalizeQuery(parts: string[], maxTerms = TARGET_QUERY_KEY_TERMS_MAX): string {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const p = dedupeTokens(part);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    // Skip if every token already present
    const tokens = meaningfulWords(p);
    if (tokens.every((t) => seen.has(t.toLowerCase()))) continue;
    for (const t of tokens) seen.add(t.toLowerCase());
    phrases.push(p);
  }

  const selected: string[] = [];
  let wordCount = 0;
  for (const phrase of phrases) {
    const wc = meaningfulWords(phrase).length;
    if (selected.length >= maxTerms) break;
    if (wordCount + wc > ABSOLUTE_QUERY_MEANINGFUL_WORDS && selected.length > 0) break;
    selected.push(phrase);
    wordCount += wc;
  }
  return selected.join(' ');
}

function pickAttr(id: Record<string, unknown>, attrs: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const fromId = usable(id[k]);
    if (fromId) return fromId;
    const fromAttrs = usable(attrs[k]);
    if (fromAttrs) return fromAttrs;
  }
  return '';
}

function extractToeShape(id: Record<string, unknown>): string {
  const raw = usable(id.toe_shape) || usable(id.toeShape);
  if (!raw) {
    // Heuristic from distinctive features / subtype
    const blob = [
      usable(id.subtype),
      Array.isArray(id.distinctive_features) ? usable(id.distinctive_features[0]) : '',
    ].join(' ').toLowerCase();
    if (/\bsquare[-\s]?toe\b/.test(blob)) return 'square toe';
    if (/\bpoint(?:ed|y)?[-\s]?toe\b/.test(blob)) return 'pointed toe';
    if (/\bround[-\s]?toe\b/.test(blob)) return 'round toe';
    return '';
  }
  return raw;
}

function extractHeelOrSole(id: Record<string, unknown>): string {
  const heel = usable(id.heel_type) || usable(id.heelType) || usable(id.sole_type) || usable(id.soleType);
  if (heel) return heel;
  const blob = [
    usable(id.subtype),
    usable(id.silhouette),
    Array.isArray(id.distinctive_features) ? usable(id.distinctive_features[0]) : '',
  ].join(' ').toLowerCase();
  if (/\blow[-\s]?profile\b/.test(blob)) return 'low profile';
  if (/\bchelsea\b/.test(blob)) return '';
  if (/\bblock\s*heel\b/.test(blob)) return 'block heel';
  if (/\bstiletto\b/.test(blob)) return 'stiletto';
  return '';
}

function extractCarryMethod(id: Record<string, unknown>): string {
  const raw = usable(id.carry_method) || usable(id.carryMethod);
  if (raw) return raw;
  const sub = usable(id.subtype).toLowerCase();
  if (/\bcrossbody\b/.test(sub)) return 'crossbody';
  if (/\btop\s*handle\b/.test(sub)) return 'top handle';
  if (/\bshoulder\b/.test(sub)) return 'shoulder';
  if (/\btote\b/.test(sub)) return 'tote';
  if (/\bclutch\b/.test(sub)) return 'clutch';
  return '';
}

function extractBagShape(id: Record<string, unknown>): string {
  const raw = usable(id.shape) || usable(id.silhouette);
  if (raw && !APPAREL_ONLY_ATTRS.has(raw.toLowerCase())) {
    if (/\bcrescent\b/i.test(raw)) return 'crescent';
    if (/\bstructured\b/i.test(raw)) return 'structured';
    return raw;
  }
  const sub = usable(id.subtype).toLowerCase();
  if (/\bcrescent\b/.test(sub)) return 'crescent';
  if (/\bstructured\b/.test(sub)) return 'structured';
  return '';
}

function brandIfAllowed(id: Record<string, unknown>, brandAllowed?: boolean): string {
  if (brandAllowed === false) return '';
  const logo = id.logo_detected === true;
  const visible = usable(id.visible_brand_text);
  if (!logo && !visible) return '';
  // Direct evidence governs over a hypothesis: text actually legible on the
  // garment must win the query's brand term over a conflicting brand_guess.
  // brand_guess remains the fallback when a logo was detected but no text
  // was legible — a named guess for that logo is still useful.
  return visible || usable(id.brand_guess);
}

// ── v125 confidence-aware identity enrichment ────────────────────────────────

function featureWords(raw: string): string[] {
  return collapseSpaces(raw).toLowerCase().split(' ').filter(Boolean);
}

/**
 * Pick the distinctive construction terms worth spending query budget on.
 *
 * A feature qualifies only if it names construction, hardware, or closure —
 * "asymmetric zipper" narrows a search, "clean lines" does not. Marketing
 * adjectives are rejected outright even when they appear alongside a real term.
 */
export function selectDistinctiveQueryFeatures(
  identity: CommerceIdentityEvidence | undefined,
): string[] {
  if (!identity || !Array.isArray(identity.distinctiveFeatures)) return [];
  const out: string[] = [];
  const seenToken = new Set<string>();

  for (const raw of identity.distinctiveFeatures) {
    if (out.length >= MAX_QUERY_DISTINCTIVE_FEATURES) break;
    if (typeof raw !== 'string') continue;
    const phrase = collapseSpaces(raw);
    if (!phrase) continue;
    const words = featureWords(phrase);
    if (!words.length || words.length > MAX_QUERY_FEATURE_WORDS) continue;
    if (words.some((w) => GENERIC_FEATURE_TOKENS.has(w))) continue;
    if (!words.some((w) => HIGH_SIGNAL_FEATURE_TOKENS.has(w))) continue;
    // Do not spend budget twice on the same construction concept.
    if (words.every((w) => seenToken.has(w))) continue;
    for (const w of words) seenToken.add(w);
    out.push(phrase);
  }
  return out;
}

/** Pattern earns query budget only when it actually narrows the search. */
export function patternForQuery(pattern: string): string {
  const t = collapseSpaces(pattern).toLowerCase();
  if (!t || t === 'solid') return '';
  const words = t.split(' ').filter(Boolean);
  if (!words.some((w) => DISCRIMINATING_PATTERN_TOKENS.has(w))) return '';
  return collapseSpaces(pattern);
}

/**
 * A model hypothesis is only usable when it does not contradict the category
 * the Scanner actually identified. "Speedy 30 Handbag" on an outerwear scan is
 * evidence of a bad hypothesis, not evidence of a bag.
 *
 * An unrecognized hypothesis ("Speedy 30", "Rockstud") carries no category
 * signal at all and is therefore treated as non-contradicting.
 */
export function hypothesisCategoryCompatible(
  hypothesis: string,
  scannedCategory: string,
): boolean {
  const scanned = normalizeCategory(scannedCategory);
  if (!scanned || !KNOWN_CATALOG_CATEGORIES.has(scanned)) return true;
  const fromHypothesis = normalizeCategory(hypothesis);
  if (!fromHypothesis || !KNOWN_CATALOG_CATEGORIES.has(fromHypothesis)) return true;
  return fromHypothesis === scanned;
}

export type QueryStrategyResolution = {
  strategy: CommerceQueryStrategy;
  brand: string;
  hypothesis: string;
};

/**
 * Choose the retrieval strategy from graded evidence.
 *
 * The grades come from v124 and are load-bearing rather than advisory:
 *   VERIFIED  brand → usable prominently
 *   PLAUSIBLE brand → usable only alongside a real garment term
 *   WEAK      brand → ranking evidence only, never retrieval
 *   INVALID   brand → discarded
 *
 * A model hypothesis additionally requires supporting brand evidence: a model
 * name with no brand behind it is a guess, and guesses must not steer what we
 * search for.
 */
export function resolveQueryStrategy(
  identity: CommerceIdentityEvidence | undefined,
  garmentTerm: string,
  scannedCategory: string,
): QueryStrategyResolution {
  if (!identity) return { strategy: 'attribute_only', brand: '', hypothesis: '' };

  const brandUsable = identity.brandGrade === 'verified' ||
    (identity.brandGrade === 'plausible' && !!garmentTerm);
  const brand = brandUsable && typeof identity.brand === 'string' ? collapseSpaces(identity.brand) : '';

  const hypothesisRaw = typeof identity.exactItemHypothesis === 'string'
    ? collapseSpaces(identity.exactItemHypothesis)
    : '';
  const hypothesisGraded = identity.exactMatchGrade === 'verified' ||
    identity.exactMatchGrade === 'plausible';

  if (
    hypothesisRaw && hypothesisGraded && brand &&
    hypothesisCategoryCompatible(hypothesisRaw, scannedCategory)
  ) {
    return { strategy: 'exact_identity', brand, hypothesis: hypothesisRaw };
  }
  if (brand) return { strategy: 'brand_distinctive', brand, hypothesis: '' };
  return { strategy: 'attribute_only', brand: '', hypothesis: '' };
}

/**
 * Build category-templated primary + fallback commerce queries.
 */
export function buildCategoryCommerceQueries(input: RelevanceQueryInput): RelevanceQueries {
  const id = input.identification || {};
  const attrs = input.attributes || {};
  const route = input.categoryRoute || 'general';

  const colorResolved = resolveColorCertainty(
    usable(id.primary_color) || usable(attrs.color) ||
      (Array.isArray(attrs.colorPalette) && typeof attrs.colorPalette[0] === 'string'
        ? attrs.colorPalette[0]
        : ''),
  );
  const materialResolved = input.materialAllowed === false
    ? null
    : resolveMaterialCertainty(
      usable(id.material_estimate) || usable(attrs.material) || usable(attrs.materialEstimate),
    );

  const colorTerms = colorTermsForQuery(colorResolved, {
    omitLowCertainty: input.detailLevel === 'broad' || input.qualityBand === 'low',
  });
  const primaryMaterial = materialForQuery(materialResolved, 'primary', input.qualityBand);
  const fallbackMaterial = materialForQuery(materialResolved, 'fallback', input.qualityBand);

  const subtype = usable(id.subtype) || usable(attrs.itemType);
  const category = usable(id.item_type) || usable(attrs.category);
  const silhouette = usable(id.silhouette) || usable(attrs.silhouette);
  const pattern = usable(id.pattern) || usable(attrs.pattern);
  const brand = brandIfAllowed(id, input.brandAllowed);

  let primaryParts: string[] = [];
  let fallbackParts: string[] = [];

  if (route === 'apparel') {
    const fit = usable(id.fit);
    const length = usable(id.length);
    // Prioritize: color, subtype, silhouette, material, fit/length when useful, category
    primaryParts = [
      ...colorTerms,
      subtype,
      silhouette && !/\b(oversized|minimalist)\b/i.test(silhouette) ? silhouette : '',
      primaryMaterial,
      // fit/length only when strongly useful (cropped/wide-leg style signals)
      fit && /\b(cropped|wide-?leg|slim|relaxed)\b/i.test(fit) ? fit : '',
      length && /\b(cropped|midi|maxi|mini)\b/i.test(length) ? length : '',
      !subtype ? category : '',
    ];
    // Drop lower-value if over target — keep color/subtype/material
    fallbackParts = [...colorTerms, category || subtype, fallbackMaterial];
  } else if (route === 'footwear') {
    const toe = extractToeShape(id);
    const heelSole = extractHeelOrSole(id);
    primaryParts = [
      ...colorTerms,
      subtype || 'shoes',
      toe,
      heelSole,
      primaryMaterial,
    ];
    // Explicitly exclude apparel-only
    primaryParts = primaryParts.filter((p) => !APPAREL_ONLY_ATTRS.has(p.toLowerCase()));
    fallbackParts = [...colorTerms, subtype || category || 'shoes', fallbackMaterial];
  } else if (route === 'bags') {
    const shape = extractBagShape(id);
    const carry = extractCarryMethod(id);
    const structure = /\bstructured\b/i.test(silhouette) || /\bstructured\b/i.test(subtype)
      ? 'structured'
      : '';
    primaryParts = [
      ...colorTerms,
      subtype || 'bag',
      shape && shape !== subtype ? shape : '',
      carry && !subtype.toLowerCase().includes(carry) ? carry : '',
      primaryMaterial,
      structure && !shape.includes('structured') ? structure : '',
    ];
    primaryParts = primaryParts.filter((p) => !APPAREL_ONLY_ATTRS.has(p.toLowerCase()));
    fallbackParts = [...colorTerms, subtype || 'bag', fallbackMaterial];
  } else if (route === 'accessories') {
    const shape = pickAttr(id, attrs, ['shape', 'frame_shape', 'silhouette']);
    const finish = pickAttr(id, attrs, ['finish', 'metal_tone']) ||
      (/\bgold\b/i.test(usable(id.primary_color)) ? 'gold tone' : '') ||
      (/\bsilver\b/i.test(usable(id.primary_color)) ? 'silver tone' : '');
    primaryParts = [
      ...colorTerms,
      subtype || category || 'accessory',
      shape,
      primaryMaterial || finish,
      pattern && pattern !== 'solid' ? pattern : '',
    ];
    fallbackParts = [...colorTerms, subtype || category || 'accessory', fallbackMaterial || finish];
  } else {
    // general — conservative v121-like tiered logic
    if (input.detailLevel === 'specific') {
      primaryParts = [...colorTerms, subtype, primaryMaterial, silhouette, category];
    } else if (input.detailLevel === 'moderate') {
      primaryParts = [...colorTerms, subtype || category];
    } else {
      primaryParts = [...colorTerms.slice(0, 1), category || subtype];
    }
    fallbackParts = [...colorTerms.slice(0, 1), category || subtype];
  }

  // ── v125 confidence-aware override (omitted → exact v124 construction) ─────
  let strategy: CommerceQueryStrategy | undefined;
  let identityTerms: RelevanceQueries['identityTerms'];
  if (input.commerceIdentity) {
    const garmentTerm = subtype || category;
    const resolved = resolveQueryStrategy(
      input.commerceIdentity,
      garmentTerm,
      category || subtype,
    );
    strategy = resolved.strategy;

    const discriminatingPattern = patternForQuery(pattern);
    // A discriminating pattern is itself a construction signal. Spending budget
    // on two overlapping signals is what pushes colour out of the query, so the
    // second feature yields to the pattern rather than competing with it.
    const features = selectDistinctiveQueryFeatures(input.commerceIdentity)
      .slice(0, discriminatingPattern ? 1 : MAX_QUERY_DISTINCTIVE_FEATURES);

    // When the hypothesis already names the garment ("L01 Motorcycle Jacket"),
    // repeating the subtype buys nothing and costs two words of budget.
    const hypothesisNamesGarment = !!resolved.hypothesis &&
      normalizeCategory(resolved.hypothesis) === normalizeCategory(category || subtype);
    const garmentTermForIdentity = hypothesisNamesGarment ? '' : garmentTerm;

    // Priority is the whole point of v125: commercial identity first, then the
    // garment term, then construction, and only then the attribute tail. The
    // budget is unchanged, so colour and silhouette now yield to identity
    // rather than crowding it out.
    if (resolved.strategy === 'exact_identity') {
      primaryParts = [
        resolved.brand,
        resolved.hypothesis,
        garmentTermForIdentity,
        primaryMaterial,
        ...features,
        discriminatingPattern,
        ...colorTerms,
      ];
    } else if (resolved.strategy === 'brand_distinctive') {
      primaryParts = [
        resolved.brand,
        garmentTerm,
        ...features,
        primaryMaterial,
        discriminatingPattern,
        ...colorTerms,
      ];
    } else {
      primaryParts = [
        garmentTerm,
        ...features,
        primaryMaterial,
        discriminatingPattern,
        ...colorTerms,
        silhouette && !/(oversized|minimalist)/i.test(silhouette) ? silhouette : '',
      ];
    }

    // Fallback drops uncertain commercial identity before it drops the garment
    // term — an over-specific brand or model is exactly what it exists to undo.
    fallbackParts = [...colorTerms, fallbackMaterial, garmentTerm || category];
  } else if (brand) {
    primaryParts = [brand, ...primaryParts];
  }

  let primary = finalizeQuery(primaryParts, TARGET_QUERY_KEY_TERMS_MAX);
  if (!primary) {
    primary = finalizeQuery([
      ...colorTerms,
      subtype || category,
      usable(input.originalText),
    ]);
  }

  let fallback = finalizeQuery(fallbackParts, TARGET_QUERY_KEY_TERMS_MAX);
  if (fallback === primary) fallback = '';

  if (strategy) {
    const lowerPrimary = primary.toLowerCase();
    const brandLower = collapseSpaces(
      typeof input.commerceIdentity?.brand === 'string' ? input.commerceIdentity.brand : '',
    ).toLowerCase();
    const hypothesisLower = collapseSpaces(
      typeof input.commerceIdentity?.exactItemHypothesis === 'string'
        ? input.commerceIdentity.exactItemHypothesis
        : '',
    ).toLowerCase();
    identityTerms = {
      brandIncluded: !!brandLower && lowerPrimary.includes(brandLower.split(' ')[0]!),
      exactHypothesisIncluded: !!hypothesisLower &&
        meaningfulWords(hypothesisLower).every((w) => lowerPrimary.includes(w)),
      distinctiveFeatureCount: selectDistinctiveQueryFeatures(input.commerceIdentity).length,
    };
  }

  return {
    primary,
    fallback,
    colorCertainty: colorResolved?.certainty ?? null,
    materialCertainty: materialResolved?.certainty ?? null,
    template: route,
    ...(strategy ? { strategy, identityTerms } : {}),
  };
}
