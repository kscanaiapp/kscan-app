// supabase/functions/scan-identify/shoppingProvider.ts
//
// Real shopping/web result provider for TextScan.
//   Primary : Serper Shopping  (retail product cards)
//   Fallback: Brave Web Search (similar web/product links)
//
// Backend-only. No secrets, headers, or raw provider payloads are ever logged
// or forwarded to the mobile app. All output is normalized to a small,
// stable RecommendedProduct shape.

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecommendedProduct {
  id: string;
  title: string;
  source: string;
  price?: string;
  type: 'retail' | 'similar';
  imageUrl?: string;
  productUrl?: string;
  /**
   * v124 — product brand, when the provider actually declares one.
   *
   * Additive and always optional: never inferred from the title, never derived
   * from `source` (which is retailer identity, not brand, and must stay out of
   * ranking). Serper and Brave do not supply a brand field, so this stays
   * undefined for those providers rather than being fabricated.
   */
  brand?: string;
}

export interface ShoppingResult {
  products: RecommendedProduct[];
  provider: 'serper' | 'brave' | 'none';
  query: string;
  errorType?: string;
}

export interface ShoppingQueryInput {
  searchQueries?: unknown;
  brand?: unknown;
  color?: unknown;
  category?: unknown;
  material?: unknown;
  silhouette?: unknown;
  style?: unknown;
  text?: unknown;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SERPER_URL = 'https://google.serper.dev/shopping';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const PROVIDER_TIMEOUT_MS = 4500;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 8;
const BRAVE_MIN = 5;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TITLE_LEN = 160;
const MAX_PRICE_LEN = 24;
const MAX_SOURCE_LEN = 60;

// Small filler set stripped from constructed queries. Deliberately conservative
// so brand / color / category tokens are always preserved.
const FILLER_WORDS = new Set([
  'with', 'and', 'the', 'a', 'an', 'of', 'for', 'featuring', 'some', 'plus', 'in', 'to',
]);

// Generic profile names that are worse than the raw hostname for a source label.
const GENERIC_PROFILE_NAMES = new Set([
  'home', 'search', 'results', 'web', 'shopping', 'index',
]);

// Hosts that are rarely useful as "shop this style" fallback links.
const LOW_VALUE_HOSTS = [
  'wikipedia.org', 'wikimedia.org', 'reddit.com', 'quora.com',
  'youtube.com', 'pinterest.com', 'fandom.com',
];

/**
 * Search/aggregator intermediaries — a results or redirect page rather than a
 * place to buy the item. This is deliberately NOT a retailer list: it names only
 * the generic middlemen, so every actual retailer stays equally eligible and
 * retailer neutrality is preserved.
 */
const AGGREGATOR_HOSTS = [
  'google.com', 'google.co.uk', 'googleadservices.com', 'googleusercontent.com',
  'shopping.google.com', 'bing.com', 'duckduckgo.com', 'search.yahoo.com',
];

/**
 * Hosts that must never be reachable as a commerce destination. A product feed
 * is untrusted input, so a URL pointing at localhost or RFC1918 space is treated
 * as hostile rather than merely useless.
 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Link-local, including the cloud metadata endpoint.
  if (/^169\.254\./.test(host)) return true;
  return false;
}

// ── Env access (Deno) ────────────────────────────────────────────────────────

function readEnv(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const env = (globalThis as any)?.Deno?.env;
    const v = env?.get?.(name);
    return typeof v === 'string' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ── In-memory cache (successful results only) ────────────────────────────────

interface CacheEntry {
  result: ShoppingResult;
  expires: number;
}
const CACHE = new Map<string, CacheEntry>();

function cacheGet(key: string): ShoppingResult | undefined {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    CACHE.delete(key);
    return undefined;
  }
  return hit.result;
}

function cacheSet(key: string, result: ShoppingResult): void {
  CACHE.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
}

/** Test helper: clears the in-memory cache. */
export function _resetShoppingCache(): void {
  CACHE.clear();
}

// ── Normalization helpers ────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function normalizeUrl(url: unknown): string | undefined {
  const raw = str(url);
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  // A commerce destination is opened in the user's browser straight from
  // untrusted provider metadata, so anything but plain HTTPS is rejected here:
  // javascript:, data:, file: and every other scheme, plus embedded credentials
  // and internal network targets.
  if (parsed.protocol !== 'https:') return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (!parsed.hostname || isPrivateHost(parsed.hostname.toLowerCase())) return undefined;
  // Strip common tracking params for cleaner dedupe + privacy.
  const drop = ['gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi'];
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || drop.includes(lower)) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

export function normalizeImageUrl(url: unknown): string | undefined {
  const raw = str(url);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function normalizePrice(price: unknown): string | undefined {
  if (typeof price === 'number' && Number.isFinite(price)) {
    if (price <= 0) return undefined;
    return `$${price.toFixed(2)}`;
  }
  if (typeof price !== 'string') return undefined;
  let s = price.trim();
  if (!s) return undefined;
  // Strip noisy leading qualifiers.
  s = s.replace(/^(from|starting at|as low as|only|now)\s+/i, '').trim();
  if (!s) return undefined;
  return s.slice(0, MAX_PRICE_LEN);
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

function makeId(prefix: string, seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

// ── Query construction ───────────────────────────────────────────────────────

function usableField(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const low = s.toLowerCase();
  if (low === 'unknown' || low === 'n/a' || low === 'none') return '';
  return s;
}

/**
 * Build a deterministic shopping query.
 * Priority:
 *   1. searchQueries[0]
 *   2. brand + color + category + material + silhouette + style
 *   3. original text input
 */
export function buildShoppingQuery(input: ShoppingQueryInput): string {
  const searchQueries = Array.isArray(input.searchQueries) ? input.searchQueries : [];
  const firstQuery = searchQueries.length ? usableField(searchQueries[0]) : '';
  if (firstQuery) return cleanQuery(firstQuery);

  const structured = [
    usableField(input.brand),
    usableField(input.color),
    usableField(input.category),
    usableField(input.material),
    usableField(input.silhouette),
    usableField(input.style),
  ]
    .filter(Boolean)
    .join(' ');
  if (structured.trim()) return cleanQuery(structured);

  const text = usableField(input.text);
  if (text) return cleanQuery(text);

  return '';
}

function cleanQuery(raw: string): string {
  const words = collapseSpaces(raw).split(' ');
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (!lw) continue;
    if (FILLER_WORDS.has(lw)) continue;
    if (seen.has(lw)) continue; // dedupe repeated tokens
    seen.add(lw);
    kept.push(w);
  }
  return kept.join(' ').slice(0, 200);
}

// ── Safe logging (no keys / headers / payloads / PII) ─────────────────────────

function logProvider(
  provider: string,
  status: number,
  latencyMs: number,
  count: number,
  errorType?: string,
): void {
  console.log(
    '[shopping] provider=%s status=%d latencyMs=%d count=%d error=%s',
    provider,
    status,
    latencyMs,
    count,
    errorType ?? 'none',
  );
}

// ── Serper (primary) ─────────────────────────────────────────────────────────

async function callSerper(query: string, limit: number): Promise<{ products: RecommendedProduct[]; errorType?: string }> {
  const key = readEnv('SHOPPING_SERPER_API_KEY');
  if (!key) {
    logProvider('serper', 0, 0, 0, 'no_key');
    return { products: [], errorType: 'no_key' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: limit }),
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      const errorType = res.status === 429 ? 'quota' : 'http_error';
      logProvider('serper', res.status, latency, 0, errorType);
      return { products: [], errorType };
    }
    const data = await res.json().catch(() => null);
    const items = data && Array.isArray((data as Record<string, unknown>).shopping)
      ? ((data as Record<string, unknown>).shopping as unknown[])
      : [];
    const products = mapSerperItems(items, limit);
    logProvider('serper', res.status, latency, products.length);
    return { products };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'error';
    logProvider('serper', 0, latency, 0, errorType);
    return { products: [], errorType };
  } finally {
    clearTimeout(timeout);
  }
}

function mapSerperItems(items: unknown[], limit: number): RecommendedProduct[] {
  const out: RecommendedProduct[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    const title = str(it.title);
    if (!title) continue;
    // Serper returns both the merchant offer link and the search-engine product
    // page, and which key holds which is not guaranteed — so prefer whichever
    // one actually resolves to a retailer.
    const productUrl = selectRetailerDestination([it.productLink, it.link]);
    if (!productUrl) continue;
    const dedupeKey = productUrl.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const source = (str(it.source) || hostnameOf(productUrl) || 'Shop').slice(0, MAX_SOURCE_LEN);
    out.push({
      id: makeId('serper', productUrl),
      title: title.slice(0, MAX_TITLE_LEN),
      source,
      price: normalizePrice(it.price),
      type: 'retail',
      imageUrl: normalizeImageUrl(it.imageUrl) ?? normalizeImageUrl(it.thumbnail),
      productUrl,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Brave (fallback) ─────────────────────────────────────────────────────────

async function callBrave(query: string, limit: number): Promise<{ products: RecommendedProduct[]; errorType?: string }> {
  const key = readEnv('SHOPPING_BRAVE_API_KEY');
  if (!key) {
    logProvider('brave', 0, 0, 0, 'no_key');
    return { products: [], errorType: 'no_key' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const started = Date.now();
  try {
    const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${limit}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      const errorType = res.status === 429 ? 'quota' : 'http_error';
      logProvider('brave', res.status, latency, 0, errorType);
      return { products: [], errorType };
    }
    const data = await res.json().catch(() => null);
    const web = data && typeof data === 'object' ? (data as Record<string, unknown>).web : null;
    const results = web && typeof web === 'object' && Array.isArray((web as Record<string, unknown>).results)
      ? ((web as Record<string, unknown>).results as unknown[])
      : [];
    const products = mapBraveResults(results, limit);
    logProvider('brave', res.status, latency, products.length);
    return { products };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'error';
    logProvider('brave', 0, latency, 0, errorType);
    return { products: [], errorType };
  } finally {
    clearTimeout(timeout);
  }
}

function isLowValueHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOW_VALUE_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/** True when the URL lands on a search/aggregator intermediary, not a retailer. */
export function isAggregatorDestination(url: string | undefined): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return AGGREGATOR_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`));
}

/**
 * Applies the destination priority contract to the URLs a single provider item
 * offers: a verified retailer destination always beats a generic aggregator or
 * redirect page, and the aggregator is kept only as a last-resort fallback.
 *
 * Selection is by URL, never by field name. Providers disagree about which key
 * holds the merchant link versus the search-engine product page, and the same
 * key can carry either one, so classifying the destination is the only check
 * that stays correct across providers and schema changes.
 */
export function selectRetailerDestination(candidates: unknown[]): string | undefined {
  const normalized: string[] = [];
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate);
    if (url && !normalized.includes(url)) normalized.push(url);
  }
  return normalized.find((url) => !isAggregatorDestination(url)) ?? normalized[0];
}

function mapBraveResults(results: unknown[], limit: number): RecommendedProduct[] {
  const out: RecommendedProduct[] = [];
  const seen = new Set<string>();
  for (const raw of results) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title);
    if (!title) continue;
    const productUrl = normalizeUrl(r.url);
    if (!productUrl) continue;
    const host = hostnameOf(productUrl);
    if (isLowValueHost(host)) continue;
    const dedupeKey = productUrl.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const profile = r.profile && typeof r.profile === 'object' && !Array.isArray(r.profile)
      ? (r.profile as Record<string, unknown>)
      : undefined;
    const profileName = str(profile?.name);
    const source = (
      profileName && !GENERIC_PROFILE_NAMES.has(profileName.toLowerCase())
        ? profileName
        : host || 'Web'
    ).slice(0, MAX_SOURCE_LEN);
    out.push({
      id: makeId('brave', productUrl),
      title: title.slice(0, MAX_TITLE_LEN),
      source,
      price: undefined,
      type: 'similar',
      imageUrl: undefined,
      productUrl,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Get real shopping results for a query.
 * Serper is primary (retail cards); Brave is fallback (similar web links).
 * Controlled by the SHOPPING_ENABLED kill switch (enabled unless "false").
 */
export async function getShoppingResults(input: { query: string; limit?: number }): Promise<ShoppingResult> {
  const query = collapseSpaces(str(input.query));
  const limit = clampLimit(input.limit, DEFAULT_LIMIT);

  // Kill switch: SHOPPING_ENABLED === "false" disables all commerce.
  if (readEnv('SHOPPING_ENABLED')?.toLowerCase() === 'false') {
    return { products: [], provider: 'none', query, errorType: 'disabled' };
  }

  if (!query) {
    return { products: [], provider: 'none', query, errorType: 'empty_query' };
  }

  const cacheKey = query.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, query };
  }

  // 1. Serper primary.
  const serper = await callSerper(query, limit);
  if (serper.products.length > 0) {
    const result: ShoppingResult = {
      products: serper.products.slice(0, limit),
      provider: 'serper',
      query,
    };
    cacheSet(cacheKey, result);
    return result;
  }

  // 2. Brave fallback (Serper failed / timed out / quota / no usable results).
  const braveLimit = clampLimit(Math.max(BRAVE_MIN, limit), DEFAULT_LIMIT);
  const brave = await callBrave(query, braveLimit);
  if (brave.products.length > 0) {
    const result: ShoppingResult = {
      products: brave.products.slice(0, braveLimit),
      provider: 'brave',
      query,
    };
    cacheSet(cacheKey, result);
    return result;
  }

  // 3. Both providers produced nothing. Do not cache hard failures.
  return {
    products: [],
    provider: 'none',
    query,
    errorType: serper.errorType ?? brave.errorType ?? 'no_results',
  };
}
