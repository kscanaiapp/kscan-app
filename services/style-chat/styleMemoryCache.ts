import type { StyleMemorySummary } from './styleMemoryTypes';
import { STYLE_MEMORY_CACHE_TTL_MS } from '../../constants/styleMemory';

interface MemoryCacheEntry {
  summary: StyleMemorySummary;
  cachedAt: number;
}

let _cache: MemoryCacheEntry | null = null;

export function getCachedStyleMemorySummary(): StyleMemorySummary | null {
  if (!_cache) return null;
  if (Date.now() - _cache.cachedAt > STYLE_MEMORY_CACHE_TTL_MS) {
    _cache = null;
    return null;
  }
  return _cache.summary;
}

export function setCachedStyleMemorySummary(summary: StyleMemorySummary): void {
  _cache = { summary, cachedAt: Date.now() };
}

// Call after any event insert/upsert or when a referenced source becomes stale.
export function invalidateMemoryCache(): void {
  _cache = null;
}

export function isCacheStale(): boolean {
  if (!_cache) return true;
  return Date.now() - _cache.cachedAt > STYLE_MEMORY_CACHE_TTL_MS;
}
