/**
 * Retailer-neutral commerce query optimization + product filter/dedupe.
 * Client-facing purchase URLs are never rewritten — only identity keys use
 * canonicalization.
 *
 * v122 commerce relevance (optional):
 *   When `relevance` options are omitted → exact v121 behavior.
 *   When provided → category templates, agreement scoring, soft diversity.
 */

import { QUALITY_TUNE_MIN_VALID_PRODUCTS } from './qualityTuneConfig.ts';
import {
  isGenericFashionLabel,
  normalizeCategory,
  normalizeColor,
  normalizeMaterial,
  normalizeSilhouette,
} from './qualityTuneNormalize.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';
import type { ScannerCategoryRoute } from './scannerCategoryRoute.ts';
import { buildCategoryCommerceQueries } from './commerceRelevanceQueries.ts';
import { scoreProductAgreement } from './commerceRelevanceAgreement.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';
import type { CommerceQueryStrategy } from './commerceRetrievalConfig.ts';
import {
  applySoftDiversityRerank,
  selectByAgreementCoverage,
  type ScoredProduct,
} from './commerceRelevanceDiversity.ts';
import {
  FAILURE_REASON_CATEGORY_MISMATCH_REMOVED,
  FAILURE_REASON_PRODUCT_DEDUPE_REDUCTION,
  FAILURE_REASON_PRODUCT_FILTER_EMPTY,
} from './commerceRelevanceFailure.ts';

export type WeightedCommerceQueries = {
  /** v125 — present only when identity-aware retrieval ran. */
  strategy?: CommerceQueryStrategy;
  primary: string;
  fallback: string;
};

export type ProductFilterStats = {
  productsBeforeDedupe: number;
  productsAfterDedupe: number;
  categoryMismatchRemovals: number;
  identityKeyTypesUsed: string[];
  removedReasons: Record<string, number>;
  /** v122 relevance diagnostics — only present when relevance path runs */
  agreementScores?: number[];
  retailerCount?: number;
  failureReasonHints?: string[];
  productsBeforeFilter?: number;
  latencyRelevanceMs?: number;
};

export type CommerceRelevanceOptions = {
  enabled: true;
  categoryRoute: ScannerCategoryRoute;
  qualityBand?: 'high' | 'moderate' | 'low' | null;
  /**
   * v124 graded commercial identity evidence. Omitted → exact v122 ranking.
   * Ranking-only: filtering, dedupe, coverage, and diversity are unchanged.
   */
  commerceIdentity?: CommerceIdentityEvidence;
};

const FILLER = new Set([
  'with', 'and', 'the', 'a', 'an', 'of', 'for', 'featuring', 'some', 'plus', 'in', 'to', 'on', 'at', 'by',
  'oversized', 'minimalist', 'luxury', 'vintage', 'inspired', 'boyfriend', 'designer', 'premium',
  'high-end', 'aesthetic', 'vibes', 'look',
]);

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'affiliate', 'aff', 'source', 'affiliate_id', 'irclickid', 'clickid',
  'campaign', 'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi',
]);

const DEMO_HOST_HINTS = [
  'example.com', 'localhost', 'test.', 'demo.', 'placeholder', 'lorem',
];

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

function dedupeTokens(raw: string, maxLen = 200): string {
  const words = collapseSpaces(raw).split(' ');
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!lw) continue;
    if (FILLER.has(lw)) continue;
    if (seen.has(lw)) continue;
    seen.add(lw);
    kept.push(w);
  }
  return kept.join(' ').slice(0, maxLen);
}

export type CommerceQueryDetailLevel = 'specific' | 'moderate' | 'broad';

const MAX_QUERY_MEANINGFUL_WORDS = 8;

function meaningfulWords(s: string): string[] {
  return collapseSpaces(s).split(' ').filter((w) => {
    if (!w) return false;
    const lw = w.toLowerCase();
    if (FILLER.has(lw)) return false;
    if (/^(and|the|a|an|of|with|in|for|to|on)$/i.test(lw)) return false;
    return true;
  });
}

/** Cap to ≤8 meaningful words without truncating mid-phrase tokens. */
function capMeaningfulWords(raw: string, max = MAX_QUERY_MEANINGFUL_WORDS): string {
  const cleaned = dedupeTokens(raw);
  const words = meaningfulWords(cleaned);
  if (words.length <= max) return words.join(' ');
  // Prefer color/leading descriptors + trailing garment phrase
  const head = words.slice(0, Math.min(3, max - 2));
  const tail = words.slice(-(max - head.length));
  return dedupeTokens([...head, ...tail].join(' '));
}

/**
 * Build weighted primary + deterministic fallback commerce queries.
 * Brand excluded unless verified (logo / visible brand text).
 *
 * When `detailLevel` is omitted, preserves exact v120 query construction.
 * When provided (v121 intelligence ON), varies specificity by quality tier:
 *   specific → color + subtype + supported material + silhouette + category
 *   moderate → color + subtype + category
 *   broad    → color + broad category
 * When `relevanceRoute` is provided (v122 ON), uses category-specific templates.
 */
export function buildWeightedCommerceQueries(input: {
  identification: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  searchQueries?: string[];
  originalText?: string;
  /** v121 only — omit for exact v120 behavior */
  detailLevel?: CommerceQueryDetailLevel;
  /** When false/undefined with no detailLevel, use v120 query construction. */
  materialAllowed?: boolean;
  brandAllowed?: boolean;
  /** v122 only — omit for exact v121 behavior */
  relevanceRoute?: ScannerCategoryRoute;
  qualityBand?: 'high' | 'moderate' | 'low' | null;
  /**
   * v125 only — omit for exact v124 query construction. Reaches only the
   * category-template path; the legacy v120/v121 paths are untouched.
   */
  commerceIdentity?: CommerceIdentityEvidence;
}): WeightedCommerceQueries {
  const id = input.identification || {};
  const attrs = input.attributes || {};

  // ── v122 category-template path ────────────────────────────────────────────
  if (input.relevanceRoute) {
    const q = buildCategoryCommerceQueries({
      identification: id,
      attributes: attrs,
      categoryRoute: input.relevanceRoute,
      detailLevel: input.detailLevel,
      qualityBand: input.qualityBand,
      materialAllowed: input.materialAllowed,
      brandAllowed: input.brandAllowed,
      originalText: input.originalText,
      ...(input.commerceIdentity ? { commerceIdentity: input.commerceIdentity } : {}),
    });
    return { primary: q.primary, fallback: q.fallback, strategy: q.strategy };
  }

  const logo = id.logo_detected === true;
  const visible = usable(id.visible_brand_text);
  const brandVerified = logo || !!visible;
  const brand = brandVerified && input.brandAllowed !== false
    ? (usable(id.brand_guess) || visible)
    : '';

  const category = usable(id.item_type) || usable(attrs.category);
  const subtype = usable(id.subtype) || usable(attrs.itemType);
  const color = usable(id.primary_color) || usable(attrs.color) ||
    (Array.isArray(attrs.colorPalette) && typeof attrs.colorPalette[0] === 'string'
      ? usable(attrs.colorPalette[0])
      : '');
  const silhouette = usable(id.silhouette) || usable(attrs.silhouette);
  const materialRaw = usable(id.material_estimate) || usable(attrs.material) || usable(attrs.materialEstimate);
  const material = input.materialAllowed === false ? '' : materialRaw;
  const pattern = usable(id.pattern) || usable(attrs.pattern);
  const fit = usable(id.fit);
  const construction = Array.isArray(id.distinctive_features)
    ? usable(id.distinctive_features[0])
    : '';
  const style = Array.isArray(id.style_tags) ? usable(id.style_tags[0]) : usable(attrs.style);

  // ── v121 tiered path ───────────────────────────────────────────────────────
  if (input.detailLevel) {
    let primary = '';
    if (input.detailLevel === 'specific') {
      primary = capMeaningfulWords(
        [color, subtype, material, silhouette, category].filter(Boolean).join(' '),
      );
    } else if (input.detailLevel === 'moderate') {
      if (subtype && category && !subtype.toLowerCase().includes(category.toLowerCase())) {
        primary = capMeaningfulWords([color, subtype, category].filter(Boolean).join(' '));
      } else {
        primary = capMeaningfulWords([color, subtype || category].filter(Boolean).join(' '));
      }
    } else {
      primary = capMeaningfulWords([color, category || subtype].filter(Boolean).join(' '));
    }
    if (!primary) {
      primary = capMeaningfulWords(usable(input.originalText)) ||
        capMeaningfulWords([category, subtype].filter(Boolean).join(' '));
    }
    if (brand && input.brandAllowed) {
      primary = capMeaningfulWords([brand, primary].join(' '));
    }
    const garment = subtype || category;
    const fallback = capMeaningfulWords([color, category || garment].filter(Boolean).join(' ')) ||
      capMeaningfulWords(garment);
    return { primary, fallback: fallback === primary ? '' : fallback };
  }

  // ── v120 path (unchanged) ──────────────────────────────────────────────────
  // Prefer model search_queries[0] only when not generic/verbose luxury dump
  const searchQueries = Array.isArray(input.searchQueries)
    ? input.searchQueries
    : Array.isArray(id.search_queries)
    ? (id.search_queries as unknown[])
    : [];
  const firstQ = typeof searchQueries[0] === 'string' ? dedupeTokens(searchQueries[0]) : '';
  const firstQWeak = !firstQ || firstQ.split(' ').length > 12 ||
    /\b(luxury|designer|vintage-inspired|boyfriend)\b/i.test(firstQ);

  const required = [category, subtype].filter(Boolean);
  const highValue = [color, silhouette, material].filter(Boolean);
  const optional = [pattern, fit, construction, style].filter(Boolean);

  let primary = '';
  if (!firstQWeak && firstQ) {
    primary = firstQ;
  } else {
    primary = dedupeTokens([brand, ...required, ...highValue, ...optional.slice(0, 1)].filter(Boolean).join(' '));
  }
  if (!primary) {
    primary = dedupeTokens([color, category || subtype, material].filter(Boolean).join(' ')) ||
      dedupeTokens(usable(input.originalText));
  }

  // Fallback: strip optional + silhouette/material, keep color + strongest garment term
  const garment = subtype || category;
  const fallback = dedupeTokens([color, garment, /moto|biker/i.test(garment) ? '' : ''].filter(Boolean).join(' ')) ||
    dedupeTokens([color, category].filter(Boolean).join(' ')) ||
    dedupeTokens(garment);

  return { primary, fallback: fallback === primary ? '' : fallback };
}

export function shouldRunFallbackQuery(
  validProductCount: number,
  threshold: number = QUALITY_TUNE_MIN_VALID_PRODUCTS,
): boolean {
  return validProductCount < threshold;
}

/** Canonicalize URL for identity only — do not use as client-facing URL. */
export function canonicalizeUrlForIdentity(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    // Remove known tracking params; keep unknown query params
    const kept = new URLSearchParams();
    u.searchParams.forEach((value, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase())) return;
      kept.append(key, value);
    });
    const qs = kept.toString();
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${u.protocol}//${u.hostname}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return collapseSpaces(String(url)).toLowerCase() || undefined;
  }
}

function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return collapseSpaces(title).toLowerCase();
}

function productIdentityKey(p: RecommendedProduct): { key: string; type: string } {
  const rec = p as unknown as Record<string, unknown>;
  const retailerId = typeof rec.retailerId === 'string'
    ? String(rec.retailerId).toLowerCase()
    : typeof p.source === 'string' ? p.source.toLowerCase() : '';
  const sku = typeof rec.sku === 'string'
    ? String(rec.sku).toLowerCase()
    : typeof rec.SKU === 'string'
    ? String(rec.SKU).toLowerCase()
    : '';
  if (retailerId && sku) return { key: `sku:${retailerId}|${sku}`, type: 'retailer_sku' };

  // Canonical URL is checked before the provider-id tier: every active
  // provider synthesizes `id` by hashing the RAW productUrl (see
  // shoppingProvider.ts/poshmarkProvider.ts `makeId`), so a trailing slash,
  // path case difference, or extra query param produces a DIFFERENT `pid:`
  // for what canonicalizeUrlForIdentity would correctly recognize as the same
  // listing. Checking `pid:` first made this tier permanently unreachable
  // whenever a URL exists — which is true for every offer these providers
  // return — and let deterministic near-duplicates survive dedup.
  const canon = canonicalizeUrlForIdentity(p.productUrl);
  if (canon) return { key: `url:${canon}`, type: 'canonical_url' };

  const providerId = typeof p.id === 'string' && p.id.trim() ? p.id.trim().toLowerCase() : '';
  if (providerId && !providerId.startsWith('http')) {
    return { key: `pid:${providerId}`, type: 'provider_product_id' };
  }

  const title = normalizeTitle(p.title);
  const retailer = retailerId || (typeof p.source === 'string' ? p.source.toLowerCase() : '');
  if (retailer && title) return { key: `rt:${retailer}|${title}`, type: 'retailer_title' };

  const price = typeof p.price === 'string' ? p.price.toLowerCase() : '';
  if (title && price) return { key: `tp:${title}|${price}|${retailer}`, type: 'title_price_retailer' };

  return { key: `fallback:${title || 'unknown'}`, type: 'weak_fallback' };
}

export function hasUsableImage(p: RecommendedProduct): boolean {
  const url = typeof p.imageUrl === 'string' ? p.imageUrl.trim() : '';
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

export function hasValidPurchaseUrl(p: RecommendedProduct): boolean {
  const url = typeof p.productUrl === 'string' ? p.productUrl.trim() : '';
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    if (DEMO_HOST_HINTS.some((h) => u.hostname.includes(h))) return false;
    return true;
  } catch {
    return false;
  }
}

function isDemoOrTestProduct(p: RecommendedProduct): boolean {
  const title = normalizeTitle(p.title);
  if (!title) return true;
  if (/\b(test|demo|sample|placeholder|lorem|fallback product)\b/.test(title)) return true;
  const src = typeof p.source === 'string' ? p.source.toLowerCase() : '';
  if (src === 'demo' || src === 'test' || src === 'fallback') return true;
  return false;
}

function priceMalformedRequired(p: RecommendedProduct): boolean {
  // Price is optional for client contract — only drop when present but malformed
  if (p.price === undefined || p.price === null || p.price === '') return false;
  if (typeof p.price === 'number') return !Number.isFinite(p.price);
  if (typeof p.price !== 'string') return true;
  const t = p.price.trim();
  if (!t) return false;
  if (t === 'NaN' || t === 'null' || t === 'undefined') return true;
  if (/[a-zA-Z]{8,}/.test(t) && !/[€$£¥]/.test(t) && !/\d/.test(t)) return true;
  return false;
}

function productCategoryText(p: RecommendedProduct): string {
  const rec = p as unknown as Record<string, unknown>;
  return [
    typeof p.title === 'string' ? p.title : '',
    typeof rec.category === 'string' ? rec.category : '',
    typeof rec.item_type === 'string' ? rec.item_type : '',
    typeof p.type === 'string' ? p.type : '',
  ].join(' ').toLowerCase();
}

function isCategoryMismatch(p: RecommendedProduct, garmentCategory: string): boolean {
  const canon = normalizeCategory(garmentCategory);
  if (!canon || canon === 'NON_FASHION' || canon === 'unknown') return false;
  const text = productCategoryText(p);
  if (!text.trim()) return false;

  const productCat = normalizeCategory(text);
  if (!productCat || productCat === canon) return false;

  // Obvious mismatches only (conservative)
  const conflicts: Record<string, string[]> = {
    footwear: ['dress', 'blazer', 'bag', 'pants', 'top'],
    bag: ['footwear', 'dress', 'blazer', 'pants'],
    dress: ['footwear', 'bag', 'blazer'],
    blazer: ['footwear', 'bag', 'dress'],
    pants: ['footwear', 'bag', 'dress'],
    outerwear: ['footwear', 'bag'],
    top: ['footwear', 'bag'],
  };
  const bad = conflicts[canon] || [];
  return bad.includes(productCat);
}

function scoreProduct(p: RecommendedProduct, garment: Record<string, unknown>): number {
  let score = 0;
  const text = productCategoryText(p);
  const cat = normalizeCategory(typeof garment.item_type === 'string' ? garment.item_type : '');
  const sub = typeof garment.subtype === 'string' ? garment.subtype.toLowerCase() : '';
  const color = normalizeColor(typeof garment.primary_color === 'string' ? garment.primary_color : '');
  const mat = normalizeMaterial(typeof garment.material_estimate === 'string' ? garment.material_estimate : '');
  const sil = normalizeSilhouette(typeof garment.silhouette === 'string' ? garment.silhouette : '');
  const pat = typeof garment.pattern === 'string' ? garment.pattern.toLowerCase() : '';

  if (cat && (text.includes(cat) || normalizeCategory(text) === cat)) score += 8;
  if (sub && text.includes(sub.toLowerCase())) score += 6;
  if (color && text.includes(color.split('/')[0])) score += 4;
  if (mat && text.includes(mat.split('/')[0])) score += 3;
  if (sil && text.includes(sil.split('/')[0])) score += 2;
  if (pat && pat !== 'solid' && text.includes(pat)) score += 1;
  if (hasUsableImage(p)) score += 2;
  if (hasValidPurchaseUrl(p)) score += 2;
  if (p.price !== undefined && p.price !== null && p.price !== '' && !priceMalformedRequired(p)) score += 1;
  return score;
}

/**
 * Filter + dedupe products before returning to the app.
 * Does not rename products ↔ purchaseOptions arrays.
 *
 * When `relevance` is omitted → exact v121 filter/dedupe/score behavior.
 * When `relevance.enabled` → agreement scoring + coverage + soft diversity.
 */
export function filterAndDedupeProducts(
  products: RecommendedProduct[],
  garmentIdentification: Record<string, unknown>,
  relevance?: CommerceRelevanceOptions,
): { products: RecommendedProduct[]; stats: ProductFilterStats } {
  const removedReasons: Record<string, number> = {};
  const bump = (reason: string) => {
    removedReasons[reason] = (removedReasons[reason] || 0) + 1;
  };
  const started = Date.now();
  const productsBeforeFilter = Array.isArray(products) ? products.length : 0;

  const garmentCat = typeof garmentIdentification.item_type === 'string'
    ? garmentIdentification.item_type
    : '';

  const validShaped: RecommendedProduct[] = [];
  let categoryMismatchRemovals = 0;

  for (const p of products) {
    if (!p || typeof p !== 'object') {
      bump('empty_shell');
      continue;
    }
    if (isDemoOrTestProduct(p)) {
      bump('demo_test');
      continue;
    }
    if (!hasValidPurchaseUrl(p)) {
      bump('missing_or_invalid_purchase_url');
      continue;
    }
    if (!hasUsableImage(p)) {
      bump('missing_image');
      continue;
    }
    if (priceMalformedRequired(p)) {
      bump('malformed_price');
      continue;
    }
    if (isCategoryMismatch(p, garmentCat)) {
      categoryMismatchRemovals += 1;
      bump('category_mismatch');
      continue;
    }
    validShaped.push(p);
  }

  const productsBeforeDedupe = validShaped.length;
  const seen = new Set<string>();
  const identityKeyTypesUsed: string[] = [];
  const deduped: RecommendedProduct[] = [];
  const failureReasonHints: string[] = [];

  if (relevance?.enabled) {
    // v122: agreement score → coverage selection → dedupe → soft diversity
    const scored: ScoredProduct[] = validShaped.map((p, originalIndex) => {
      const ag = scoreProductAgreement(
        p,
        garmentIdentification,
        relevance.categoryRoute,
        relevance.commerceIdentity,
      );
      return {
        product: p,
        agreementScore: ag.score,
        agreementBand: ag.band,
        clearCategoryConflict: ag.clearCategoryConflict,
        originalIndex,
      };
    });

    // Extra clear-conflict suppression (in addition to isCategoryMismatch)
    const clearConflicts = scored.filter((s) => s.clearCategoryConflict).length;
    if (clearConflicts > 0) {
      categoryMismatchRemovals += clearConflicts;
      removedReasons['category_mismatch'] =
        (removedReasons['category_mismatch'] || 0) + clearConflicts;
      failureReasonHints.push(FAILURE_REASON_CATEGORY_MISMATCH_REMOVED);
    }
    const coverageSelected = selectByAgreementCoverage(scored);

    const rankedForDedupe = [...coverageSelected].sort((a, b) => {
      if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
      return a.originalIndex - b.originalIndex;
    });

    const dedupedScored: ScoredProduct[] = [];
    for (const s of rankedForDedupe) {
      const { key, type } = productIdentityKey(s.product);
      if (seen.has(key)) {
        bump('duplicate_identity');
        continue;
      }
      seen.add(key);
      if (!identityKeyTypesUsed.includes(type)) identityKeyTypesUsed.push(type);
      dedupedScored.push(s);
    }

    if (dedupedScored.length < rankedForDedupe.length) {
      failureReasonHints.push(FAILURE_REASON_PRODUCT_DEDUPE_REDUCTION);
    }

    const diversified = applySoftDiversityRerank(dedupedScored);
    for (const p of diversified) deduped.push(p);

    if (deduped.length === 0 && productsBeforeFilter > 0) {
      failureReasonHints.push(FAILURE_REASON_PRODUCT_FILTER_EMPTY);
    }

    const retailers = new Set(
      deduped.map((p) => (typeof p.source === 'string' ? p.source.toLowerCase() : 'unknown')),
    );

    return {
      products: deduped,
      stats: {
        productsBeforeDedupe,
        productsAfterDedupe: deduped.length,
        categoryMismatchRemovals,
        identityKeyTypesUsed,
        removedReasons,
        agreementScores: dedupedScored.map((s) => s.agreementScore),
        retailerCount: retailers.size,
        failureReasonHints,
        productsBeforeFilter,
        latencyRelevanceMs: Date.now() - started,
      },
    };
  }

  // ── v120/v121 path (unchanged) ─────────────────────────────────────────────
  // Rank then dedupe so strongest listing wins
  const ranked = [...validShaped].sort(
    (a, b) => scoreProduct(b, garmentIdentification) - scoreProduct(a, garmentIdentification),
  );

  for (const p of ranked) {
    const { key, type } = productIdentityKey(p);
    if (seen.has(key)) {
      bump('duplicate_identity');
      continue;
    }
    seen.add(key);
    if (!identityKeyTypesUsed.includes(type)) identityKeyTypesUsed.push(type);
    // Preserve original purchase URL (no rewrite)
    deduped.push(p);
  }

  return {
    products: deduped,
    stats: {
      productsBeforeDedupe,
      productsAfterDedupe: deduped.length,
      categoryMismatchRemovals,
      identityKeyTypesUsed,
      removedReasons,
    },
  };
}

export { QUALITY_TUNE_MIN_VALID_PRODUCTS };
