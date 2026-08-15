/**
 * Retailer-neutral purchase-option normalization for Dressing Room snapshots.
 * Fail-open on malformed entries; never rank by commission.
 */

import type { CanonicalPurchaseOption } from '../types/canonicalDressingRoomItem';

const MAX_OPTIONS = 24;
const MAX_TEXT = 200;
const MAX_URL = 2000;
/**
 * Query keys that identify CREDENTIAL material or an object-storage signing
 * scheme — never a merchant's own link format.
 *
 * KSB29-025 / DEF-032. This set previously also contained the generic names
 * `token`, `sig`, `signature`, `expires`, `expires_at` and `policy`. Legitimate
 * commerce providers routinely use signed and expiring product links, so those
 * entries rejected real retailer destinations and silently emptied the purchase
 * options on perfectly valid scans. That made the filter simultaneously too
 * aggressive here and, because PurchaseOptionsPanel bypassed the safety layer
 * entirely, too weak where it mattered.
 *
 * The security boundary is the DESTINATION — protocol, host, credentials,
 * private-network targets — plus the value-shaped rules below, not a generic
 * parameter name. What remains here is either an explicit credential
 * (`access_token`, `api_key`, `authorization`, `secret`, `jwt`, `id_token`,
 * `credential(s)`) or an unambiguous object-storage signing parameter
 * (`awsaccesskeyid`, `googleaccessid`, `key-pair-id`, plus the `x-amz-` /
 * `x-goog-` prefixes and the Supabase `/storage/v1/object/sign/` path check).
 * Those still keep K Scan's own signed URLs out of a persisted, shareable
 * purchase-option snapshot, which is what this filter exists for.
 */
const SENSITIVE_URL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'awsaccesskeyid',
  'credential',
  'credentials',
  'googleaccessid',
  'id_token',
  'jwt',
  'key-pair-id',
  'secret',
]);

function cleanText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, max);
  }
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * Return only durable HTTPS commerce URLs.
 *
 * Merchant tracking/affiliate parameters are retained — including signed and
 * expiring merchant links, which are normal in commerce — but credentials,
 * object-storage signing parameters, user-info credentials and JWT-shaped
 * values are never allowed into a persisted purchase-option snapshot.
 */
export function normalizePersistedCommerceUrl(value: unknown): string | null {
  const text = cleanText(value, MAX_URL);
  if (!text || !/^https:\/\//i.test(text)) return null;

  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    if (/\/storage\/v1\/object\/sign\//i.test(parsed.pathname)) return null;

    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    for (const rawKey of [...parsed.searchParams.keys(), ...hashParams.keys()]) {
      const key = rawKey.toLowerCase();
      if (
        key.startsWith('x-amz-') ||
        key.startsWith('x-goog-') ||
        SENSITIVE_URL_QUERY_KEYS.has(key)
      ) {
        return null;
      }
    }

    const decoded = (() => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    })();
    // Same policy as the key set above: explicit credential names only. `sig`,
    // `signature` and bare `token` are deliberately absent — they are ordinary
    // merchant link parameters, and rejecting them destroyed valid commerce.
    if (/(?:[?&#]|%3[ffb])(?:access_token|api_?key|authorization|credentials?|id_token|jwt|secret)=/i.test(decoded)) {
      return null;
    }
    if (/(?:^|[/?&=])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[?&#/])/i.test(decoded)) {
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

/** Format canonical string/number prices without dropping their currency. */
export function formatCommercePrice(
  price: unknown,
  currency: unknown = 'USD',
): string | null {
  if (price === null || price === undefined) return null;

  const currencyCode =
    typeof currency === 'string' && /^[a-z]{3}$/i.test(currency.trim())
      ? currency.trim().toUpperCase()
      : 'USD';
  const numeric =
    typeof price === 'number'
      ? price
      : typeof price === 'string' && /^\d+(?:\.\d+)?$/.test(price.trim().replace(/,/g, ''))
        ? Number(price.trim().replace(/,/g, ''))
        : null;

  if (numeric !== null) {
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currencyCode,
      }).format(numeric);
    } catch {
      return currencyCode === 'USD' ? `$${numeric.toFixed(2)}` : `${currencyCode} ${numeric.toFixed(2)}`;
    }
  }

  if (typeof price !== 'string') return null;
  const text = cleanText(price, 64);
  if (!text || text === '0' || text === '0.00' || text === '$0.00') return null;
  return text;
}

/** Open a persisted commerce destination without leaking handler failures. */
export async function openPersistedCommerceUrl(
  value: unknown,
  openUrl: (url: string) => Promise<unknown>,
): Promise<boolean> {
  const url = normalizePersistedCommerceUrl(value);
  if (!url || typeof openUrl !== 'function') return false;
  try {
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
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
      normalizePersistedCommerceUrl(record.productUrl) ||
      normalizePersistedCommerceUrl(record.product_url) ||
      normalizePersistedCommerceUrl(record.purchaseUrl) ||
      normalizePersistedCommerceUrl(record.purchase_url) ||
      normalizePersistedCommerceUrl(record.url) ||
      normalizePersistedCommerceUrl(record.link);
    const affiliateUrl =
      normalizePersistedCommerceUrl(record.affiliateUrl) ||
      normalizePersistedCommerceUrl(record.affiliate_url);
    const imageUrl =
      normalizePersistedCommerceUrl(record.imageUrl) ||
      normalizePersistedCommerceUrl(record.image_url) ||
      normalizePersistedCommerceUrl(record.thumbnail) ||
      normalizePersistedCommerceUrl(record.thumbnailUrl);

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
