// farfetch3Provider.ts — Farfetch commerce provider for camera scans (Phase 3).
//
// Replaces the retired `farfetch-data.p.rapidapi.com` keyword-search adapter.
//
// Contract, proven by live controlled probe against farfetch3.p.rapidapi.com:
//   - GET /searchByURL?url=<farfetch.com product URL>  → 200, full product detail
//   - GET /searchByURL?url=<farfetch.com search/listing URL> → 200 {"error":"Error Extracting URL"}
//   - GET /search?q=...  → 404 "Endpoint '/search' does not exist"
// There is no keyword-search endpoint on this API. `/searchByURL` is a
// **product-URL enrichment** endpoint, the same role as the new KicksCrew
// contract — not a candidate-discovery source. Farfetch candidates therefore
// come from retailer-neutral discovery (Serper/Brave/Poshmark) and are
// enriched here only when a candidate URL already lands on farfetch.com.
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

// ── Types ────────────────────────────────────────────────────────────────────

export type Farfetch3Product = {
  id: string;
  title: string;
  name?: string;
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
  commerceType: 'retail';
};

export type Farfetch3EnrichResult = {
  product: Farfetch3Product | null;
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'farfetch3.p.rapidapi.com';
const PROVIDER_TIMEOUT_MS = 4_000;
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

function readApiKey(): { key: string | undefined; keySource: string } {
  const dedicated = readEnv('FARFETCH3_RAPIDAPI_KEY');
  if (dedicated) return { key: dedicated, keySource: 'FARFETCH3_RAPIDAPI_KEY' };
  const shared = readEnv('RAPIDAPI_KEY');
  if (shared) return { key: shared, keySource: 'RAPIDAPI_KEY' };
  return { key: undefined, keySource: 'missing' };
}

function isEnabled(): boolean {
  return readEnv('FARFETCH3_ENABLED')?.toLowerCase() === 'true';
}

/** Whether this adapter can actually be called right now (Watchlist capability check). */
export function isFarfetch3Enabled(): boolean {
  return isEnabled();
}

function getHost(): string {
  return readEnv('FARFETCH3_RAPIDAPI_HOST') || DEFAULT_HOST;
}

/** Only a real, absolute farfetch.com product URL may be enriched. */
export function isFarfetchProductUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'farfetch.com' && !host.endsWith('.farfetch.com')) return false;
  // farfetch.com product pages end in -item-<digits>.aspx; listing/search pages
  // (items.aspx, /search) are not enrichable per the live probe above.
  return /-item-\d+\.aspx$/i.test(parsed.pathname);
}

function formatPrice(raw: unknown, currencyCode: unknown): string | undefined {
  const amount = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  if (amount === undefined || amount <= 0) return undefined;
  const currency = str(currencyCode) || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() })
      .format(amount)
      .slice(0, MAX_PRICE_LEN);
  } catch {
    return `${amount.toFixed(2)} ${currency}`.slice(0, MAX_PRICE_LEN);
  }
}

function extractImageUrl(images: unknown): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first = images[0];
  if (!first || typeof first !== 'object') return undefined;
  const sizes = ['size1000', 'size600', 'size322', 'size300', 'size80'];
  for (const key of sizes) {
    const size = (first as Record<string, unknown>)[key];
    if (size && typeof size === 'object') {
      const url = str((size as Record<string, unknown>).url);
      if (url) return url;
    }
  }
  return undefined;
}

function makeId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return `farfetch3-${(hash >>> 0).toString(36)}`;
}

// ── Safe logging ─────────────────────────────────────────────────────────────

function logFarfetch3(status: number, latencyMs: number, keySource: string, errorType?: string): void {
  console.log(
    '[Farfetch3Provider] status=%d latencyMs=%d keySource=%s error=%s',
    status,
    latencyMs,
    keySource,
    errorType ?? 'none',
  );
}

// ── Response mapping ─────────────────────────────────────────────────────────

function mapProduct(data: Record<string, unknown>, productUrl: string): Farfetch3Product | null {
  const description = data.description as Record<string, unknown> | undefined;
  const shortDesc = description?.short as Record<string, unknown> | undefined;
  const title = str(shortDesc?.textContent);
  if (!title) return null;

  const brandField = data.brand as Record<string, unknown> | undefined;
  const brand = str(brandField?.name) || undefined;

  const priceField = data.productPrice as Record<string, unknown> | undefined;
  const finalPrice = priceField?.final as Record<string, unknown> | undefined;
  const value = finalPrice?.value as Record<string, unknown> | undefined;
  const currencyField = priceField?.currency as Record<string, unknown> | undefined;
  // `currency` arrives as an Apollo cache reference like Currency:{"isoCode":"EUR"}.
  let currencyCode: string | undefined;
  const currencyRef = str(currencyField?.__ref ?? currencyField);
  const isoMatch = currencyRef.match(/"isoCode":"([A-Z]{3})"/);
  if (isoMatch) currencyCode = isoMatch[1];

  const price = formatPrice(value?.raw, currencyCode);
  const imageUrl = extractImageUrl(data.images);
  const id = str(data.internalProductId) || str(data.id) || makeId(productUrl);

  return {
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
    commerceType: 'retail',
  };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Enrich a single, already-discovered Farfetch product URL via `/searchByURL`.
 *
 * This is deliberately not a search function: Farfetch3 has no keyword-search
 * endpoint (proven live — see header). Callers must already possess a
 * farfetch.com product URL from a retailer-neutral discovery source.
 */
export async function enrichFarfetchProductByUrl(
  productUrl: string,
): Promise<Farfetch3EnrichResult> {
  const started = Date.now();

  if (!isEnabled()) {
    return { product: null, errorType: 'disabled' };
  }

  const { key, keySource } = readApiKey();
  if (!key) {
    logFarfetch3(0, 0, keySource, 'no_key');
    return { product: null, errorType: 'no_key' };
  }

  if (!isFarfetchProductUrl(productUrl)) {
    return { product: null, errorType: 'not_a_product_url' };
  }

  const host = getHost();
  const url = `https://${host}/searchByURL?url=${encodeURIComponent(productUrl)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

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
      logFarfetch3(res.status, latency, keySource, errorType);
      return { product: null, errorType };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      logFarfetch3(res.status, latency, keySource, 'invalid_json');
      return { product: null, errorType: 'invalid_json' };
    }
    if (typeof (data as Record<string, unknown>).error === 'string') {
      logFarfetch3(res.status, latency, keySource, 'extraction_error');
      return { product: null, errorType: 'extraction_error' };
    }

    const product = mapProduct(data as Record<string, unknown>, productUrl);
    logFarfetch3(res.status, latency, keySource, product ? undefined : 'unparseable');
    return { product };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    logFarfetch3(0, latency, keySource, errorType);
    return { product: null, errorType };
  } finally {
    clearTimeout(timeout);
  }
}
