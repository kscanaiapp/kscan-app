/**
 * ProductShelf presentation facts on the current Build 35 authority.
 * Presentation only: no ranking, inference, provider call, retrieval, or model call.
 */
import { selectCommerceDestination } from '../commerceDestination';
import {
  formatCommercePrice,
  normalizeCommerceCurrency,
  normalizePersistedCommerceUrl,
} from '../dressingRoomCommerce';

export interface ShelfOfferFacts {
  id?: string;
  title?: string;
  displayName?: string;
  name?: string;
  product_name?: string;
  retailer?: string;
  brand?: string;
  category?: string | null;
  price?: string | number | null;
  currency?: string;
  availability?: string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  purchase_url?: string | null;
  product_url?: string | null;
  url?: string | null;
  link?: string | null;
  affiliateUrl?: string | null;
  commerceType?: 'retail' | 'resale';
}

export function shelfDestinationUrl(product: ShelfOfferFacts | null | undefined): string | null {
  if (!product) return null;
  return selectCommerceDestination(
    [
      product.productUrl, product.purchaseUrl, product.affiliateUrl,
      product.product_url, product.purchase_url, product.url, product.link,
    ].map((candidate) => normalizePersistedCommerceUrl(candidate)),
  );
}

export interface ShelfPriceView {
  text: string | null;
  currency: string | null;
  currencyUnconfirmed: boolean;
  amount: number | null;
  accessibilityText: string | null;
}

const SINGLE_AMOUNT_RE = /^[^\d-]{0,4}\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?[^\d]{0,4}$/;
function singleAmount(price: unknown): number | null {
  if (typeof price === 'number') return Number.isFinite(price) && price > 0 ? price : null;
  if (typeof price !== 'string') return null;
  const match = SINGLE_AMOUNT_RE.exec(price.trim());
  if (!match) return null;
  const n = Number(`${match[1].replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function shelfPriceView(product: ShelfOfferFacts | null | undefined): ShelfPriceView {
  const empty = { text: null, currency: null, currencyUnconfirmed: false, amount: null, accessibilityText: null };
  if (!product) return empty;
  const text = formatCommercePrice(product.price, product.currency);
  if (!text) return empty;
  const currency = normalizeCommerceCurrency(product.currency);
  if (!currency) {
    return { text, currency: null, currencyUnconfirmed: true, amount: null, accessibilityText: `Listed price ${text}, currency not confirmed` };
  }
  const visible = /[a-z]/i.test(text) ? text : `${text} ${currency}`;
  return { text: visible, currency, currencyUnconfirmed: false, amount: singleAmount(product.price), accessibilityText: `Price ${visible}` };
}

export function watchListingPrice(product: ShelfOfferFacts | null | undefined): string | undefined {
  if (!product || product.price == null) return undefined;
  const raw = String(product.price).trim();
  if (!raw) return undefined;
  const currency = normalizeCommerceCurrency(product.currency);
  if (!currency) return raw;
  return new RegExp(`(^|[^A-Z])${currency}([^A-Z]|$)`).test(raw.toUpperCase()) ? raw : `${raw} ${currency}`;
}

export function relativePriceText(subject: ShelfOfferFacts, reference: ShelfOfferFacts): string | null {
  const a = shelfPriceView(subject);
  const b = shelfPriceView(reference);
  if (a.amount == null || b.amount == null || !a.currency || a.currency !== b.currency) return null;
  const delta = Math.round((a.amount - b.amount) * 100) / 100;
  if (delta === 0) return 'Same price';
  const formatted = formatCommercePrice(Math.abs(delta), a.currency);
  if (!formatted) return null;
  const visible = /[a-z]/i.test(formatted) ? formatted : `${formatted} ${a.currency}`;
  return delta < 0 ? `${visible} less` : `${visible} more`;
}

export function shelfPurchaseState(product: ShelfOfferFacts | null | undefined): { action: string | null; status: string | null } {
  if (!product || !shelfDestinationUrl(product)) return { action: null, status: 'Purchase link unavailable' };
  const availability = typeof product.availability === 'string' ? product.availability.trim().toLowerCase() : '';
  if (['out_of_stock','out of stock','sold_out','sold out'].includes(availability)) {
    return { action: 'VIEW AT RETAILER', status: 'Out of stock' };
  }
  // Current ProductShelf has no transaction-readiness authority. A verified
  // destination proves only that a listing can be viewed, not that checkout is ready.
  return { action: 'VIEW AT RETAILER', status: null };
}

export function shelfCardKey(product: ShelfOfferFacts, index: number): string {
  const destination = shelfDestinationUrl(product);
  if (destination) return `url:${destination}:${index}`;
  if (typeof product.id === 'string' && product.id.trim()) return `id:${product.id.trim()}:${index}`;
  return `i:${index}`;
}

export function toggleCompareSelection(selection: readonly string[], key: string): string[] {
  if (selection.includes(key)) return selection.filter((entry) => entry !== key);
  if (selection.length >= 3) return [...selection];
  return [...selection, key];
}

export interface CompareRow { label: string; values: (string | null)[]; }

function titleOf(product: ShelfOfferFacts): string | null {
  const value = String(product.displayName || product.name || product.title || product.product_name || '').trim();
  return value || null;
}

export function buildCompareRows(
  products: readonly ShelfOfferFacts[],
  retailerOf: (product: ShelfOfferFacts) => string | null,
): CompareRow[] {
  const deltas = products.map((product, index) => index === 0 ? null : relativePriceText(product, products[0]));
  const anyDelta = deltas.some((value) => value !== null);
  const rows: CompareRow[] = [
    { label: 'Item', values: products.map(titleOf) },
    { label: 'Price', values: products.map((p) => {
      const price = shelfPriceView(p);
      return price.text ? (price.currencyUnconfirmed ? `${price.text} (currency not confirmed)` : price.text) : null;
    }) },
    { label: 'Price vs option 1', values: products.map((_, i) => anyDelta ? (i === 0 ? 'Reference' : deltas[i]) : null) },
    { label: 'Retailer', values: products.map(retailerOf) },
    { label: 'Brand', values: products.map((p) => typeof p.brand === 'string' && p.brand.trim() ? p.brand.trim() : null) },
    { label: 'Category', values: products.map((p) => typeof p.category === 'string' && p.category.trim() ? p.category.trim() : null) },
    { label: 'Listing', values: products.map((p) => p.commerceType === 'resale' ? 'Resale' : p.commerceType === 'retail' ? 'Retail' : null) },
    { label: 'Purchase', values: products.map((p) => {
      const state = shelfPurchaseState(p);
      return state.status ?? state.action;
    }) },
  ];
  return rows.filter((row) => row.label === 'Item' || row.values.some((value) => value !== null));
}
