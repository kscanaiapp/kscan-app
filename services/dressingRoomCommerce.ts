/**
 * Retailer-neutral purchase-option normalization for Dressing Room snapshots.
 * Fail-open on malformed entries; never rank by commission.
 */

import type { CanonicalPurchaseOption } from '../types/canonicalDressingRoomItem';

const MAX_OPTIONS = 24;
const MAX_TEXT = 200;
const MAX_URL = 2000;

function cleanText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, max);
  }
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function cleanHttpsUrl(value: unknown): string | null {
  const text = cleanText(value, MAX_URL);
  if (!text || !/^https:\/\//i.test(text)) return null;
  return text;
}

function cleanScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1_000_000) return null;
  return value;
}

function optionFingerprint(option: CanonicalPurchaseOption): string {
  return [
    (option.retailer ?? '').toLowerCase(),
    (option.productUrl ?? option.affiliateUrl ?? '').toLowerCase(),
    (option.price ?? '').toLowerCase(),
    (option.size ?? '').toLowerCase(),
    (option.variant ?? '').toLowerCase(),
    (option.productId ?? '').toLowerCase(),
  ].join('|');
}

/**
 * Normalize any Scanner/Saved-Scan/catalog commerce array into canonical options.
 * Preserves first-seen retailer order. Drops exact duplicates. Skips junk.
 */
export function normalizePurchaseOptions(raw: unknown): CanonicalPurchaseOption[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const out: CanonicalPurchaseOption[] = [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, MAX_OPTIONS * 2)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const productUrl =
      cleanHttpsUrl(record.productUrl) ||
      cleanHttpsUrl(record.product_url) ||
      cleanHttpsUrl(record.purchaseUrl) ||
      cleanHttpsUrl(record.purchase_url) ||
      cleanHttpsUrl(record.url) ||
      cleanHttpsUrl(record.link);
    const affiliateUrl =
      cleanHttpsUrl(record.affiliateUrl) ||
      cleanHttpsUrl(record.affiliate_url);
    const imageUrl =
      cleanHttpsUrl(record.imageUrl) ||
      cleanHttpsUrl(record.image_url) ||
      cleanHttpsUrl(record.thumbnail) ||
      cleanHttpsUrl(record.thumbnailUrl);

    const title =
      cleanText(record.title) ||
      cleanText(record.name) ||
      cleanText(record.displayName) ||
      cleanText(record.product_name) ||
      cleanText(record.productName);
    const retailer =
      cleanText(record.retailer) ||
      cleanText(record.brand) ||
      cleanText(record.merchant) ||
      cleanText(record.store) ||
      cleanText(record.source);

    // Require a shopping link, or at least title+retailer for incomplete catalog rows.
    if (!productUrl && !affiliateUrl && !(title && retailer)) continue;

    const option: CanonicalPurchaseOption = {
      title,
      retailer,
      price: cleanText(record.price, 64),
      currency: cleanText(record.currency, 8),
      productUrl,
      affiliateUrl,
      imageUrl,
      availability: cleanText(record.availability, 64),
      size: cleanText(record.size, 64) || cleanText(record.variantSize, 64),
      variant: cleanText(record.variant, 64) || cleanText(record.color, 64),
      matchScore:
        cleanScore(record.matchScore) ??
        cleanScore(record.match_score) ??
        cleanScore(record.similarityPercentage) ??
        cleanScore(record.similarity_percentage),
      confidence: cleanScore(record.confidence) ?? cleanScore(record.confidenceScore),
      provider: cleanText(record.provider) || cleanText(record.sourceProvider) || cleanText(record.source_provider),
      productId:
        cleanText(record.productId, 128) ||
        cleanText(record.product_id, 128) ||
        cleanText(record.id, 128) ||
        cleanText(record.external_product_id, 128) ||
        cleanText(record.externalProductId, 128),
    };

    const key = optionFingerprint(option);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(option);
    if (out.length >= MAX_OPTIONS) break;
  }

  return out;
}

/** Collect commerce arrays from any known Scanner/Closet alias bag. */
export function collectRawPurchaseOptions(source: Record<string, unknown> | null | undefined): unknown {
  if (!source || typeof source !== 'object') return [];
  const candidates = [
    source.purchaseOptions,
    source.purchase_options,
    source.recommendedProducts,
    source.recommended_products,
    source.products,
    source.productMatches,
    source.shoppingResults,
    source.shopping,
    source.similarityMatches,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}
