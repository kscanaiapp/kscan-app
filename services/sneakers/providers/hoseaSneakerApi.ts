// HoseaCodes Sneaker-API (or any compatible no-token free sneaker REST API).
// Deploy your own instance of https://github.com/hoseacodes/sneaker-api or
// point EXPO_PUBLIC_HOSEA_API_BASE_URL at any API that responds to:
//   GET /api/v1/products?name={query}&limit=5
// and returns an array of objects (or { data: [], results: [], products: [] }).
//
// If EXPO_PUBLIC_HOSEA_API_BASE_URL is not set this provider is silently disabled.

import type { SneakerReference } from '../types';
import { buildCacheKey, cacheGet, cacheSet } from '../cache';
import { markRateLimited, throttleProvider } from '../rateLimit';

const PROVIDER   = 'hosea-sneaker-api';
const TIMEOUT_MS = 4000;
const MAX_ITEMS  = 3;

const BASE_URL: string | undefined = process.env.EXPO_PUBLIC_HOSEA_API_BASE_URL;

type RawItem = Record<string, any>;

function normalize(item: RawItem): SneakerReference {
  return {
    source:               PROVIDER,
    confidence:           0.75,
    name:                 String(item.name ?? item.title ?? item.shoe_name ?? item.sneakerName ?? ''),
    brand:                item.brand ?? item.manufacturer ?? null,
    model:                item.model ?? item.silhouette ?? null,
    sku:                  item.sku ?? item.style_id ?? item.styleId ?? item.styleID ?? null,
    colorway:             item.colorway ?? item.color ?? null,
    retailPrice:
      typeof item.retailPrice === 'number' ? item.retailPrice :
      typeof item.retail_price === 'number' ? item.retail_price : null,
    estimatedMarketValue: null,
    lowestAsk:            null,
    lastSale:             null,
    releaseDate:          item.releaseDate ?? item.release_date ?? null,
    imageUrl:             item.imageUrl ?? item.image_url ?? item.thumbnail ?? item.image ?? null,
    productUrl:           item.url ?? item.product_url ?? item.link ?? null,
    marketplaceLinks:     null,
    raw:                  item,
  };
}

function extractItems(data: unknown): RawItem[] {
  if (Array.isArray(data))          return data as RawItem[];
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.data))        return d.data as RawItem[];
  if (Array.isArray(d.results))     return d.results as RawItem[];
  if (Array.isArray(d.products))    return d.products as RawItem[];
  if (Array.isArray(d.shoes))       return d.shoes as RawItem[];
  return [];
}

export async function searchHoseaSneakerApi(query: string): Promise<SneakerReference[]> {
  if (!BASE_URL) return [];

  const key    = buildCacheKey(PROVIDER, query);
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  return throttleProvider(PROVIDER, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(
        `${BASE_URL}/api/v1/products?name=${encodeURIComponent(query)}&limit=5`,
        { signal: controller.signal },
      );

      if (res.status === 429) {
        markRateLimited(PROVIDER);
        if (__DEV__) console.warn(`[sneakers/${PROVIDER}] 429 – backing off`);
        cacheSet(key, []);
        return [];
      }
      if (!res.ok) {
        if (__DEV__) console.warn(`[sneakers/${PROVIDER}] HTTP ${res.status}`);
        cacheSet(key, []);
        return [];
      }

      const data  = await res.json();
      const items = extractItems(data);
      const normalized = items.slice(0, MAX_ITEMS).map(normalize);

      cacheSet(key, normalized);
      return normalized;
    } catch (err: any) {
      if (__DEV__) {
        console.warn(
          `[sneakers/${PROVIDER}]`,
          err?.name === 'AbortError' ? 'timeout' : err?.message,
        );
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }, []);
}
