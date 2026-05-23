// The Sneaker Database — https://api.thesneakerdatabase.com
// Free tier: 500 req/month.  Requires x-api-key header.
//
// SNEAKER_DATABASE_API_KEY is intentionally NOT prefixed with EXPO_PUBLIC_
// so it is never bundled into the client.  In the Expo app the key will be
// `undefined`, and this provider silently returns [].  Set the key only in
// your backend / Supabase Edge Function environment.

import type { SneakerReference } from '../types';
import { buildCacheKey, cacheGet, cacheSet } from '../cache';
import { markRateLimited, throttleProvider } from '../rateLimit';

const PROVIDER   = 'sneaker-database';
const BASE_URL   = 'https://api.thesneakerdatabase.com/v1';
const TIMEOUT_MS = 4000;
const MAX_ITEMS  = 3;

// undefined in the Expo client bundle (non-EXPO_PUBLIC_ vars are stripped)
const API_KEY: string | undefined =
  typeof process !== 'undefined' ? process.env.SNEAKER_DATABASE_API_KEY : undefined;

type RawItem = Record<string, any>;

function normalize(item: RawItem): SneakerReference {
  return {
    source:                 PROVIDER,
    confidence:             0.9,
    name:                   String(item.name ?? ''),
    brand:                  item.brand   ?? null,
    model:                  item.silhouette ?? null,
    sku:                    item.sku     ?? null,
    colorway:               item.colorway ?? null,
    retailPrice:            typeof item.retailPrice === 'number' ? item.retailPrice : null,
    estimatedMarketValue:   typeof item.estimatedMarketValue === 'number' ? item.estimatedMarketValue : null,
    lowestAsk:              null,
    lastSale:               null,
    releaseDate:            item.releaseDate ?? null,
    imageUrl:               item.media?.imageUrl ?? item.media?.smallImageUrl ?? null,
    productUrl:             null,
    marketplaceLinks: {
      stockx:       item.links?.stockX     ?? null,
      goat:         item.links?.goat       ?? null,
      flightClub:   item.links?.flightClub ?? null,
      stadiumGoods: item.links?.stadiumGoods ?? null,
    },
    raw: item,
  };
}

export async function searchSneakerDatabase(query: string): Promise<SneakerReference[]> {
  if (!API_KEY) return [];

  const key    = buildCacheKey(PROVIDER, query);
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  return throttleProvider(PROVIDER, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(
        `${BASE_URL}/sneakers?name=${encodeURIComponent(query)}&limit=5`,
        { signal: controller.signal, headers: { 'x-api-key': API_KEY as string } },
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

      const data   = await res.json();
      const items: RawItem[] = Array.isArray(data?.results) ? data.results : [];
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
