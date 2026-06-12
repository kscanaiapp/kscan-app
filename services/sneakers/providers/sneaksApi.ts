// Sneaks-API — self-hosted Express server (github.com/druv5319/Sneaks-API).
// Scrapes StockX, GOAT, and Flight Club for resale + retail data.
// Only runs when EXPO_PUBLIC_SNEAKS_API_BASE_URL or SNEAKS_API_BASE_URL is set.
// Treat as unstable (scraper-dependent); silently skipped when unavailable.
//
// Endpoint used:  GET {BASE_URL}/products/{keyword}

import type { SneakerReference } from '../types';
import { buildCacheKey, cacheGet, cacheSet } from '../cache';
import { markRateLimited, throttleProvider } from '../rateLimit';

const PROVIDER   = 'sneaks-api';
const TIMEOUT_MS = 4000;
const MAX_ITEMS  = 3;

// The URL itself is not secret — check EXPO_PUBLIC_ first for Expo client,
// then fall back to the server-side bare name.
const BASE_URL: string | undefined =
  typeof process !== 'undefined'
    ? (process.env.EXPO_PUBLIC_SNEAKS_API_BASE_URL ?? process.env.SNEAKS_API_BASE_URL)
    : undefined;

type RawItem = Record<string, any>;

function lowestResell(item: RawItem): number | null {
  const resell = item.lowestResellPrice;
  if (!resell || typeof resell !== 'object') return null;
  const vals = Object.values(resell).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  const min = Math.min(...vals);
  return isFinite(min) ? min : null;
}

function marketplaceLinks(item: RawItem): SneakerReference['marketplaceLinks'] {
  const resell = item.lowestResellPrice;
  if (!resell || typeof resell !== 'object') return null;
  const name = encodeURIComponent(item.sneakerName ?? '');
  return {
    stockx:     resell.StockX      != null ? `https://stockx.com/search?s=${name}` : null,
    goat:       resell.goat        != null ? `https://goat.com/search?query=${name}` : null,
    flightClub: resell.flightClub  != null ? `https://flightclub.com/catalogsearch/result/?q=${name}` : null,
    stadiumGoods: null,
  };
}

function normalize(item: RawItem): SneakerReference {
  return {
    source:               PROVIDER,
    confidence:           0.8,
    name:                 String(item.sneakerName ?? ''),
    brand:                item.make ?? null,
    model:                null,
    sku:                  item.styleID ?? null,
    colorway:             null,
    retailPrice:          typeof item.retailPrice === 'number' ? item.retailPrice : null,
    estimatedMarketValue: null,
    lowestAsk:            lowestResell(item),
    lastSale:             null,
    releaseDate:          item.releaseDate ?? null,
    imageUrl:             item.imageUrl ?? item.smallImageUrl ?? item.thumbnail ?? null,
    productUrl:           null,
    marketplaceLinks:     marketplaceLinks(item),
    raw:                  item,
  };
}

export async function searchSneaksApi(query: string): Promise<SneakerReference[]> {
  if (!BASE_URL) return [];

  const key    = buildCacheKey(PROVIDER, query);
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  return throttleProvider(PROVIDER, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(
        `${BASE_URL}/products/${encodeURIComponent(query)}`,
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

      const data: unknown = await res.json();
      const items: RawItem[] = Array.isArray(data) ? (data as RawItem[]) : [];
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
