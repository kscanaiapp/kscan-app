// poshmarkProvider.ts — Poshmark resale commerce provider for camera scans
// (Phase 3). Retailer-neutral resale candidate source; never a preferred
// retailer and never a ranking bonus (v124 stays the sole relevance authority).
//
// Contract, proven by live controlled probe against
// poshmark-fashion-resale.p.rapidapi.com:
//   GET /poshmark/search?query=<query>&limit=<n>  → 200, real listings
//   ...&sortBy=relevance / best_match / relevant  → 500 "Input is not valid:
//     Field input.sortBy must be equal to one of the allowed values"
// The valid `sortBy` enum could not be enumerated from the error message
// (truncated), so `sortBy` is omitted entirely and the API's own default
// ordering is used, matching "if relevance sort is unavailable, document
// that" — final relevance ordering is v124's job regardless.
//
// Measured latency in the Phase 3 probe was ~13.9s for a real query — far
// beyond the provider's own budget, so this call must run inside the bounded
// parallel fan-out with partial-result salvage, never awaited serially.
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

// ── Types ────────────────────────────────────────────────────────────────────

export type PoshmarkProduct = {
  id: string;
  title: string;
  name?: string;
  brand?: string;
  source: 'Poshmark';
  retailer: 'Poshmark';
  price?: string;
  type: 'retail';
  imageUrl?: string;
  image_url?: string;
  productUrl: string;
  product_url?: string;
  url?: string;
  commerceType: 'resale';
  condition?: string;
  size?: string;
};

export type PoshmarkSearchResult = {
  products: PoshmarkProduct[];
  provider: 'poshmark';
  query: string;
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'poshmark-fashion-resale.p.rapidapi.com';
const PROVIDER_TIMEOUT_MS = 4_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;
const MAX_TITLE_LEN = 160;
const MAX_PRICE_LEN = 32;

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function readApiKey(): { key: string | undefined; keySource: string } {
  const dedicated = readEnv('POSHMARK_RAPIDAPI_KEY');
  if (dedicated) return { key: dedicated, keySource: 'POSHMARK_RAPIDAPI_KEY' };
  const shared = readEnv('RAPIDAPI_KEY');
  if (shared) return { key: shared, keySource: 'RAPIDAPI_KEY' };
  return { key: undefined, keySource: 'missing' };
}

function isEnabled(): boolean {
  return readEnv('POSHMARK_ENABLED')?.toLowerCase() === 'true';
}

function getHost(): string {
  return readEnv('POSHMARK_RAPIDAPI_HOST') || DEFAULT_HOST;
}

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

function isPoshmarkUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'poshmark.com' || host.endsWith('.poshmark.com');
  } catch {
    return false;
  }
}

function normalizeUrl(raw: unknown): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'https:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    if (!isPoshmarkUrl(s)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeImageUrl(raw: unknown): string | undefined {
  const s = str(raw);
  if (!s) return undefined;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function formatPrice(amount: unknown, currency: unknown): string | undefined {
  const value = typeof amount === 'number' && Number.isFinite(amount) ? amount : parseFloat(str(amount));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const code = str(currency) || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase() })
      .format(value)
      .slice(0, MAX_PRICE_LEN);
  } catch {
    return `$${value.toFixed(2)}`.slice(0, MAX_PRICE_LEN);
  }
}

function isAvailable(status: unknown): boolean {
  const s = str(status).toLowerCase();
  if (!s) return true;
  return s !== 'sold' && s !== 'sold_out' && s !== 'unavailable' && s !== 'reserved';
}

function makeId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `poshmark-${(hash >>> 0).toString(36)}`;
}

// ── Safe logging ─────────────────────────────────────────────────────────────

function logPoshmark(status: number, latencyMs: number, count: number, keySource: string, errorType?: string): void {
  console.log(
    '[PoshmarkProvider] status=%d latencyMs=%d count=%d keySource=%s error=%s',
    status,
    latencyMs,
    count,
    keySource,
    errorType ?? 'none',
  );
}

// ── Response mapping ─────────────────────────────────────────────────────────

function extractResultArray(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const candidate = (data as Record<string, unknown>).results;
  return Array.isArray(candidate) ? candidate : [];
}

function mapListing(item: Record<string, unknown>, index: number): PoshmarkProduct | null {
  const title = str(item.title);
  if (!title) return null;

  const productUrl = normalizeUrl(item.url);
  if (!productUrl) return null;

  if (!isAvailable(item.status)) return null;

  const id = str(item.listingId) || makeId(String(index));
  const brand = str(item.brand) || undefined;
  const price = formatPrice(item.price, item.currency);
  const imageUrl = normalizeImageUrl(item.imageUrlLarge) ?? normalizeImageUrl(item.imageUrl);
  const condition = str(item.condition) || undefined;
  const size = str(item.size) || undefined;

  return {
    id,
    title: title.slice(0, MAX_TITLE_LEN),
    name: title.slice(0, MAX_TITLE_LEN),
    ...(brand ? { brand } : {}),
    source: 'Poshmark',
    retailer: 'Poshmark',
    price,
    type: 'retail',
    imageUrl,
    image_url: imageUrl,
    productUrl,
    product_url: productUrl,
    url: productUrl,
    commerceType: 'resale',
    ...(condition ? { condition } : {}),
    ...(size ? { size } : {}),
  };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Search Poshmark via RapidAPI. Fed the same v125 commerce intent as every
 * other text-search provider — no separate AI interpretation.
 */
export async function searchPoshmarkProducts(
  query: string,
  options?: { limit?: number; timeoutMs?: number },
): Promise<PoshmarkSearchResult> {
  const started = Date.now();

  if (!isEnabled()) {
    return { products: [], provider: 'poshmark', query, errorType: 'disabled' };
  }

  const { key, keySource } = readApiKey();
  if (!key) {
    logPoshmark(0, 0, 0, keySource, 'no_key');
    return { products: [], provider: 'poshmark', query, errorType: 'no_key' };
  }

  const collapsed = collapseSpaces(query);
  if (!collapsed) {
    return { products: [], provider: 'poshmark', query, errorType: 'empty_query' };
  }

  const host = getHost();
  const limit = clampLimit(options?.limit);
  // Deliberately no `sortBy` — every attempted value was rejected by the live
  // API; omitting it uses the provider's own default and is a valid, working
  // request (see header).
  const url = `https://${host}/poshmark/search?query=${encodeURIComponent(collapsed)}&limit=${limit}`;

  const controller = new AbortController();
  // v127: the caller may supply a shorter deadline than this provider's own
  // ceiling so a slow response cannot outlive the fast-path budget. Only ever
  // shortens — a caller cannot extend a provider past its configured timeout.
  const effectiveTimeoutMs = typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, PROVIDER_TIMEOUT_MS)
    : PROVIDER_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const latency = Date.now() - started;

    if (!res.ok) {
      let errorType = 'http_error';
      if (res.status === 401 || res.status === 403) errorType = 'auth_error';
      else if (res.status === 429) errorType = 'rate_limit';
      else if (res.status >= 500) errorType = 'server_error';
      logPoshmark(res.status, latency, 0, keySource, errorType);
      return { products: [], provider: 'poshmark', query, errorType };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object' || (data as Record<string, unknown>).success === false) {
      logPoshmark(res.status, latency, 0, keySource, 'invalid_response');
      return { products: [], provider: 'poshmark', query, errorType: 'invalid_response' };
    }

    const items = extractResultArray(data);
    const products: PoshmarkProduct[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < items.length && products.length < limit; i++) {
      const raw = items[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const mapped = mapListing(raw as Record<string, unknown>, i);
      if (!mapped) continue;
      const key = mapped.productUrl.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      products.push(mapped);
    }

    logPoshmark(res.status, latency, products.length, keySource);
    return { products, provider: 'poshmark', query };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    logPoshmark(0, latency, 0, keySource, errorType);
    return { products: [], provider: 'poshmark', query, errorType };
  } finally {
    clearTimeout(timeout);
  }
}
