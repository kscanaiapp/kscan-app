import { scoreProductAgreement, AGREEMENT_STRONG_THRESHOLD } from '../scan-identify/commerceRelevanceAgreement.ts';
import { canonicalizeUrlForIdentity } from '../scan-identify/qualityTuneCommerce.ts';
import { buildCanonicalCommerce } from '../scan-identify/canonicalCommerce.ts';
import { formatOfferPrice } from '../scan-identify/offerCurrency.ts';
import { normalizeColor, normalizeMaterial, normalizeSilhouette } from '../scan-identify/qualityTuneNormalize.ts';
import { DISCOVERY_VERSION, type CatalogRow, type DiscoveryFlags, type DiscoveryInput, type DiscoveryProduct, type DiscoveryResponse, type OwnershipIdentity } from './contracts.ts';
import { safeCatalogUrl } from './validation.ts';

export const DISCOVERY_TIMEOUT_MS = 1200;
export const DISCOVERY_CACHE_MS = 30_000;
export const CANDIDATE_LIMIT = 160;
const CACHE_LIMIT = 64;
type Snapshot = { revision: number; rows: CatalogRow[]; ownership: Record<string, OwnershipIdentity> };
export type DiscoveryDependencies = {
  // The SQL RPC revalidates eligibility on every request, including cache hits.
  revision: (signal: AbortSignal) => Promise<number>;
  candidates: (input: DiscoveryInput, signal: AbortSignal) => Promise<Snapshot>;
  ownership: (input: DiscoveryInput, signal: AbortSignal) => Promise<Record<string, OwnershipIdentity>>;
  now?: () => number;
  event?: (event: string, payload: { lane: 'black_owned'; count: number }) => void;
};

export function emptyResponse(status: DiscoveryResponse['status'], now: number): DiscoveryResponse {
  return { version: DISCOVERY_VERSION, status, products: [], canonicalCommerce: { products: [], duplicateOfferCount: 0 }, primaryOwnership: {}, generatedAt: new Date(now).toISOString() };
}
function ownershipFor(row: CatalogRow): OwnershipIdentity {
  return { brandId: row.brand_id, brandName: row.brand_name, ownershipVerificationStatus: 'verified', publicOwnershipLabelAllowed: true, verifiedUntil: row.verified_until };
}
/** Structured attributes supply evidence. Merchant prose never reaches a model. */
export function rankCatalog(input: DiscoveryInput, rows: CatalogRow[], flags: DiscoveryFlags, now: number): DiscoveryProduct[] {
  const seen = new Set(input.primaryProducts.flatMap((p) => [p.id, canonicalizeUrlForIdentity(p.productUrl) ?? '']).filter(Boolean));
  const scored: { score: number; row: CatalogRow; product: DiscoveryProduct }[] = [];
  for (const row of rows.slice(0, CANDIDATE_LIMIT)) {
    if (row.eligible_until && (!Number.isFinite(Date.parse(row.eligible_until)) || Date.parse(row.eligible_until)<=now)) continue;
    if (row.category !== input.garment.item_type || row.availability !== 'in_stock') continue;
    if (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now || !Number.isFinite(Date.parse(row.verified_until)) || Date.parse(row.verified_until) <= now) continue;
    if (!Number.isFinite(Date.parse(row.synced_at)) || Date.parse(row.synced_at) > now || now - Date.parse(row.synced_at) > 24 * 3600_000) continue;
    if (!row.markets.includes(input.market)) continue;
    const productUrl = safeCatalogUrl(row.product_url, row.approved_domains);
    const imageUrl = safeCatalogUrl(row.image_url, row.image_domains);
    if (!productUrl || !imageUrl) continue;
    // V1 requires declared same subtype, avoiding the primary scorer's broader
    // within-category fallback (e.g. sandals must not stand in for boots).
    if (!input.garment.subtype || !row.subtype || row.subtype.trim().toLowerCase() !== input.garment.subtype.trim().toLowerCase()) continue;
    const attrs = row.attributes;
    const agreements = [
      [input.garment.primary_color, attrs.primary_color, normalizeColor],
      [input.garment.material_estimate, attrs.material_estimate, normalizeMaterial],
      [input.garment.silhouette, attrs.silhouette, normalizeSilhouette],
    ] as const;
    // Category/subtype alone are too weak to fill a shelf. Require actual
    // structured visual agreement; ownership and popularity contribute nothing.
    const matched = agreements.filter(([a, b, norm]) => a && b && norm(a) && norm(a) === norm(b));
    const patternMatch = input.garment.pattern && attrs.pattern && input.garment.pattern.toLowerCase() === attrs.pattern.toLowerCase();
    if (matched.length < 2 && !(matched.length >= 1 && patternMatch)) continue;
    const product: DiscoveryProduct = {
      id: row.id, productId: row.id, brandId: row.brand_id, merchantId: row.merchant_id,
      brandName: row.brand_name, brand: row.brand_name, title: row.title, source: row.brand_name,
      type: 'similar', matchType: 'similar', placementType: 'organic', imageUrl, productUrl,
      ...(formatOfferPrice(row.price_amount, row.currency) ? { price: formatOfferPrice(row.price_amount, row.currency) } : {}),
      ...(row.currency ? { currency: row.currency } : {}),
      ...(flags.badges ? { ownershipIdentity: ownershipFor(row) } : {}),
      inventoryVerifiedAt: row.synced_at, relevanceExplanation: 'Similar category, shape, or visual details.',
      checkoutCapability: 'product_destination',
    };
    // Score only catalog attributes, so keyword-stuffed titles cannot invent
    // similarity. The displayed official title stays unchanged.
    const evidence = { ...product, title: [row.category, row.subtype, attrs.primary_color, attrs.secondary_color, attrs.material_estimate, attrs.silhouette, attrs.pattern, ...(attrs.distinctive_features ?? [])].filter(Boolean).join(' ') };
    const result = scoreProductAgreement(evidence, input.garment);
    if (!result.clearCategoryConflict && result.score >= AGREEMENT_STRONG_THRESHOLD) scored.push({ score: result.score, row, product });
  }
  scored.sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id));
  const products: DiscoveryProduct[] = [];
  for (const { product, row } of scored) {
    const keys = [product.id, canonicalizeUrlForIdentity(product.productUrl) ?? '', `${row.merchant_id}:${row.source_product_id}`];
    if (keys.some((k) => k && seen.has(k))) continue;
    keys.filter(Boolean).forEach((k) => seen.add(k));
    products.push(product);
    if (products.length === 8) break;
  }
  return products;
}

export function createDiscoveryService(deps: DiscoveryDependencies) {
  const cache = new Map<string, { until: number; revision: number; rows: CatalogRow[] }>();
  return async (input: DiscoveryInput, flags: DiscoveryFlags, signal?: AbortSignal): Promise<DiscoveryResponse> => {
    const now = deps.now ?? Date.now;
    if (!flags.discovery && !flags.badges) return emptyResponse('unavailable', now());
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const emit = (event: string, count = 0) => { try { deps.event?.(event, { lane: 'black_owned', count }); } catch { /* telemetry cannot fail retrieval */ } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<DiscoveryResponse>((resolve) => {
      const unavailable = () => resolve(emptyResponse('unavailable', now()));
      controller.signal.addEventListener('abort', unavailable, { once: true });
      if (controller.signal.aborted) unavailable();
      timer = setTimeout(abort, DISCOVERY_TIMEOUT_MS);
    });
    const work = async (): Promise<DiscoveryResponse> => {
      if (controller.signal.aborted) return emptyResponse('unavailable', now());
      emit('black_owned_discovery_requested');
      const response = emptyResponse('empty', now());
      if (flags.discovery) {
        const key = JSON.stringify([input.garment, input.market]);
        const revision = await deps.revision(controller.signal);
        const cached = cache.get(key);
        let rows: CatalogRow[];
        if (cached && cached.until > now() && cached.revision === revision) rows = cached.rows;
        else {
          emit('black_owned_catalog_searched');
          const snapshot = await deps.candidates(input, controller.signal);
          rows = snapshot.rows;
          if (!controller.signal.aborted) {
            if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
            cache.set(key, { until: now() + DISCOVERY_CACHE_MS, revision: snapshot.revision, rows });
          }
        }
        response.products = rankCatalog(input, rows, flags, now());
        response.canonicalCommerce = buildCanonicalCommerce(response.products);
        response.status = response.products.length ? 'ready' : 'empty';
        emit(response.products.length ? 'black_owned_products_found' : 'black_owned_discovery_empty', response.products.length);
      }
      if (flags.badges && input.primaryProducts.length) response.primaryOwnership = await deps.ownership(input, controller.signal);
      return response;
    };
    try { return await Promise.race([work(), cancelled]); }
    catch { return emptyResponse('unavailable', now()); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
}
