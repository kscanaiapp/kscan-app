// KicksCrew Sneaker Description — Edge Function
//
// Accepts POST { productUrl }  →  proxies a RapidAPI GET request server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RAPIDAPI_HOST = 'kickscrew-sneakers-data.p.rapidapi.com';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;
const UPSTREAM_TIMEOUT_MS = 4000;
const KICKSCREW_ORIGIN = 'https://www.kickscrew.com/';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function parseBody(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const url  = body.productUrl;
  if (typeof url !== 'string' || !url.startsWith(KICKSCREW_ORIGIN)) return null;
  return url;
}

Deno.serve(async (req) => {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // ── Validate secret ───────────────────────────────────────────────────────
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) {
    console.error('[kickscrew-sneaker-description] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'KicksCrew API is not configured' }, 500);
  }

  // ── Parse + validate request body ─────────────────────────────────────────
  const rawBody = await req.json().catch(() => null);
  const productUrl = parseBody(rawBody);

  if (!productUrl) {
    return json(
      { error: 'productUrl is required and must start with https://www.kickscrew.com/' },
      400,
    );
  }

  // ── Build RapidAPI URL ────────────────────────────────────────────────────
  const upstreamUrl =
    `${RAPIDAPI_BASE}/description/byurl?productUrl=${encodeURIComponent(productUrl)}`;

  // ── Proxy GET to RapidAPI ─────────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  const startedAt = Date.now();

  try {
    const upstream = await fetch(upstreamUrl, {
      method:  'GET',
      headers: {
        'Content-Type':   'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key':  apiKey,        // key stays server-side; never echoed
      },
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 401 || upstream.status === 403) {
      console.error('[kickscrew-sneaker-description] Auth failure', upstream.status, elapsedMs, 'ms');
      return json({ error: 'KicksCrew API authentication failed' }, 502);
    }

    if (upstream.status === 429) {
      console.warn('[kickscrew-sneaker-description] Rate limited by upstream', elapsedMs, 'ms');
      return json({ error: 'Rate limited — retry later' }, 429);
    }

    if (upstream.status === 404) {
      console.log('[kickscrew-sneaker-description] Product not found', elapsedMs, 'ms');
      return json({ error: 'Product not found', productUrl }, 404);
    }

    if (!upstream.ok) {
      console.warn('[kickscrew-sneaker-description] Upstream error', upstream.status, elapsedMs, 'ms');
      return json({ error: `Upstream returned ${upstream.status}` }, 502);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[kickscrew-sneaker-description] Malformed JSON from upstream', elapsedMs, 'ms');
      return json({ error: 'Malformed response from upstream' }, 502);
    }

    console.log('[kickscrew-sneaker-description] success', elapsedMs, 'ms');
    return json(payload);

  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';

    console.warn(
      '[kickscrew-sneaker-description]',
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
