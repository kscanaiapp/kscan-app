// Experimental provider. Upstream RapidAPI endpoint returned 404 for tested Nike URLs as of setup. Do not wire into production flows until a supported URL or endpoint is confirmed.
//
// DECISION 2026-08-03 — warning DELIBERATELY RETAINED.
//
// The copy deployed to production (v68) has these two lines deleted. That
// deletion was reviewed during the Checkpoint 3 drift reconciliation and is NOT
// being adopted, for three reasons:
//
//   1. Nothing in the repository, the deploy history, or any commit message
//      records who determined the upstream endpoint had started working.
//      Deleting a caveat is not evidence that the caveat stopped being true.
//   2. The claim is still verifiable-false as far as anyone here can tell: no
//      call was made to check (paid provider execution is not authorized this
//      phase), so the 404 finding stands unrefuted.
//   3. The warning has NO RUNTIME BEHAVIOUR. Retaining a comment cannot revert
//      production behaviour, so keeping it does not violate the reconciliation
//      rule that a clean build must not silently undo a deployed fix. Every
//      behavioural delta from v68 IS adopted; this is the only exception and it
//      is inert.
//
// Confirmed unwired at the time of this decision: `services/nikeShoeDetails.ts`
// exists but `fetchNikeShoeDetails` has no caller outside
// `services/nikeShoeDetailsDevHelper.ts`. No screen, hook or store reaches it,
// so the warning is being honoured in practice.
//
// To retire this warning: make one successful call against a current Nike
// product URL, record the response, and delete these lines in a commit that
// cites it.
//
// Nike Shoe Details — Edge Function
//
// Accepts POST { product_url }  →  proxies a RapidAPI GET request server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RAPIDAPI_HOST    = 'nike-api.p.rapidapi.com';
const RAPIDAPI_URL     = `https://${RAPIDAPI_HOST}/get-mens-shoe-details`;
const UPSTREAM_TIMEOUT = 8_000;

const NIKE_ORIGINS = [
  'https://www.nike.com/',
  'https://nike.com/',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function validNikeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === 'undefined' || value.trim().length === 0) {
    return false;
  }
  return NIKE_ORIGINS.some(origin => value.startsWith(origin));
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

  // ── Validate secret ─────────────────────────────────────────────────────────
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) {
    console.error('[nike-shoe-details] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'RapidAPI is not configured' }, 500);
  }

  // ── Parse + validate request body ───────────────────────────────────────────
  const rawBody = await req.json().catch(() => null);

  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return json({ error: 'Request body must be a JSON object' }, 400);
  }

  const body = rawBody as Record<string, unknown>;

  if (!validNikeUrl(body.product_url)) {
    return json(
      { error: 'product_url is required and must start with https://www.nike.com/ or https://nike.com/' },
      400,
    );
  }

  const productUrl = (body.product_url as string).trim();

  // ── Build GET URL ────────────────────────────────────────────────────────────
  const upstreamUrl = `${RAPIDAPI_URL}?product_url=${encodeURIComponent(productUrl)}`;

  // ── Proxy GET to RapidAPI ────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const startedAt  = Date.now();

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key':  apiKey,   // key stays server-side; never echoed
      },
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 400) {
      const errBody = await upstream.json().catch(() => null);
      console.warn('[nike-shoe-details] Bad request to upstream', elapsedMs, 'ms');
      return json({ error: 'Bad request', detail: errBody }, 400);
    }

    if (upstream.status === 401 || upstream.status === 403) {
      console.error('[nike-shoe-details] Auth failure', upstream.status, elapsedMs, 'ms');
      return json({ error: 'Nike API authentication failed' }, 502);
    }

    if (upstream.status === 429) {
      console.warn('[nike-shoe-details] Rate limited by upstream', elapsedMs, 'ms');
      return json({ error: 'Rate limited — retry later' }, 429);
    }

    if (upstream.status === 404) {
      console.warn('[nike-shoe-details] Product not found', elapsedMs, 'ms');
      return json({ error: 'Product not found', productUrl }, 404);
    }

    if (!upstream.ok) {
      console.warn('[nike-shoe-details] Upstream error', upstream.status, elapsedMs, 'ms');
      return json({ error: `Nike API returned ${upstream.status}` }, 502);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[nike-shoe-details] Malformed JSON from upstream', elapsedMs, 'ms');
      return json({ error: 'Malformed response from upstream' }, 502);
    }

    console.log('[nike-shoe-details] success', elapsedMs, 'ms');
    return json(payload);

  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';

    console.warn(
      '[nike-shoe-details]',
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
