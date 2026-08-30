// similarClothesProvider.ts — Visual-similarity candidate generator (Phase 3).
//
// STATUS: BLOCKED_BY_PRIVACY_TRANSPORT. Implemented and contract-verified, but
// NOT wired into the live commerce path.
//
// K Scan's scan media pipeline stores sanitized images in a PRIVATE Supabase
// Storage bucket and resolves access only via short-lived signed URLs at
// display time — see services/savedScanMedia.ts ("no public URL ever stored,
// signed URLs resolved at display time"). Handing any such URL, even a
// short-lived signed one, to a third-party RapidAPI vendor on every scan is a
// new data-sharing surface that has not gone through K Scan's storage /
// retention / security governance. Per the Phase 3 privacy gate, that means:
// do not integrate; implement behind a disabled flag; report blocked.
//
// Separately, a live controlled probe against similar-clothes-ai.p.rapidapi.com
// during Phase 3 returned HTTP 502 "The API is unreachable, please contact
// the API provider" (upstream outage, independently reproduced) — so even
// once a governed image-transport exists, this provider cannot be validated
// end-to-end until the vendor's API is back up.
//
// Backend-only. No API keys, headers, raw provider payloads, or user PII are
// logged or returned to the mobile app.

// ── Types ────────────────────────────────────────────────────────────────────

export type SimilarClothesCandidate = {
  id: string;
  title: string;
  source: 'SimilarClothes';
  retailer: string;
  price?: string;
  type: 'similar';
  imageUrl?: string;
  productUrl: string;
  commerceType: 'retail' | 'resale';
};

export type SimilarClothesResult = {
  products: SimilarClothesCandidate[];
  provider: 'similar-clothes';
  errorType?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'similar-clothes-ai.p.rapidapi.com';
const PROVIDER_TIMEOUT_MS = 4_000;
const MAX_TITLE_LEN = 160;

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

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function readApiKey(): { key: string | undefined; keySource: string } {
  const dedicated = readEnv('SIMILAR_CLOTHES_RAPIDAPI_KEY');
  if (dedicated) return { key: dedicated, keySource: 'SIMILAR_CLOTHES_RAPIDAPI_KEY' };
  const shared = readEnv('RAPIDAPI_KEY');
  if (shared) return { key: shared, keySource: 'RAPIDAPI_KEY' };
  return { key: undefined, keySource: 'missing' };
}

/**
 * Disabled unless BOTH the feature flag is explicitly on AND a governed
 * sanitized-image transport is explicitly asserted by the caller. There is no
 * such transport in this phase (see header), so this stays off regardless of
 * the flag until that changes.
 */
function isEnabled(): boolean {
  return readEnv('SIMILAR_CLOTHES_ENABLED')?.toLowerCase() === 'true';
}

function getHost(): string {
  return readEnv('SIMILAR_CLOTHES_RAPIDAPI_HOST') || DEFAULT_HOST;
}

function logSimilarClothes(status: number, latencyMs: number, keySource: string, errorType?: string): void {
  console.log(
    '[SimilarClothesProvider] status=%d latencyMs=%d keySource=%s error=%s',
    status,
    latencyMs,
    keySource,
    errorType ?? 'none',
  );
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Search Similar Clothes AI by a sanitized image URL.
 *
 * `sanitizedImageUrl` must already be a K Scan-governed, sanitized-image URL.
 * This function does not sign, upload, or otherwise produce that URL — the
 * caller is responsible for governance, and today no caller in the commerce
 * router provides one (see header: BLOCKED_BY_PRIVACY_TRANSPORT).
 */
export async function searchSimilarClothes(
  sanitizedImageUrl: string,
): Promise<SimilarClothesResult> {
  const started = Date.now();

  if (!isEnabled()) {
    return { products: [], provider: 'similar-clothes', errorType: 'disabled' };
  }

  const { key, keySource } = readApiKey();
  if (!key) {
    logSimilarClothes(0, 0, keySource, 'no_key');
    return { products: [], provider: 'similar-clothes', errorType: 'no_key' };
  }

  const imageUrl = str(sanitizedImageUrl);
  if (!imageUrl) {
    return { products: [], provider: 'similar-clothes', errorType: 'empty_image_url' };
  }

  const host = getHost();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const res = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: {
        'x-rapidapi-key': key,
        'x-rapidapi-host': host,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `url=${encodeURIComponent(imageUrl)}`,
      signal: controller.signal,
    });
    const latency = Date.now() - started;

    if (!res.ok) {
      let errorType = 'http_error';
      if (res.status === 401 || res.status === 403) errorType = 'auth_error';
      else if (res.status === 429) errorType = 'rate_limit';
      else if (res.status === 502) errorType = 'upstream_unavailable';
      else if (res.status >= 500) errorType = 'server_error';
      logSimilarClothes(res.status, latency, keySource, errorType);
      return { products: [], provider: 'similar-clothes', errorType };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      logSimilarClothes(res.status, latency, keySource, 'invalid_json');
      return { products: [], provider: 'similar-clothes', errorType: 'invalid_json' };
    }

    // Contract not fully observable: the live probe never returned a 2xx
    // payload (upstream outage throughout Phase 3). Mapping is intentionally
    // conservative — no candidates are fabricated from an unproven shape.
    logSimilarClothes(res.status, latency, keySource, 'unmapped_contract');
    return { products: [], provider: 'similar-clothes', errorType: 'unmapped_contract' };
  } catch (err) {
    const latency = Date.now() - started;
    const errorType = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    logSimilarClothes(0, latency, keySource, errorType);
    return { products: [], provider: 'similar-clothes', errorType };
  } finally {
    clearTimeout(timeout);
  }
}
