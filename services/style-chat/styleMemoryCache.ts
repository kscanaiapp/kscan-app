import type { StyleMemorySummary } from './styleMemoryTypes';
import {
  STYLE_MEMORY_CACHE_TTL_MS,
  STYLE_MEMORY_MAX_CACHE_ENTRIES,
} from '../../constants/styleMemory';

interface MemoryCacheEntry {
  userId: string;
  sessionId?: string;
  summary: StyleMemorySummary;
  cachedAt: number;
}

const cache = new Map<string, MemoryCacheEntry>();

function buildCacheKey(userId: string, sessionId?: string): string {
  return sessionId ? `${userId}::${sessionId}` : userId;
}

function isExpired(entry: MemoryCacheEntry): boolean {
  return Date.now() - entry.cachedAt > STYLE_MEMORY_CACHE_TTL_MS;
}

function evictOldestEntry(): void {
  let oldestKey: string | null = null;
  let oldestCachedAt = Number.POSITIVE_INFINITY;

  for (const [key, entry] of cache.entries()) {
    if (entry.cachedAt < oldestCachedAt) {
      oldestCachedAt = entry.cachedAt;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    cache.delete(oldestKey);
  }
}

export function getCachedStyleMemorySummary(
  userId: string,
  sessionId?: string,
): StyleMemorySummary | null {
  const cacheKey = buildCacheKey(userId, sessionId);
  const entry = cache.get(cacheKey);
  if (!entry) return null;

  if (entry.userId !== userId || entry.sessionId !== sessionId) {
    cache.delete(cacheKey);
    return null;
  }

  if (isExpired(entry)) {
    cache.delete(cacheKey);
    return null;
  }

  return entry.summary;
}

export function setCachedStyleMemorySummary(
  userId: string,
  summary: StyleMemorySummary,
  sessionId?: string,
): void {
  cache.set(buildCacheKey(userId, sessionId), {
    userId,
    sessionId,
    summary,
    cachedAt: Date.now(),
  });

  while (cache.size > STYLE_MEMORY_MAX_CACHE_ENTRIES) {
    evictOldestEntry();
  }
}

export function invalidateAllMemoryCache(): void {
  cache.clear();
}

// Call after any event insert/upsert or when a referenced source becomes stale.
export function invalidateMemoryCache(userId?: string, sessionId?: string): void {
  if (!userId) {
    invalidateAllMemoryCache();
    return;
  }

  if (sessionId) {
    cache.delete(buildCacheKey(userId, sessionId));
    return;
  }

  for (const [key, entry] of cache.entries()) {
    if (entry.userId === userId) {
      cache.delete(key);
    }
  }
}

export function isCacheStale(userId: string, sessionId?: string): boolean {
  const entry = cache.get(buildCacheKey(userId, sessionId));
  if (!entry) return true;
  return isExpired(entry);
}
