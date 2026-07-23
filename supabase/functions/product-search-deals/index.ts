// Real-Time Product Search — Edge Function
//
// Accepts POST JSON  →  proxies a RapidAPI GET request server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RAPIDAPI_HOST    = 'real-time-product-search.p.rapidapi.com';
const RAPIDAPI_URL     = `https://${RAPIDAPI_HOST}/deals`;
const UPSTREAM_TIMEOUT = 20_000;

const DEFAULT_LIMIT     = 10;
const MAX_LIMIT         = 20;
const DEFAULT_OFFSET    = 0;
const DEFAULT_COUNTRY   = 'us';
const DEFAULT_LANGUAGE  = 'en';
const DEFAULT_SORT_BY   = 'BEST_MATCH';
const DEFAULT_CONDITION = 'ANY';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function validStringField(value: unknown): value is string {
  return typeof value === 'string' && value !== 'undefined' && value.trim().length > 0;
}

function clampInt(value: unknown, defaultVal: number, max: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return defaultVal;
  return Math.min(n, max);
}

function optionalString(value: unknown, defaultVal: string): string {
  if (typeof value === 'string' && value !== 'undefined' && value.trim().length > 0) {
    return value.trim();
  }
  return defaultVal;
}

// ─── Request parsing ──────────────────────────────────────────────────────────

interface SearchRequest {
  q:                 string;
  limit:             number;
  offset:            number;
  country:           string;
  language:          string;
  sort_by:           string;
  product_condition: string;
}

function parseRequest(raw: unknown): SearchRequest | { validationError: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { validationError: 'Request body must be a JSON object' };
  }

  const body = raw as Record<string, unknown>;

  if (!validStringField(body.q)) {
    return { validationError: 'q is required and must be a non-empty string' };
  }

  return {
    q:                 (body.q as string).trim(),
    limit:             clampInt(body.limit,  DEFAULT_LIMIT,  MAX_LIMIT),
    offset:            clampInt(body.offset, DEFAULT_OFFSET, Number.MAX_SAFE_INTEGER),
    country:           optionalString(body.country,           DEFAULT_COUNTRY),
    language:          optionalString(body.language,          DEFAULT_LANGUAGE),
    sort_by:           optionalString(body.sort_by,           DEFAULT_SORT_BY),
    product_condition: optionalString(body.product_condition, DEFAULT_CONDITION),
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  {
    const { assertAccountActiveIfAuthenticated } = await import(
      '../_shared/deletion/assertAccountActiveIfAuthenticated.ts'
    );
    const blocked = await assertAccountActiveIfAuthenticated(req);
    if (blocked) return blocked;
  }

  // ── Validate secret ─────────────────────────────────────────────────────────
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) {
    console.error('[product-search-deals] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'Product Search API is not configured' }, 500);
  }

  // ── Parse + validate request body ───────────────────────────────────────────
  const rawBody = await req.json().catch(() => null);
  const parsed  = parseRequest(rawBody);

  if ('validationError' in parsed) {
    return json({ error: parsed.validationError }, 400);
  }

  // ── Build GET URL ────────────────────────────────────────────────────────────
  const params = new URLSearchParams({
    q:                 parsed.q,
    limit:             String(parsed.limit),
    offset:            String(parsed.offset),
    country:           parsed.country,
    language:          parsed.language,
    sort_by:           parsed.sort_by,
    product_condition: parsed.product_condition,
  });

  const upstreamUrl = `${RAPIDAPI_URL}?${params.toString()}`;

  // ── Proxy GET to RapidAPI ────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const startedAt  = Date.now();

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key':  apiKey,   // key stays server-side; never echoed
      },
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 400) {
      const errBody = await upstream.json().catch(() => null);
      console.warn('[product-search-deals] Bad request to upstream', elapsedMs, 'ms');
      return json({ error: 'Bad request', detail: errBody }, 400);
    }

    if (upstream.status === 401 || upstream.status === 403) {
      console.error('[product-search-deals] Auth failure', upstream.status, elapsedMs, 'ms');
      return json({ error: 'Product Search API authentication failed' }, 502);
    }

    if (upstream.status === 429) {
      console.warn('[product-search-deals] Rate limited by upstream', elapsedMs, 'ms');
      return json({ error: 'Rate limited — retry later' }, 429);
    }

    if (upstream.status === 404) {
      console.warn('[product-search-deals] Upstream endpoint not found', elapsedMs, 'ms');
      return json({ error: 'Product Search endpoint not found' }, 404);
    }

    if (!upstream.ok) {
      console.warn('[product-search-deals] Upstream error', upstream.status, elapsedMs, 'ms');
      return json({ error: `Upstream returned ${upstream.status}` }, 502);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[product-search-deals] Malformed JSON from upstream', elapsedMs, 'ms');
      return json({ error: 'Malformed response from upstream' }, 502);
    }

    console.log('[product-search-deals] success', elapsedMs, 'ms', 'q=', parsed.q);
    return json(payload);

  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';

    console.warn(
      '[product-search-deals]',
      isTimeout ? 'upstream timeout' : 'fetch error',
      elapsedMs, 'ms',
    );

    return json(
      { error: isTimeout ? 'Upstream request timed out' : 'Failed to reach upstream' },
      504,
    );
  } finally {
    clearTimeout(timer);
  }
});
