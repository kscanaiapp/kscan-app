/**
 * Sanitized short-lived commerce result cache (v127).
 *
 * WHY THIS IS NOT A SECOND CACHE
 * ------------------------------
 * `shoppingProvider.ts` already caches *raw provider responses* keyed by the
 * literal query string, for an hour. That is a different layer: it is per
 * provider, pre-ranking, covers only Serper/Brave, and its key is free text.
 *
 * This cache sits after ranking and covers the whole fast path — the thing the
 * user actually sees. Its key is a deterministic fingerprint of *structured
 * evidence* rather than free text, which is what makes it privacy-reviewable
 * and what makes it compatible with a future K Scan catalog: the same
 * fingerprint that selects a cached shelf today can select a top-K vector
 * candidate set later, because both key off canonical product evidence rather
 * than off whatever words the query builder happened to produce.
 *
 * The two do not overlap and neither can be expressed in terms of the other.
 *
 * PRIVACY
 * -------
 * The key derives ONLY from normalized commercial evidence plus market
 * context. It deliberately cannot contain a user id, a name, an image, base64,
 * a private URL, prompt text, or any free-form model prose. `buildCommerceCacheKey`
 * takes a typed input rather than a bag, so there is no path for an unreviewed
 * field to reach the key by accident.
 */

import {
  COMMERCE_CACHE_MAX_ENTRIES,
  COMMERCE_CACHE_TTL_MS,
} from './commerceFunnelConfig.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

/**
 * The complete set of inputs allowed to influence a cache key.
 *
 * Every field is normalized commercial evidence or market context. Adding a
 * field here is a privacy decision and should be treated as one.
 */
export type CommerceCacheKeyInput = {
  /** Canonical catalog category, e.g. "outerwear". */
  category: string;
  /** Canonical subtype, e.g. "moto jacket". */
  subtype: string;
  /** Normalized brand — only when v124 graded it usable. */
  brand?: string | null;
  /** Exact product/model hypothesis — only when v124 graded it usable. */
  exactItemHypothesis?: string | null;
  /**
   * Query fingerprint standing in for distinctive evidence. The query string
   * itself is never stored: only this hash, so the cache cannot become an
   * unreviewed log of model-generated text.
   */
  queryFingerprint: string;
  /** Market context, when the commerce contract already governs it. */
  locale?: string | null;
  currency?: string | null;
  country?: string | null;
};

export type CommerceCacheEntry = {
  products: RecommendedProduct[];
  query: string;
  providersTried: string[];
  storedAt: number;
};

export type CommerceCacheLookup = {
  hit: boolean;
  entry?: CommerceCacheEntry;
  ageMs?: number;
  key: string;
};

// ── Deterministic hashing ────────────────────────────────────────────────────

/**
 * FNV-1a. Deliberately not a crypto hash: this is a cache bucket selector, not
 * a security boundary, and it must be synchronous (Deno's SubtleCrypto digest
 * is async, which would push an await into the fast path for no benefit).
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function norm(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable fingerprint for a commerce query string. The text is never retained. */
export function fingerprintQuery(query: unknown): string {
  const tokens = norm(query).split(' ').filter(Boolean).sort();
  return fnv1a(tokens.join(' '));
}

/**
 * Build the cache key. Field order is fixed and each field is labelled, so two
 * different evidence shapes cannot collide by concatenation
 * (e.g. brand "a" + subtype "bc" vs brand "ab" + subtype "c").
 */
export function buildCommerceCacheKey(input: CommerceCacheKeyInput): string {
  const parts = [
    `c=${norm(input.category)}`,
    `s=${norm(input.subtype)}`,
    `b=${norm(input.brand)}`,
    `x=${norm(input.exactItemHypothesis)}`,
    `q=${norm(input.queryFingerprint)}`,
    `l=${norm(input.locale)}`,
    `u=${norm(input.currency)}`,
    `m=${norm(input.country)}`,
  ];
  return `v127:${fnv1a(parts.join('|'))}`;
}

// ── Store ────────────────────────────────────────────────────────────────────

const store = new Map<string, CommerceCacheEntry>();

function nowMs(): number {
  return Date.now();
}

function evictExpired(now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.storedAt >= COMMERCE_CACHE_TTL_MS) store.delete(key);
  }
}

export function commerceCacheGet(key: string): CommerceCacheLookup {
  const now = nowMs();
  const entry = store.get(key);
  if (!entry) return { hit: false, key };
  const ageMs = now - entry.storedAt;
  if (ageMs >= COMMERCE_CACHE_TTL_MS) {
    store.delete(key);
    return { hit: false, key };
  }
  return { hit: true, entry, ageMs, key };
}

export function commerceCacheSet(key: string, entry: Omit<CommerceCacheEntry, 'storedAt'>): void {
  const now = nowMs();
  // An empty shelf is not worth serving from cache — caching it would suppress
  // a real retry for the whole TTL.
  if (!entry.products.length) return;
  evictExpired(now);
  if (store.size >= COMMERCE_CACHE_MAX_ENTRIES) {
    // Oldest-first eviction. Map preserves insertion order and every write is
    // a fresh insert, so the first key is the least recently stored.
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { ...entry, storedAt: now });
}

/** Test seam. Never called from the request path. */
export function commerceCacheClear(): void {
  store.clear();
}

export function commerceCacheSize(): number {
  return store.size;
}
