/**
 * Safe normalization for persisted purchase-option arrays.
 *
 * Supabase JSONB returns arrays as arrays, but local filesystem JSON may have
 * been stringified or partially corrupted. This helper degrades every unsafe
 * value to an empty array without mutating the source.
 */

export type NormalizedPurchaseOption = Record<string, unknown> & {
  id?: string;
  title?: string;
  retailer?: string;
  brand?: string;
  type?: string;
  price?: string | number;
  currency?: string;
  priceLabel?: string;
  availability?: string;
  availabilityLabel?: string;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  affiliateUrl?: string | null;
  imageUrl?: string | null;
};

const MAX_ID_LENGTH = 160;
const MAX_TEXT_LENGTH = 320;
const MAX_URL_LENGTH = 2048;

export function normalizePurchaseOptions(value: unknown): NormalizedPurchaseOption[] {
  const parsed = parsePurchaseOptionsArray(value);
  if (!parsed) return [];

  const normalized: NormalizedPurchaseOption[] = [];
  const seen = new Set<string>();

  for (const option of parsed) {
    const safe = normalizePurchaseOption(option);
    if (!safe) continue;
    const key = purchaseOptionIdentity(safe);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(safe);
  }

  return normalized;
}

/**
 * True only for a real array or a stringified JSON array. Invalid persisted
 * values must not be treated as an intentional empty commerce snapshot.
 */
export function isPurchaseOptionsSnapshot(value: unknown): boolean {
  return parsePurchaseOptionsArray(value) !== null;
}

/**
 * True when a persisted purchase option has enough renderer-usable identity to
 * be displayed. Does not invent missing retailer, price, URL, or product data.
 */
export function isRenderablePurchaseOption(option: unknown): boolean {
  return normalizePurchaseOption(option) !== null;
}

function hasAnyKey(value: object, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parsePurchaseOptionsArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizePurchaseOption(option: unknown): NormalizedPurchaseOption | null {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return null;

  const record = option as Record<string, unknown>;
  const normalized: NormalizedPurchaseOption = {};

  assignText(normalized, 'id', record.id, MAX_ID_LENGTH);
  assignText(normalized, 'title', record.title ?? record.name ?? record.displayName ?? record.product_name);
  assignText(normalized, 'retailer', record.retailer ?? record.source ?? record.merchant ?? record.store);
  assignText(normalized, 'brand', record.brand);
  assignText(normalized, 'type', record.type);
  assignText(normalized, 'currency', record.currency, 24);
  assignText(normalized, 'priceLabel', record.priceLabel ?? record.price_label);
  assignText(normalized, 'availability', record.availability);
  assignText(normalized, 'availabilityLabel', record.availabilityLabel ?? record.availability_label);

  if (typeof record.price === 'number' && Number.isFinite(record.price)) {
    normalized.price = record.price;
  } else {
    const price = safeText(record.price);
    if (price) normalized.price = price;
  }

  const productUrlAliases = ['productUrl', 'product_url', 'purchaseUrl', 'purchase_url', 'url', 'link'];
  const purchaseUrlAliases = ['purchaseUrl', 'purchase_url'];
  const affiliateUrlAliases = ['affiliateUrl', 'affiliate_url'];
  const imageUrlAliases = ['imageUrl', 'image_url', 'thumbnail', 'thumbnailUrl', 'image_src', 'product_image_url'];

  if (hasAnyKey(record, productUrlAliases)) {
    normalized.productUrl = firstSafeHttpUrl(...productUrlAliases.map((key) => record[key]));
  }
  if (hasAnyKey(record, purchaseUrlAliases)) {
    normalized.purchaseUrl = firstSafeHttpUrl(...purchaseUrlAliases.map((key) => record[key]));
  }
  if (hasAnyKey(record, affiliateUrlAliases)) {
    normalized.affiliateUrl = firstSafeHttpUrl(...affiliateUrlAliases.map((key) => record[key]));
  }
  if (hasAnyKey(record, imageUrlAliases)) {
    normalized.imageUrl = firstSafeHttpUrl(...imageUrlAliases.map((key) => record[key]));
  }

  return normalized.id ||
      normalized.title ||
      normalized.retailer ||
      normalized.productUrl ||
      normalized.imageUrl
    ? normalized
    : null;
}

function assignText(
  target: NormalizedPurchaseOption,
  key: keyof NormalizedPurchaseOption,
  value: unknown,
  maxLength = MAX_TEXT_LENGTH,
): void {
  const text = safeText(value, maxLength);
  if (text) Object.assign(target, { [key]: text });
}

function firstSafeHttpUrl(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_URL_LENGTH) continue;
    try {
      const parsed = new URL(value.trim());
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        !parsed.username &&
        !parsed.password
      ) {
        return parsed.toString();
      }
    } catch {
      // Keep looking for another supported URL alias.
    }
  }
  return null;
}

function safeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function purchaseOptionIdentity(option: NormalizedPurchaseOption): string {
  if (option.id) return `id:${option.id.toLowerCase()}`;
  if (option.productUrl) return `url:${option.productUrl}`;
  return `content:${[
    option.retailer ?? '',
    option.title ?? '',
    option.priceLabel ?? option.price ?? '',
  ].map((value) => String(value).toLowerCase()).join('|')}`;
}
