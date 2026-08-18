// farfetchProvider.ts — Farfetch specialized commerce provider for camera scans.
//
// Phase 2A scope:
//   - Farfetch only
//   - Keyword search via RapidAPI
//   - Tried before Serper/Brave when enabled
//   - Falls back to Serper/Brave on failure or insufficient results
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

// ── Types ────────────────────────────────────────────────────────────────────

export type FarfetchProduct = {
  id: string;
  title: string;
  name?: string;
  /** v124 — brand as declared by the provider payload, when present. */
  brand?: string;
  source: 'Farfetch';
  retailer: 'Farfetch';
  price?: string;
  type: 'retail';
  imageUrl?: string;
  image_url?: string;
  productUrl: string;
  product_url?: string;
  url?: string;
};

export type FarfetchSearchResult = {
  products: FarfetchProduct[];
  provider: 'farfetch';
  query: string;
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'farfetch-data.p.rapidapi.com';
const DEFAULT_BASE_URL = 'https://farfetch-data.p.rapidapi.com';
const PROVIDER_TIMEOUT_MS = 4_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const MAX_TITLE_LEN = 160;
const MAX_PRICE_LEN = 32;

const TRACKING_PARAMS = new Set([
  'ref',
  'source',
  'affiliate_id',
  'irclickid',
  'clickid',
  'campaign',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
]);

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
  const dedicated = readEnv('FARFETCH_RAPIDAPI_KEY');
  if (dedicated) return { key: dedicated, keySource: 'FARFETCH_RAPIDAPI_KEY' };
  const shared = readEnv('RAPIDAPI_KEY');
  if (shared) return { key: shared, keySource: 'RAPIDAPI_KEY' };
  return { key: undefined, keySource: 'missing' };
}

function isEnabled(): boolean {
  return readEnv('FARFETCH_ENABLED')?.toLowerCase() === 'true';
}

function getHost(): string {
  return readEnv('FARFETCH_RAPIDAPI_HOST') || DEFAULT_HOST;
}

function getBaseUrl(): string {
  return readEnv('FARFETCH_RAPIDAPI_BASE_URL') || DEFAULT_BASE_URL;
}

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

function normalizeUrl(url: unknown): string | undefined {
  const raw = str(url);
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

function normalizeImageUrl(url: unknown): string | undefined {
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

function formatPrice(price: unknown): string | undefined {
  if (typeof price === 'number' && Number.isFinite(price)) {
    if (price <= 0) return undefined;
    return `$${price.toFixed(2)}`;
  }
  if (typeof price === 'string') {
    const s = collapseSpaces(price);
    if (!s) return undefined;
    if (/^(\$?0{1,}(\.0{1,})?)$/i.test(s)) return undefined;
    if (/undefined|null/i.test(s)) return undefined;
    return s.slice(0, MAX_PRICE_LEN);
  }
  if (price && typeof price === 'object' && !Array.isArray(price)) {
    const p = price as Record<string, unknown>;
    const amount = typeof p.amount === 'number' && Number.isFinite(p.amount) ? p.amount : undefined;
    const currency = str(p.currency) || str(p.currencyCode) || 'USD';
    if (amount !== undefined && amount > 0) {
      try {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: currency.toUpperCase(),
        }).format(amount);
      } catch {
        return `$${amount.toFixed(2)}`;
      }
    }
    const formatted = str(p.formattedPrice) || str(p.finalPrice) || str(p.initialPrice);
    if (formatted) return formatPrice(formatted);
  }
  return undefined;
}

function isFarfetchDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'farfetch.com' || host.endsWith('.farfetch.com');
  } catch {
    return false;
  }
}

function isImageCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /\.(cdn|images|static|cloudfront|akamai)/i.test(host) && !/farfetch/i.test(host);
  } catch {
    return false;
  }
}

function makeId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `farfetch-${(hash >>> 0).toString(36)}`;
}

// ── Safe logging ─────────────────────────────────────────────────────────────

function logFarfetch(
  status: number,
  latencyMs: number,
  count: number,
  keySource: string,
  errorType?: string,
): void {
  console.log(
    '[FarfetchProvider] status=%d latencyMs=%d count=%d keySource=%s error=%s',
    status,
    latencyMs,
    count,
    keySource,
    errorType ?? 'none',
  );
}

// ── Response extraction ──────────────────────────────────────────────────────

function extractProductArray(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];

  if (Array.isArray(data)) return data;

  const candidates = [
    (data as Record<string, unknown>).products,
    (data as Record<string, unknown>).results,
    (data as Record<string, unknown>).items,
    (data as Record<string, unknown>).listing,
    (data as Record<string, unknown>).data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = [
        (candidate as Record<string, unknown>).products,
        (candidate as Record<string, unknown>).results,
        (candidate as Record<string, unknown>).items,
      ];
      for (const n of nested) {
        if (Array.isArray(n)) return n;
      }
    }
  }

  return [];
}

function extractTitle(item: Record<string, unknown>): string | undefined {
  return str(item.name) ||
    str(item.title) ||
    str(item.productName) ||
    str(item.product_name) ||
    str(item.displayName) ||
    str(item.shortDescription) ||
    undefined;
}

/**
 * v124 — product brand from the provider payload only. Not parsed out of the
 * title and not taken from the retailer field: this preserves identity the
 * provider actually supplied, and nothing more.
 */
function extractBrand(item: Record<string, unknown>): string | undefined {
  const brand = item.brand;
  if (typeof brand === 'string') return str(brand);
  if (brand && typeof brand === 'object' && !Array.isArray(brand)) {
    return str((brand as Record<string, unknown>).name) ||
      str((brand as Record<string, unknown>).value);
  }
  return str(item.brandName) || str(item.designer) || str(item.manufacturer) || undefined;
}

function extractProductUrl(item: Record<string, unknown>): string | undefined {
  const candidates = [item.url, item.productUrl, item.product_url, item.link, item.pdpUrl, item.productLink, item.redirectUrl];
  let preferred: string | undefined;
  let fallback: string | undefined;

  for (const c of candidates) {
    const normalized = normalizeUrl(c);
    if (!normalized) continue;
    if (isImageCdnUrl(normalized)) continue;
    if (!fallback) fallback = normalized;
    if (isFarfetchDomain(normalized) && !preferred) preferred = normalized;
  }

  return preferred ?? fallback;
}

function extractImageUrl(item: Record<string, unknown>): string | undefined {
  const images = item.images ?? item.media;
  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === 'string') {
        const normalized = normalizeImageUrl(img);
        if (normalized) return normalized;
      } else if (img && typeof img === 'object' && !Array.isArray(img)) {
        const normalized = normalizeImageUrl((img as Record<string, unknown>).url) ??
          normalizeImageUrl((img as Record<string, unknown>).src) ??
          normalizeImageUrl((img as Record<string, unknown>).thumbnail);
        if (normalized) return normalized;
      }
    }
  }
  return normalizeImageUrl(item.imageUrl) ??
    normalizeImageUrl(item.image_url) ??
    normalizeImageUrl(item.image) ??
    normalizeImageUrl(item.thumbnail);
}

function extractId(item: Record<string, unknown>, index: number): string {
  return str(item.id) ||
    str(item.productId) ||
    str(item.product_id) ||
    str(item.itemId) ||
    str(item.slug) ||
    makeId(String(index));
}

function mapFarfetchItems(items: unknown[], limit: number): FarfetchProduct[] {
  const out: FarfetchProduct[] = [];
  const seenUrls = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;

    const title = extractTitle(item);
    if (!title) continue;

    const productUrl = extractProductUrl(item);
    if (!productUrl) continue;

    const dedupeKey = productUrl.toLowerCase();
    if (seenUrls.has(dedupeKey)) continue;
    seenUrls.add(dedupeKey);

    const id = extractId(item, i);
    const imageUrl = extractImageUrl(item);
    const price = formatPrice(item.price);
    const brand = extractBrand(item);

    out.push({
      id,
      title: title.slice(0, MAX_TITLE_LEN),
      name: title.slice(0, MAX_TITLE_LEN),
      ...(brand ? { brand } : {}),
      source: 'Farfetch',
      retailer: 'Farfetch',
      price,
      type: 'retail',
      imageUrl,
      image_url: imageUrl,
      productUrl,
      product_url: productUrl,
      url: productUrl,
    });

    if (out.length >= limit) break;
  }

  return out;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Search Farfetch via RapidAPI keyword search.
 *
 * Returns normalized Farfetch products when enabled and a valid RapidAPI key is
 * configured. Any failure returns an empty product list with a safe errorType;
 * the caller decides whether to fall back to other providers.
 */
export async function searchFarfetchProducts(
  query: string,
  options?: { limit?: number },
): Promise<FarfetchSearchResult> {
  const started = Date.now();

  if (!isEnabled()) {
    return { products: [], provider: 'farfetch', query, errorType: 'disabled' };
  }

  const { key, keySource } = readApiKey();
  if (!key) {
    logFarfetch(0, 0, 0, keySource, 'no_key');
    return { products: [], provider: 'farfetch', query, errorType: 'no_key' };
  }

  const collapsed = collapseSpaces(query);
  if (!collapsed) {
    return { products: [], provider: 'farfetch', query, errorType: 'empty_query' };
  }

  const host = getHost();
  const baseUrl = getBaseUrl();
  const limit = clampLimit(options?.limit);
  const url = `${baseUrl}/search.php?keyword=${encodeURIComponent(collapsed)}&page=1&country=US&currency=USD`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': host,
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
      logFarfetch(res.status, latency, 0, keySource, errorType);
      return { products: [], provider: 'farfetch', query, errorType };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      logFarfetch(res.status, latency, 0, keySource, 'invalid_json');
      return { products: [], provider: 'farfetch', query, errorType: 'invalid_json' };
    }

    const items = extractProductArray(data);
    const products = mapFarfetchItems(items, limit);
    logFarfetch(res.status, latency, products.length, keySource);

    return { products, provider: 'farfetch', query };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    logFarfetch(0, latency, 0, keySource, errorType);
    return { products: [], provider: 'farfetch', query, errorType };
  } finally {
    clearTimeout(timeout);
  }
}
