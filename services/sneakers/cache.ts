import type { SneakerReference } from './types';

const TTL_HIT_MS  = 10 * 60 * 1000; // 10 minutes for results
const TTL_MISS_MS =  2 * 60 * 1000; // 2 minutes for empty results

interface Entry {
  results: SneakerReference[];
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function buildCacheKey(provider: string, query: string): string {
  return `${provider}:${query.toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

export function cacheGet(key: string): SneakerReference[] | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.results;
}

export function cacheSet(key: string, results: SneakerReference[]): void {
  const ttl = results.length === 0 ? TTL_MISS_MS : TTL_HIT_MS;
  store.set(key, { results, expiresAt: Date.now() + ttl });
}
