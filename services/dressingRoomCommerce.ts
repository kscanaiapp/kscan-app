/**
 * Retailer-neutral purchase-option normalization for Dressing Room snapshots.
 * Fail-open on malformed entries; never rank by commission.
 */

import type { CanonicalPurchaseOption } from '../types/canonicalDressingRoomItem';

/**
 * Currency handling shared by Scanner commerce surfaces.
 *
 * A currency code is only useful when it is both well-formed and known. Keeping
 * this list explicit prevents arbitrary provider text from becoming a trusted
 * currency label, while still allowing the current ISO 4217 set the app can
 * format.
 */
const ISO_4217_CURRENCY_CODES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP',
  'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR',
  'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS',
  'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP',
  'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO',
  'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN',
  'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG',
  'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC',
  'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD',
  'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST',
  'XAF', 'XCD', 'XCG', 'XDR', 'XOF', 'XPF', 'XSU', 'YER', 'ZAR', 'ZMW',
  'ZWG', 'ZWL',
]);

/** Return a normalized, known ISO 4217 code; never invent one. */
export function normalizeCommerceCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return ISO_4217_CURRENCY_CODES.has(code) ? code : null;
}

/**
 * Read an explicit ISO code embedded in an authoritative provider display
 * string. Symbols are intentionally not converted: "$" is a display symbol,
 * not proof that an amount is USD.
 */
export function currencyCodeFromDisplayPrice(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  for (const token of value.match(/[A-Za-z]{3}/g) ?? []) {
    const currency = normalizeCommerceCurrency(token);
    if (currency) return currency;
  }
  return null;
}

/** Format a numeric amount only when its currency is known. */
export function formatKnownCurrencyAmount(amount: number, currency: unknown): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currencyCode = normalizeCommerceCurrency(currency);
  if (!currencyCode) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
    }).format(amount);
  } catch {
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}

const MAX_OPTIONS = 24;
const MAX_TEXT = 200;
const MAX_URL = 2000;
const SENSITIVE_URL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'authorization',
  'awsaccesskeyid',
  'credential',
  'credentials',
  'expires',
  'expires_at',
  'googleaccessid',
  'id_token',
  'jwt',
  'key-pair-id',
  'policy',
  'secret',
  'signature',
  'sig',
  'token',
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

/** Preserve a finite numeric provider amount through the persisted string contract. */
function cleanCommercePrice(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? String(value) : null;
  }
  return cleanText(value, 64);
}

/**
 * Return only durable HTTPS commerce URLs.
 *
 * Merchant tracking/affiliate parameters are retained, but credentials,
 * expiring object signatures, user-info credentials and JWT-shaped values are
 * never allowed into a persisted purchase-option snapshot.
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
    if (/(?:[?&#]|%3[ffb])(?:access_token|api_?key|authorization|credentials?|id_token|jwt|secret|sig(?:nature)?|token)=/i.test(decoded)) {
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
  currency: unknown = null,
): string | null {
  if (price === null || price === undefined) return null;

  const numeric =
    typeof price === 'number'
      ? price
      : typeof price === 'string' && /^\d+(?:\.\d+)?$/.test(price.trim().replace(/,/g, ''))
        ? Number(price.trim().replace(/,/g, ''))
        : null;

  if (numeric !== null) {
    return formatKnownCurrencyAmount(numeric, currency);
  }

  if (typeof price !== 'string') return null;
  const text = cleanText(price, 64);
  if (!text || text === '0' || text === '0.00' || text === '$0.00') return null;
  // A provider-authored display string is safe to preserve only when its
  // accompanying currency is known. Otherwise even "$29.99" would silently
  // communicate an unproven USD price to the shopper.
  if (!normalizeCommerceCurrency(currency)) return null;
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
    (option.currency ?? '').toLowerCase(),
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
      price: cleanCommercePrice(record.price),
      currency: normalizeCommerceCurrency(record.currency),
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
