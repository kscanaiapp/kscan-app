/**
 * Similarity matcher — lightweight deterministic metadata scorer for the
 * product_catalog table. Phase 3A foundation: no embeddings, no vector DB,
 * no AI ranking, no auto-upserts.
 *
 * Flow: Gemini identification → commerce router (live products) → this matcher
 * (catalog candidates) → response. This matcher must never block live commerce.
 *
 * Scoring weights (0-100):
 *   category           30
 *   brand              25
 *   color              20
 *   subcategory/type   10
 *   style tags          8
 *   material            4
 *   silhouette          3
 *
 * A match must score >= threshold (default 60) to be returned. The UI hides the
 * "Similar Items" section entirely when fewer than 2 meaningful matches exist.
 */

export type SimilarityMatchInputIdentification = {
  canonicalCategory: string;
  canonicalColor: string;
  canonicalMaterial?: string;
  canonicalSilhouette?: string;
  normalizedFeatures?: string[];
  normalizedStyleTags?: string[];
  visible_brand_text?: string | null;
  brand_guess?: string | null;
  logo_detected?: boolean;
  item_type?: string;
  subtype?: string;
};

export type SimilarityMatch = Record<string, unknown> & {
  id?: string;
  name?: string;
  title?: string;
  displayName?: string;
  matchScore: number;
  similarityPercentage: number;
  confidenceTier: 'exact_candidate' | 'closest_match' | 'similar_style' | 'discovery_fallback';
  matchReasons: Record<string, number | boolean | string>;
};

export type SimilarityMatcherOptions = {
  threshold?: number;
  maxMatches?: number;
  candidateCap?: number;
  timeoutMs?: number;
};

const DEFAULT_THRESHOLD = 60;
const DEFAULT_MAX_MATCHES = 10;
const DEFAULT_CANDIDATE_CAP = 500;
const DEFAULT_TIMEOUT_MS = 300;

const WEIGHTS = {
  category: 30,
  brand: 25,
  color: 20,
  subcategory: 10,
  style: 8,
  material: 4,
  silhouette: 3,
};

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: unknown): Set<string> {
  const text = normalizeText(value);
  if (!text) return new Set();
  return new Set(text.split(' ').filter((t) => t.length > 0));
}

function includesToken(text: unknown, token: string): boolean {
  return normalizeText(text)
    .split(' ')
    .includes(token.toLowerCase().trim());
}

function hasOverlap(haystack: string[] | undefined, needles: string[] | undefined): boolean {
  if (!Array.isArray(haystack) || !Array.isArray(needles)) return false;
  const normalizedHaystack = new Set(haystack.map((h) => normalizeText(h)).filter(Boolean));
  if (normalizedHaystack.size === 0) return false;
  return needles.some((n) => normalizedHaystack.has(normalizeText(n)));
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

function productText(candidate: Record<string, unknown>): string {
  const parts = [
    candidate.canonical_category,
    candidate.category,
    candidate.item_type,
    candidate.subtype,
    candidate.raw_category,
    candidate.search_text,
    candidate.product_name,
    candidate.name,
    candidate.title,
    candidate.description,
    candidate.brand,
    candidate.retailer,
  ];
  return parts.map((p) => normalizeText(p)).join(' ');
}

function productTags(candidate: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  stringArray(candidate.style_tags).forEach((t) => tags.add(t));
  stringArray(candidate.styleTags).forEach((t) => tags.add(t));
  stringArray(candidate.tags).forEach((t) => tags.add(t));
  stringArray(candidate.pattern_tags).forEach((t) => tags.add(t));
  stringArray(candidate.distinctive_features).forEach((t) => tags.add(t));
  return Array.from(tags);
}

function brandTokens(ident: SimilarityMatchInputIdentification): string[] {
  const tokens: string[] = [];
  if (ident.visible_brand_text) tokens.push(ident.visible_brand_text);
  if (ident.brand_guess) tokens.push(ident.brand_guess);
  return tokens
    .map((t) => normalizeText(t))
    .filter((t) => t.length > 0);
}

function scoreCategory(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  if (!ident.canonicalCategory) return 0;
  const canonical = ident.canonicalCategory.toLowerCase().trim();
  const candidateCanonical = normalizeText(candidate.canonical_category);
  if (candidateCanonical.split(' ').includes(canonical)) return WEIGHTS.category;

  const candidateCategory = normalizeText(candidate.category);
  if (candidateCategory.split(' ').includes(canonical)) return WEIGHTS.category;

  const widened = typeof candidate.match_widened_from === 'string' ? candidate.match_widened_from.toLowerCase() : '';
  if (widened === canonical) return WEIGHTS.category;

  return 0;
}

function scoreBrand(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  const brands = brandTokens(ident);
  if (brands.length === 0) return 0;

  const candidateBrand = normalizeText(candidate.brand);
  const candidateRetailer = normalizeText(candidate.retailer);
  const candidateText = productText(candidate);

  for (const brand of brands) {
    if (candidateBrand.split(' ').includes(brand)) return WEIGHTS.brand;
    if (candidateRetailer.split(' ').includes(brand)) return WEIGHTS.brand;
    if (candidateText.split(' ').includes(brand)) return WEIGHTS.brand;
  }
  return 0;
}

function scoreColor(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  if (!ident.canonicalColor) return 0;
  const target = ident.canonicalColor.toLowerCase().trim();
  if (!target) return 0;
  const colors = target.split('/').map((c) => c.trim()).filter(Boolean);

  const candidateColor = normalizeText(candidate.color_normalized || candidate.color);
  const candidateText = productText(candidate);

  for (const color of colors) {
    if (candidateColor.includes(color)) return WEIGHTS.color;
    if (candidateText.includes(color)) return WEIGHTS.color;
  }
  return 0;
}

function scoreSubcategory(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  const targets: string[] = [];
  if (ident.item_type) targets.push(ident.item_type);
  if (ident.subtype) targets.push(ident.subtype);
  const normalizedTargets = targets
    .map((t) => normalizeText(t))
    .filter((t) => t.length > 0 && t !== ident.canonicalCategory?.toLowerCase().trim());
  if (normalizedTargets.length === 0) return 0;

  const candidateItemType = normalizeText(candidate.item_type || candidate.subtype);
  const candidateRaw = normalizeText(candidate.raw_category);
  const text = productText(candidate);

  for (const target of normalizedTargets) {
    if (candidateItemType.includes(target)) return WEIGHTS.subcategory;
    if (candidateRaw.includes(target)) return WEIGHTS.subcategory;
    if (text.includes(target)) return WEIGHTS.subcategory;
  }
  return 0;
}

function scoreStyle(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  const styleTags = ident.normalizedStyleTags ?? [];
  if (styleTags.length === 0) return 0;
  const candidateTags = productTags(candidate).map((t) => normalizeText(t));
  if (candidateTags.length === 0) return 0;
  const normalizedStyleTags = styleTags.map((t) => normalizeText(t)).filter(Boolean);
  const overlap = normalizedStyleTags.some((t) => candidateTags.includes(t));
  return overlap ? WEIGHTS.style : 0;
}

function scoreMaterial(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  if (!ident.canonicalMaterial) return 0;
  const target = normalizeText(ident.canonicalMaterial);
  if (!target) return 0;

  const materialTags = stringArray(candidate.material_tags).map((t) => normalizeText(t));
  const material = normalizeText(candidate.material || candidate.materialEstimate);
  const text = normalizeText([candidate.material, candidate.materialEstimate, candidate.description].join(' '));

  if (materialTags.includes(target)) return WEIGHTS.material;
  if (material.split(' ').includes(target)) return WEIGHTS.material;
  if (text.split(' ').includes(target)) return WEIGHTS.material;
  return 0;
}

function scoreSilhouette(candidate: Record<string, unknown>, ident: SimilarityMatchInputIdentification): number {
  if (!ident.canonicalSilhouette) return 0;
  const target = normalizeText(ident.canonicalSilhouette);
  if (!target) return 0;

  const silhouetteTags = stringArray(candidate.silhouette_tags).map((t) => normalizeText(t));
  const silhouette = normalizeText(candidate.silhouette || candidate.silhouette);
  const text = normalizeText([candidate.silhouette, candidate.fit, candidate.description].join(' '));

  if (silhouetteTags.includes(target)) return WEIGHTS.silhouette;
  if (silhouette.split(' ').includes(target)) return WEIGHTS.silhouette;
  if (text.split(' ').includes(target)) return WEIGHTS.silhouette;
  return 0;
}

function assignConfidenceTier(score: number, hasBrandEvidence: boolean): SimilarityMatch['confidenceTier'] {
  if (score >= 90 && hasBrandEvidence) return 'exact_candidate';
  if (score >= 75) return 'closest_match';
  if (score >= 50) return 'similar_style';
  return 'discovery_fallback';
}

function scoreCandidate(
  candidate: Record<string, unknown>,
  ident: SimilarityMatchInputIdentification,
): { match: SimilarityMatch; passed: boolean; score: number } {
  const reasons: Record<string, number | boolean | string> = {};

  const categoryScore = scoreCategory(candidate, ident);
  if (categoryScore > 0) reasons.category_match = true;

  const brandScore = scoreBrand(candidate, ident);
  if (brandScore > 0) reasons.brand_match = true;

  const colorScore = scoreColor(candidate, ident);
  if (colorScore > 0) reasons.color_match = true;

  const subcategoryScore = scoreSubcategory(candidate, ident);
  if (subcategoryScore > 0) reasons.subcategory_match = true;

  const styleScore = scoreStyle(candidate, ident);
  if (styleScore > 0) reasons.style_match = true;

  const materialScore = scoreMaterial(candidate, ident);
  if (materialScore > 0) reasons.material_match = true;

  const silhouetteScore = scoreSilhouette(candidate, ident);
  if (silhouetteScore > 0) reasons.silhouette_match = true;

  const score =
    categoryScore +
    brandScore +
    colorScore +
    subcategoryScore +
    styleScore +
    materialScore +
    silhouetteScore;

  const id = typeof candidate.id === 'string' ? candidate.id : undefined;
  const name = typeof candidate.name === 'string'
    ? candidate.name
    : typeof candidate.product_name === 'string'
    ? candidate.product_name
    : undefined;
  const title = typeof candidate.title === 'string' ? candidate.title : undefined;
  const displayName = name || title || id || 'Product';

  const hasBrandEvidence =
    !!(
      ident.visible_brand_text &&
      typeof ident.visible_brand_text === 'string' &&
      ident.visible_brand_text.trim().length > 0
    ) ||
    !!(
      ident.brand_guess &&
      typeof ident.brand_guess === 'string' &&
      ident.brand_guess.trim().length > 0
    ) ||
    ident.logo_detected === true;

  const match: SimilarityMatch = {
    ...candidate,
    id,
    name,
    title,
    displayName,
    matchScore: score,
    similarityPercentage: Math.round(score),
    confidenceTier: assignConfidenceTier(score, hasBrandEvidence),
    matchReasons: reasons,
  };

  return { match, score, passed: true };
}

export type FindSimilarityMatchesInput = {
  normalizedIdentification: SimilarityMatchInputIdentification | null;
  candidates: Record<string, unknown>[];
  options?: SimilarityMatcherOptions;
};

/**
 * Score catalog candidates against a normalized identification and return the
 * top matches above the threshold. Runs in a single synchronous pass with a
 * deadline check between candidates so it never blocks commerce for long.
 */
export async function findSimilarityMatches(
  input: FindSimilarityMatchesInput,
): Promise<SimilarityMatch[]> {
  const {
    normalizedIdentification,
    candidates,
    options,
  } = input;

  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const maxMatches = Math.max(1, Math.min(100, options?.maxMatches ?? DEFAULT_MAX_MATCHES));
  const candidateCap = Math.max(1, Math.min(2000, options?.candidateCap ?? DEFAULT_CANDIDATE_CAP));
  const timeoutMs = Math.max(50, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  if (!normalizedIdentification) return [];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const capped = candidates.slice(0, candidateCap);
  const start = Date.now();
  const matches: SimilarityMatch[] = [];

  for (const raw of capped) {
    if (Date.now() - start > timeoutMs) {
      break;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const { match, score } = scoreCandidate(candidate, normalizedIdentification);
    if (score >= threshold) {
      matches.push(match);
    }
  }

  matches.sort((a, b) => b.matchScore - a.matchScore);
  return matches.slice(0, maxMatches);
}
