/**
 * Deterministic provider-result agreement scoring (v122).
 * Local only — no model or provider calls. Retailer identity never contributes.
 */

import {
  categoryToScannerRoute,
  type ScannerCategoryRoute,
} from './scannerCategoryRoute.ts';
import {
  normalizeCategory,
  normalizeColor,
  normalizeMaterial,
  normalizeSilhouette,
} from './qualityTuneNormalize.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

// ── Positive weights ─────────────────────────────────────────────────────────

export const AGREEMENT_EXACT_CATEGORY = 30;
export const AGREEMENT_COMPATIBLE_SUBTYPE = 25;
export const AGREEMENT_DOMINANT_COLOR = 15;
export const AGREEMENT_SUPPORTED_MATERIAL = 10;
export const AGREEMENT_SILHOUETTE_OR_SHAPE = 10;
export const AGREEMENT_PATTERN_OR_DETAIL = 5;
export const AGREEMENT_VERIFIED_BRAND = 5;

// ── Penalties ────────────────────────────────────────────────────────────────

export const PENALTY_CLEAR_CATEGORY_CONFLICT = -40;
export const PENALTY_CLEAR_SUBTYPE_CONFLICT = -25;
export const PENALTY_COLOR_CONFLICT = -10;
export const PENALTY_UNSUPPORTED_BRAND_ONLY_MATCH = -10;
export const PENALTY_GENERIC_TITLE = -15;
export const PENALTY_INVALID_URL = -30;
export const PENALTY_MISSING_IMAGE = -15;
export const PENALTY_INVALID_PRICE_FORMAT = -5;
export const PENALTY_NEGATIVE_PRICE = -10;

export const AGREEMENT_STRONG_THRESHOLD = 75;
export const AGREEMENT_USABLE_THRESHOLD = 50;

export type AgreementBand = 'strong' | 'usable' | 'weak';

export type AgreementScoreResult = {
  score: number;
  band: AgreementBand;
  clearCategoryConflict: boolean;
};

const DEMO_HOST_HINTS = [
  'example.com', 'localhost', 'test.', 'demo.', 'placeholder', 'lorem',
] as const;

/** Subtype tokens compatible with each catalog category — module-scoped. */
const COMPATIBLE_SUBTYPE_TOKENS: Readonly<Record<string, ReadonlySet<string>>> = {
  outerwear: new Set([
    'jacket', 'moto', 'biker', 'bomber', 'puffer', 'parka', 'trench', 'coat',
    'raincoat', 'windbreaker', 'anorak', 'overcoat', 'peacoat', 'vest', 'blazer',
  ]),
  blazer: new Set(['blazer', 'sport coat', 'suit jacket']),
  dress: new Set(['dress', 'gown', 'skirt', 'sundress', 'slip']),
  pants: new Set([
    'pants', 'trousers', 'jeans', 'chino', 'jogger', 'legging', 'shorts', 'culotte',
  ]),
  top: new Set([
    'top', 'shirt', 'blouse', 'sweater', 'tee', 't-shirt', 'hoodie', 'polo',
    'cardigan', 'tank', 'bodysuit', 'jumpsuit', 'romper',
  ]),
  footwear: new Set([
    'boot', 'boots', 'sneaker', 'sneakers', 'heel', 'heels', 'loafer', 'loafers',
    'sandal', 'sandals', 'oxford', 'oxfords', 'mule', 'mules', 'espadrille',
    'slipper', 'slippers', 'ballet', 'flat', 'flats', 'pump', 'pumps',
  ]),
  bag: new Set([
    'handbag', 'tote', 'crossbody', 'clutch', 'backpack', 'shoulder', 'satchel',
    'bucket', 'purse',
  ]),
  accessory: new Set([
    'belt', 'scarf', 'sunglass', 'sunglasses', 'hat', 'jewelry', 'earring',
    'earrings', 'necklace', 'bracelet', 'watch', 'tie', 'glove', 'gloves', 'brooch',
  ]),
};

const CATEGORY_CONFLICTS: Readonly<Record<string, readonly string[]>> = {
  footwear: ['dress', 'blazer', 'bag', 'pants', 'top', 'outerwear'],
  bag: ['footwear', 'dress', 'blazer', 'pants', 'top'],
  dress: ['footwear', 'bag', 'blazer'],
  blazer: ['footwear', 'bag', 'dress'],
  pants: ['footwear', 'bag', 'dress'],
  outerwear: ['footwear', 'bag'],
  top: ['footwear', 'bag'],
  accessory: ['footwear', 'bag', 'dress', 'pants'],
};

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function productText(p: RecommendedProduct): string {
  const rec = p as unknown as Record<string, unknown>;
  return [
    typeof p.title === 'string' ? p.title : '',
    typeof rec.category === 'string' ? rec.category : '',
    typeof rec.item_type === 'string' ? rec.item_type : '',
    typeof rec.brand === 'string' ? rec.brand : '',
    typeof p.type === 'string' ? p.type : '',
  ].join(' ').toLowerCase();
}

function hasUsableImage(p: RecommendedProduct): boolean {
  const url = typeof p.imageUrl === 'string' ? p.imageUrl.trim() : '';
  return !!url && /^https?:\/\//i.test(url);
}

function hasValidPurchaseUrl(p: RecommendedProduct): boolean {
  const url = typeof p.productUrl === 'string' ? p.productUrl.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    if (DEMO_HOST_HINTS.some((h) => u.hostname.includes(h))) return false;
    return true;
  } catch {
    return false;
  }
}

function parseNumericPrice(price: unknown): { kind: 'missing' | 'valid' | 'invalid' | 'negative'; value: number | null } {
  if (price === undefined || price === null || price === '') {
    return { kind: 'missing', value: null };
  }
  if (typeof price === 'number') {
    if (!Number.isFinite(price)) return { kind: 'invalid', value: null };
    if (price < 0) return { kind: 'negative', value: price };
    if (price === 0) return { kind: 'missing', value: null }; // treat zero as missing
    return { kind: 'valid', value: price };
  }
  if (typeof price !== 'string') return { kind: 'invalid', value: null };
  const t = price.trim();
  if (!t) return { kind: 'missing', value: null };
  if (t === 'NaN' || t === 'null' || t === 'undefined') return { kind: 'invalid', value: null };
  const cleaned = t.replace(/[^0-9.,\-]/g, '').replace(/,/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return { kind: 'invalid', value: null };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { kind: 'invalid', value: null };
  if (n < 0) return { kind: 'negative', value: n };
  if (n === 0) return { kind: 'missing', value: null };
  return { kind: 'valid', value: n };
}

function hasVerifiedBrandEvidence(garment: Record<string, unknown>): boolean {
  return garment.logo_detected === true ||
    (typeof garment.visible_brand_text === 'string' &&
      collapseSpaces(garment.visible_brand_text).length > 0);
}

function subtypeCompatible(category: string, subtype: string): boolean {
  const tokens = COMPATIBLE_SUBTYPE_TOKENS[category];
  if (!tokens || !subtype) return false;
  const lower = subtype.toLowerCase();
  for (const tok of tokens) {
    if (lower.includes(tok)) return true;
  }
  return false;
}

function clearSubtypeConflict(garmentCat: string, garmentSubtype: string, text: string): boolean {
  if (!garmentSubtype || !garmentCat) return false;
  // If product clearly belongs to a conflicting category family via subtype tokens
  for (const [cat, tokens] of Object.entries(COMPATIBLE_SUBTYPE_TOKENS)) {
    if (cat === garmentCat) continue;
    const conflicts = CATEGORY_CONFLICTS[garmentCat] || [];
    if (!conflicts.includes(cat)) continue;
    for (const tok of tokens) {
      if (text.includes(tok) && !subtypeCompatible(garmentCat, text)) {
        // Only when garment subtype is present and product shows conflicting subtype
        if (!text.includes(garmentSubtype.toLowerCase().split(' ')[0]!)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function agreementBandFromScore(score: number): AgreementBand {
  if (score >= AGREEMENT_STRONG_THRESHOLD) return 'strong';
  if (score >= AGREEMENT_USABLE_THRESHOLD) return 'usable';
  return 'weak';
}

export function clampAgreementScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Score a provider product against the normalized Scanner garment result.
 * Deterministic: same inputs → same score. Retailer identity ignored.
 */
export function scoreProductAgreement(
  product: RecommendedProduct,
  garment: Record<string, unknown>,
  _route?: ScannerCategoryRoute | null,
): AgreementScoreResult {
  let score = 0;
  const text = productText(product);
  const garmentCat = normalizeCategory(
    typeof garment.item_type === 'string' ? garment.item_type : '',
  );
  const garmentSubtype = typeof garment.subtype === 'string'
    ? garment.subtype.toLowerCase()
    : '';
  const garmentColor = normalizeColor(
    typeof garment.primary_color === 'string' ? garment.primary_color : '',
  );
  const garmentMaterial = normalizeMaterial(
    typeof garment.material_estimate === 'string' ? garment.material_estimate : '',
  );
  const garmentSilhouette = normalizeSilhouette(
    typeof garment.silhouette === 'string' ? garment.silhouette : '',
  );
  const garmentPattern = typeof garment.pattern === 'string'
    ? garment.pattern.toLowerCase()
    : '';

  const productCat = normalizeCategory(text);
  let clearCategoryConflict = false;

  // Category agreement / conflict
  if (garmentCat && garmentCat !== 'NON_FASHION' && garmentCat !== 'unknown') {
    if (productCat === garmentCat || (productCat && text.includes(garmentCat))) {
      score += AGREEMENT_EXACT_CATEGORY;
    } else if (productCat) {
      const conflicts = CATEGORY_CONFLICTS[garmentCat] || [];
      if (conflicts.includes(productCat)) {
        score += PENALTY_CLEAR_CATEGORY_CONFLICT;
        clearCategoryConflict = true;
      } else {
        // Same route soft credit via route map
        const gRoute = categoryToScannerRoute(garmentCat);
        const pRoute = categoryToScannerRoute(productCat);
        if (gRoute && pRoute && gRoute === pRoute) {
          score += Math.floor(AGREEMENT_EXACT_CATEGORY * 0.6);
        }
      }
    }
  }

  // Subtype
  if (garmentSubtype) {
    const subToken = garmentSubtype.split(/\s+/).filter((w) => w.length > 2);
    const matched = subToken.some((t) => text.includes(t));
    if (matched || subtypeCompatible(garmentCat, text)) {
      score += AGREEMENT_COMPATIBLE_SUBTYPE;
    } else if (clearSubtypeConflict(garmentCat, garmentSubtype, text)) {
      score += PENALTY_CLEAR_SUBTYPE_CONFLICT;
    }
  }

  // Color
  if (garmentColor) {
    const colorKey = garmentColor.split('/')[0]!;
    if (text.includes(colorKey) || text.includes(garmentColor.replace('/', ' '))) {
      score += AGREEMENT_DOMINANT_COLOR;
    } else {
      // Conflicting strong color words
      const strongColors = ['black', 'white', 'red', 'navy', 'blue', 'green', 'brown', 'pink'];
      const garmentIs = strongColors.find((c) => colorKey.includes(c));
      const productHasOther = strongColors.some((c) => c !== garmentIs && text.includes(c));
      if (garmentIs && productHasOther && !text.includes(garmentIs)) {
        score += PENALTY_COLOR_CONFLICT;
      }
    }
  }

  // Material
  if (garmentMaterial) {
    const matKey = garmentMaterial.split('/')[0]!;
    if (text.includes(matKey)) score += AGREEMENT_SUPPORTED_MATERIAL;
  }

  // Silhouette / shape
  if (garmentSilhouette) {
    const silKey = garmentSilhouette.split('/')[0]!;
    if (text.includes(silKey) || text.includes(garmentSilhouette.replace('/', ' '))) {
      score += AGREEMENT_SILHOUETTE_OR_SHAPE;
    }
  }

  // Pattern / detail
  if (garmentPattern && garmentPattern !== 'solid' && text.includes(garmentPattern)) {
    score += AGREEMENT_PATTERN_OR_DETAIL;
  }

  // Verified brand only
  if (hasVerifiedBrandEvidence(garment)) {
    const brand = typeof garment.visible_brand_text === 'string'
      ? garment.visible_brand_text.toLowerCase()
      : typeof garment.brand_guess === 'string'
      ? garment.brand_guess.toLowerCase()
      : '';
    if (brand && text.includes(brand)) {
      score += AGREEMENT_VERIFIED_BRAND;
    }
  } else {
    // Speculative brand-only match in title without garment evidence
    const guess = typeof garment.brand_guess === 'string' ? garment.brand_guess.toLowerCase() : '';
    if (guess && text.includes(guess) && !hasVerifiedBrandEvidence(garment)) {
      // Only penalize when brand appears to be the sole signal (no category match)
      if (score < AGREEMENT_EXACT_CATEGORY) {
        score += PENALTY_UNSUPPORTED_BRAND_ONLY_MATCH;
      }
    }
  }

  // Structural penalties
  const title = typeof product.title === 'string' ? product.title.trim() : '';
  if (!title || /^(product|item|fashion|clothing|unknown)$/i.test(title) || title.length < 4) {
    score += PENALTY_GENERIC_TITLE;
  }
  if (!hasValidPurchaseUrl(product)) score += PENALTY_INVALID_URL;
  if (!hasUsableImage(product)) score += PENALTY_MISSING_IMAGE;

  const priceInfo = parseNumericPrice(product.price);
  if (priceInfo.kind === 'invalid') score += PENALTY_INVALID_PRICE_FORMAT;
  if (priceInfo.kind === 'negative') score += PENALTY_NEGATIVE_PRICE;
  // missing / zero → no penalty

  const clamped = clampAgreementScore(score);
  return {
    score: clamped,
    band: agreementBandFromScore(clamped),
    clearCategoryConflict,
  };
}

export { parseNumericPrice };
