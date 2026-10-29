import { sanitizeGarment, safeCatalogUrl, text } from './validation.ts';
import type { FashionAttributes } from './contracts.ts';

export type AuthorizedMerchant = {
  id: string; brandId: string; status: string; catalogStatus: string;
  identityExpiresAt: string; sourceAuthorizedUntil: string;
  sourceKind: 'authorized_json' | 'shopify_storefront'; authorizationRef: string;
  approvedDomains: string[]; imageDomains: string[]; markets: string[];
};
export type FeedProduct = {
  sourceProductId: string; variantId?: string; sku?: string; title: string;
  category: string; subtype?: string; attributes?: Partial<FashionAttributes>;
  imageUrl?: string | null; productUrl: string; priceAmount?: string | number | null;
  currency?: string | null; availability?: 'in_stock' | 'out_of_stock' | 'unknown';
  sizes?: string[]; markets: string[]; provenanceRef: string;
};
export type NormalizedFeedProduct = {
  source_product_id: string; variant_id: string; sku: string | null; title: string;
  category: string; subtype: string | null; attributes: Partial<FashionAttributes>;
  image_url: string | null; product_url: string; price_amount: number | null;
  currency: string | null; availability: string; sizes: string[]; markets: string[];
  source_provenance_ref: string;
};
export interface CatalogAdapter {
  kind: AuthorizedMerchant['sourceKind'];
  snapshot: (signal: AbortSignal) => Promise<{ products: FeedProduct[]; complete: boolean }>;
}
export function assertAuthorizedMerchant(m: AuthorizedMerchant, now = Date.now()) {
  if (m.status !== 'active' || m.catalogStatus !== 'approved' || !m.authorizationRef
    || !Number.isFinite(Date.parse(m.identityExpiresAt)) || Date.parse(m.identityExpiresAt) <= now
    || !Number.isFinite(Date.parse(m.sourceAuthorizedUntil)) || Date.parse(m.sourceAuthorizedUntil) <= now) throw new Error('merchant_not_authorized');
}
export function normalizeFeed(products: FeedProduct[], merchant: AuthorizedMerchant): NormalizedFeedProduct[] {
  if (!Array.isArray(products) || products.length > 500) throw new Error('feed_limit');
  const ids = new Set<string>(); const skus = new Set<string>();
  return products.map((p) => {
    const id = text(p.sourceProductId); const variant = text(p.variantId) ?? '';
    const key = `${id}\u0000${variant}`;
    const title = text(p.title, 240); const sku = text(p.sku) ?? null;
    if (!id || !title || title.length < 4 || ids.has(key) || (sku && skus.has(sku))) throw new Error('duplicate_or_invalid_product');
    ids.add(key); if (sku) skus.add(sku);
    const garment = sanitizeGarment({ ...p.attributes, item_type: p.category, ...(p.subtype ? { subtype: p.subtype } : {}) });
    const destination = safeCatalogUrl(p.productUrl, merchant.approvedDomains);
    const image = p.imageUrl ? safeCatalogUrl(p.imageUrl, merchant.imageDomains) : null;
    if (!destination || (p.imageUrl && !image)) throw new Error('unsafe_catalog_url');
    let amount: number | null = null;
    if (p.priceAmount != null) {
      if ((typeof p.priceAmount !== 'number' && typeof p.priceAmount !== 'string') || !/^\d+(\.\d{1,4})?$/.test(String(p.priceAmount))) throw new Error('invalid_price');
      amount = Number(p.priceAmount);
      if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e10) throw new Error('invalid_price');
    }
    const currency = p.currency == null ? null : p.currency.toUpperCase();
    if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new Error('invalid_currency');
    if (!Array.isArray(p.markets) || p.markets.length > 60 || p.markets.some((v) => !/^[A-Z]{2}$/.test(v) || !merchant.markets.includes(v))) throw new Error('invalid_market');
    if (p.sizes && (!Array.isArray(p.sizes) || p.sizes.length > 40)) throw new Error('invalid_sizes');
    if (p.availability && !['in_stock','out_of_stock','unknown'].includes(p.availability)) throw new Error('invalid_availability');
    const provenance = text(p.provenanceRef, 256);
    if (!provenance || provenance.length < 4) throw new Error('missing_provenance');
    return { source_product_id: id, variant_id: variant, sku, title, category: garment.item_type,
      subtype: garment.subtype ?? null, attributes: garment, image_url: image, product_url: destination,
      price_amount: amount, currency, availability: p.availability ?? 'unknown',
      sizes: (p.sizes ?? []).map((s) => text(s, 40) ?? '').filter(Boolean), markets: [...new Set(p.markets)], source_provenance_ref: provenance };
  });
}
export type CatalogStore = {
  merchant: (id: string, signal: AbortSignal) => Promise<AuthorizedMerchant>;
  begin: (id: string, key: string, signal: AbortSignal) => Promise<{ status: 'running' | 'succeeded'; productCount: number }>;
  ingest: (id: string, key: string, products: NormalizedFeedProduct[], complete: boolean, signal: AbortSignal) => Promise<number>;
  failed: (id: string, key: string, code: 'source_unavailable' | 'invalid_feed', signal: AbortSignal) => Promise<void>;
};
/** Server-only worker entry. Merchant authorization is read before source access;
 * SQL rechecks it inside the atomic upsert. Never takes credentials from clients. */
export async function synchronizeCatalog(store: CatalogStore, merchantId: string, key: string, adapterFor: (m: AuthorizedMerchant) => CatalogAdapter, signal?: AbortSignal) {
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(key)) throw new Error('invalid_idempotency_key');
  const scope = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]);
  const merchant = await store.merchant(merchantId, scope);
  assertAuthorizedMerchant(merchant);
  const reservation = await store.begin(merchantId, key, scope);
  if (reservation.status === 'succeeded') return reservation.productCount;
  const adapter = adapterFor(merchant);
  if (adapter.kind !== merchant.sourceKind) throw new Error('unauthorized_source');
  let snapshot;
  try { snapshot = await adapter.snapshot(scope); }
  catch { await store.failed(merchantId, key, 'source_unavailable', AbortSignal.timeout(1000)).catch(() => undefined); throw new Error('source_unavailable'); }
  let products;
  try { products = normalizeFeed(snapshot.products, merchant); }
  catch { await store.failed(merchantId, key, 'invalid_feed', AbortSignal.timeout(1000)).catch(() => undefined); throw new Error('invalid_feed'); }
  try { return await store.ingest(merchantId, key, products, snapshot.complete === true, scope); }
  catch { await store.failed(merchantId, key, 'invalid_feed', AbortSignal.timeout(1000)).catch(() => undefined); throw new Error('ingestion_rejected'); }
}
