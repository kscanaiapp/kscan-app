/**
 * Canonical Product + Offer model (v127).
 *
 * The same real-world item listed by three retailers is one product with three
 * offers, not three products. Phase 3 treated every listing as independent,
 * which is why a shelf can show the same jacket repeatedly and why there is no
 * place to hang a price comparison or a future checkout decision.
 *
 * This is a normalization and grouping layer only. It does not rank, does not
 * filter, and does not change what the existing shelf renders — the flat
 * product list is still produced exactly as before, with the canonical view
 * offered alongside it. Grouping never drops an offer.
 */

import type { RecommendedProduct } from './shoppingProvider.ts';

export type CanonicalOffer = {
  offerId: string;
  /** Provider that surfaced this listing. Never a ranking input. */
  source: string;
  retailer: string;
  providerProductId: string | null;
  price: string | null;
  priceValue: number | null;
  currency: string | null;
  availability: string | null;
  condition: string | null;
  size: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  observedAt: string;
};

export type CanonicalProduct = {
  productKey: string;
  brand: string | null;
  model: string | null;
  title: string;
  imageUrl: string | null;
  offers: CanonicalOffer[];
  /** Lowest numeric price across offers, when any offer carries one. */
  lowestPriceValue: number | null;
  offerCount: number;
};

export type CanonicalCommerce = {
  products: CanonicalProduct[];
  /** Offers that were grouped away from the flat list, for telemetry only. */
  duplicateOfferCount: number;
};

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  '$': 'USD',
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
};

/** Words that never help decide whether two listings are the same product. */
const TITLE_NOISE: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'and', 'with', 'for', 'in', 'of', 'new', 'nwt', 'nwot',
  'authentic', 'genuine', 'rare', 'vintage', 'size', 'mens', 'womens', 'men',
  'women', 'unisex', 'sale', 'free', 'shipping', 'used', 'preowned',
  'pre-owned', 'excellent', 'condition', 'euc', 'nib',
]);

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = collapse(v);
  return t ? t : null;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Numeric price plus currency, parsed from whatever shape the provider used. */
export function parseOfferPrice(raw: unknown): { value: number | null; currency: string | null } {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { value: raw, currency: null };
  }
  if (typeof raw !== 'string') return { value: null, currency: null };
  const t = raw.trim();
  if (!t) return { value: null, currency: null };

  let currency: string | null = null;
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (t.includes(symbol)) {
      currency = code;
      break;
    }
  }
  const isoMatch = t.match(/\b(USD|GBP|EUR|JPY|CAD|AUD)\b/i);
  if (isoMatch) currency = isoMatch[1].toUpperCase();

  const cleaned = t.replace(/[^0-9.,]/g, '').replace(/,/g, '');
  if (!cleaned) return { value: null, currency };
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return { value: null, currency };
  return { value: n, currency };
}

/**
 * Identity tokens for a listing title: brand and model survive, marketplace
 * noise ("NWT", "size M", "free shipping") does not. Two listings of the same
 * product from different retailers should reduce to the same token set.
 */
function titleIdentityTokens(title: string): string[] {
  const tokens = collapse(title)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !TITLE_NOISE.has(t));
  return [...new Set(tokens)].sort();
}

/**
 * Group key for a listing.
 *
 * Brand plus the distinctive title tokens. Retailer and provider are
 * deliberately absent: including either would make the same product from two
 * retailers group apart, which is the exact behavior this model exists to fix.
 */
export function canonicalProductKey(product: RecommendedProduct): string {
  const rec = product as unknown as Record<string, unknown>;
  const brand = (str(rec.brand) ?? '').toLowerCase();
  const tokens = titleIdentityTokens(product.title || '');
  // Cap the token set so one verbose marketplace title cannot fail to match a
  // concise retailer title for the same item.
  const identity = tokens.slice(0, 8).join(' ');
  return `p:${fnv1a(`${brand}|${identity}`)}`;
}

function toOffer(product: RecommendedProduct, observedAt: string): CanonicalOffer {
  const rec = product as unknown as Record<string, unknown>;
  const parsed = parseOfferPrice(product.price);
  return {
    offerId: product.id,
    source: product.source,
    retailer: str(rec.retailer) ?? product.source,
    providerProductId: str(rec.providerProductId) ?? str(rec.productId) ?? null,
    price: str(product.price),
    priceValue: parsed.value,
    currency: parsed.currency ?? str(rec.currency),
    availability: str(rec.availability),
    condition: str(rec.condition),
    size: str(rec.size) ?? str(rec.variant),
    productUrl: str(product.productUrl),
    imageUrl: str(product.imageUrl),
    observedAt,
  };
}

/**
 * Build the canonical view of a ranked product list.
 *
 * Input order is preserved: the first listing of a product determines that
 * product's position, so the canonical view has the same ordering the ranker
 * produced. No offer is discarded — duplicates become additional offers on an
 * existing product.
 */
export function buildCanonicalCommerce(
  products: RecommendedProduct[],
  opts?: { observedAt?: string },
): CanonicalCommerce {
  const observedAt = opts?.observedAt ?? new Date().toISOString();
  const byKey = new Map<string, CanonicalProduct>();
  let duplicateOfferCount = 0;

  for (const product of products) {
    if (!product || typeof product !== 'object') continue;
    const rec = product as unknown as Record<string, unknown>;
    const key = canonicalProductKey(product);
    const offer = toOffer(product, observedAt);

    const existing = byKey.get(key);
    if (existing) {
      // Same product, another retailer or another listing — an offer, not a
      // second product.
      if (!existing.offers.some((o) => o.productUrl === offer.productUrl)) {
        existing.offers.push(offer);
        duplicateOfferCount += 1;
      }
      if (!existing.imageUrl && offer.imageUrl) existing.imageUrl = offer.imageUrl;
      if (!existing.brand && str(rec.brand)) existing.brand = str(rec.brand);
      continue;
    }

    byKey.set(key, {
      productKey: key,
      brand: str(rec.brand),
      model: str(rec.model) ?? null,
      title: product.title,
      imageUrl: offer.imageUrl,
      offers: [offer],
      lowestPriceValue: offer.priceValue,
      offerCount: 1,
    });
  }

  const out: CanonicalProduct[] = [];
  for (const p of byKey.values()) {
    let lowest: number | null = null;
    for (const o of p.offers) {
      if (o.priceValue === null) continue;
      if (lowest === null || o.priceValue < lowest) lowest = o.priceValue;
    }
    out.push({ ...p, lowestPriceValue: lowest, offerCount: p.offers.length });
  }

  return { products: out, duplicateOfferCount };
}
