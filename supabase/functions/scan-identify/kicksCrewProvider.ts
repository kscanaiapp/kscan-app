// kicksCrewProvider.ts — KicksCrew specialized sneaker commerce provider for
// camera scans (Phase 3).
//
// Approved contract (owner-supplied, authoritative for this phase):
//   GET https://kickscrew-sneakers-data.p.rapidapi.com/description/byurl?productUrl=<url>
// This is URL-driven **enrichment**, not keyword search. Do not add a search
// call against this host: a live controlled probe during Phase 3 showed
// `/search?query=` on the same host does currently return data, but the
// owner has explicitly restricted this integration to `/description/byurl`
// only, so KicksCrew candidates must already carry a kickscrew.com product
// URL discovered elsewhere (Serper/Brave) before this adapter runs.
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

// ── Types ────────────────────────────────────────────────────────────────────

export type KicksCrewProduct = {
  id: string;
  title: string;
  name?: string;
  brand?: string;
  source: 'KicksCrew';
  retailer: 'KicksCrew';
  price?: string;
  type: 'retail';
  imageUrl?: string;
  image_url?: string;
  productUrl: string;
  product_url?: string;
  url?: string;
  commerceType: 'retail';
};

export type KicksCrewEnrichResult = {
  product: KicksCrewProduct | null;
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'kickscrew-sneakers-data.p.rapidapi.com';
const PROVIDER_TIMEOUT_MS = 4_000;
const MAX_TITLE_LEN = 160;
const MAX_PRICE_LEN = 32;
const KICKSCREW_ORIGIN = 'https://www.kickscrew.com/';

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
  const dedicated = readEnv('KICKSCREW_RAPIDAPI_KEY');
  if (dedicated) return { key: dedicated, keySource: 'KICKSCREW_RAPIDAPI_KEY' };
  const shared = readEnv('RAPIDAPI_KEY');
  if (shared) return { key: shared, keySource: 'RAPIDAPI_KEY' };
  return { key: undefined, keySource: 'missing' };
}

function isEnabled(): boolean {
  const value = readEnv('KICKSCREW_ENABLED');
  if (!value) return false;
  return value.toLowerCase() === 'true';
}

function getHost(): string {
  return readEnv('KICKSCREW_RAPIDAPI_HOST') || DEFAULT_HOST;
}

/**
 * Only a real, absolute kickscrew.com product URL may be enriched. Locale
 * segments (e.g. `/en-PT/`) are not assumed constant — any path under the
 * origin is accepted, matching the already-deployed
 * `kickscrew-sneaker-description` edge function's own validation.
 */
export function isKicksCrewProductUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith(KICKSCREW_ORIGIN);
}

function lowestVariantPrice(variants: unknown): { amount: number; currency: string } | undefined {
  if (!Array.isArray(variants)) return undefined;
  let best: number | undefined;
  let currency = 'USD';
  for (const v of variants) {
    if (!v || typeof v !== 'object') continue;
    const record = v as Record<string, unknown>;
    const parsed = parseFloat(str(record.price));
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (best === undefined || parsed < best) {
      best = parsed;
      currency = str(record.price_currency) || currency;
    }
  }
  return best !== undefined ? { amount: best, currency } : undefined;
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() })
      .format(amount)
      .slice(0, MAX_PRICE_LEN);
  } catch {
    return `$${amount.toFixed(2)}`.slice(0, MAX_PRICE_LEN);
  }
}

function extractImageUrl(product: Record<string, unknown>): string | undefined {
  const image = product.image as Record<string, unknown> | undefined;
  const direct = str(image?.src);
  if (direct) return direct;
  const images = product.images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    if (first && typeof first === 'object') {
      const src = str((first as Record<string, unknown>).src);
      if (src) return src;
    }
  }
  return undefined;
}

function extractSku(product: Record<string, unknown>): string | undefined {
  const variants = product.variants;
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  const first = variants[0];
  if (!first || typeof first !== 'object') return undefined;
  return str((first as Record<string, unknown>).sku) || undefined;
}

// ── Safe logging ─────────────────────────────────────────────────────────────

function logKicksCrew(status: number, latencyMs: number, keySource: string, errorType?: string): void {
  console.log(
    '[KicksCrewProvider] status=%d latencyMs=%d keySource=%s error=%s',
    status,
    latencyMs,
    keySource,
    errorType ?? 'none',
  );
}

// ── Response mapping ─────────────────────────────────────────────────────────

function mapProduct(data: Record<string, unknown>, productUrl: string): KicksCrewProduct | null {
  const product = data.product as Record<string, unknown> | undefined;
  if (!product || typeof product !== 'object') return null;

  const title = str(product.title);
  if (!title) return null;

  const brand = str(product.vendor) || undefined;
  const lowest = lowestVariantPrice(product.variants);
  const price = lowest ? formatPrice(lowest.amount, lowest.currency) : undefined;
  const imageUrl = extractImageUrl(product);
  const sku = extractSku(product);
  const id = sku || str(product.id) || productUrl;

  return {
    id,
    title: title.slice(0, MAX_TITLE_LEN),
    name: title.slice(0, MAX_TITLE_LEN),
    ...(brand ? { brand } : {}),
    source: 'KicksCrew',
    retailer: 'KicksCrew',
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
 * Enrich a single, already-discovered KicksCrew product URL via
 * `/description/byurl`. Not a search function — see header.
 */
export async function enrichKicksCrewProductByUrl(
  productUrl: string,
): Promise<KicksCrewEnrichResult> {
  const started = Date.now();

  if (!isEnabled()) {
    return { product: null, errorType: 'disabled' };
  }

  const { key, keySource } = readApiKey();
  if (!key) {
    logKicksCrew(0, 0, keySource, 'no_key');
    return { product: null, errorType: 'no_key' };
  }

  if (!isKicksCrewProductUrl(productUrl)) {
    return { product: null, errorType: 'not_a_product_url' };
  }

  const host = getHost();
  const url = `https://${host}/description/byurl?productUrl=${encodeURIComponent(productUrl)}`;

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
      else if (res.status === 404) errorType = 'not_found';
      else if (res.status >= 500) errorType = 'server_error';
      logKicksCrew(res.status, latency, keySource, errorType);
      return { product: null, errorType };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      logKicksCrew(res.status, latency, keySource, 'invalid_json');
      return { product: null, errorType: 'invalid_json' };
    }

    const product = mapProduct(data as Record<string, unknown>, productUrl);
    logKicksCrew(res.status, latency, keySource, product ? undefined : 'unparseable');
    return { product };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    logKicksCrew(0, latency, keySource, errorType);
    return { product: null, errorType };
  } finally {
    clearTimeout(timeout);
  }
}
