// Try-On Clothes Pro — Edge Function
//
// Accepts POST JSON  →  proxies a RapidAPI form-POST server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RAPIDAPI_HOST    = 'try-on-clothes-pro.p.rapidapi.com';
const RAPIDAPI_URL     = `https://${RAPIDAPI_HOST}/portrait/editing/try-on-clothes-pro`;
const UPSTREAM_TIMEOUT = 20_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Rejects missing, non-string, and the literal string "undefined".
function validImageField(value: unknown): value is string {
  return typeof value === 'string' && value !== 'undefined' && value.trim().length > 0;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string' || value === 'undefined' || value.trim().length === 0) return null;
  return value.trim();
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

// ─── Request parsing ─────────────────────────────────────────────────────────

interface TryOnRequest {
  personImage:   string;
  topGarment:    string | null;
  bottomGarment: string | null;
  resolution:    string | null;
  restoreFace:   boolean | null;
}

function parseRequest(raw: unknown): TryOnRequest | { validationError: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { validationError: 'Request body must be a JSON object' };
  }

  const body = raw as Record<string, unknown>;

  if (!validImageField(body.person_image)) {
    return { validationError: 'person_image is required and must be a non-empty string' };
  }

  const topGarment    = validImageField(body.top_garment)    ? body.top_garment    as string : null;
  const bottomGarment = validImageField(body.bottom_garment) ? body.bottom_garment as string : null;

  if (!topGarment && !bottomGarment) {
    return { validationError: 'At least one of top_garment or bottom_garment is required' };
  }

  return {
    personImage:   body.person_image as string,
    topGarment,
    bottomGarment,
    resolution:    optionalString(body.resolution),
    restoreFace:   optionalBoolean(body.restore_face),
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
    console.error('[tryon-clothes-pro] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'Try-On API is not configured' }, 500);
  }

  // ── Parse + validate request body ───────────────────────────────────────────
  const rawBody = await req.json().catch(() => null);
  const parsed  = parseRequest(rawBody);

  if ('validationError' in parsed) {
    return json({ error: parsed.validationError }, 400);
  }

  // ── Build form body ──────────────────────────────────────────────────────────
  const params = new URLSearchParams();
  params.set('task_type',    'try_on');
  params.set('person_image', parsed.personImage);
  if (parsed.topGarment)    params.set('top_garment',    parsed.topGarment);
  if (parsed.bottomGarment) params.set('bottom_garment', parsed.bottomGarment);
  if (parsed.resolution)    params.set('resolution',     parsed.resolution);
  if (parsed.restoreFace !== null) {
    params.set('restore_face', String(parsed.restoreFace));
  }

  // ── Proxy POST to RapidAPI ───────────────────────────────────────────────────
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const startedAt  = Date.now();

  try {
    const upstream = await fetch(RAPIDAPI_URL, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/x-www-form-urlencoded',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key':  apiKey,   // key stays server-side; never echoed
      },
      body:   params.toString(),
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 400) {
      const errBody = await upstream.json().catch(() => null);
      console.warn('[tryon-clothes-pro] Bad request to upstream', elapsedMs, 'ms');
      return json({ error: 'Bad request', detail: errBody }, 400);
    }

    if (upstream.status === 401 || upstream.status === 403) {
      console.error('[tryon-clothes-pro] Auth failure', upstream.status, elapsedMs, 'ms');
      return json({ error: 'Try-On API authentication failed' }, 502);
    }

    if (upstream.status === 429) {
      console.warn('[tryon-clothes-pro] Rate limited by upstream', elapsedMs, 'ms');
      return json({ error: 'Rate limited — retry later' }, 429);
    }

    if (upstream.status === 404) {
      console.warn('[tryon-clothes-pro] Upstream endpoint not found', elapsedMs, 'ms');
      return json({ error: 'Try-On endpoint not found' }, 404);
    }

    if (!upstream.ok) {
      console.warn('[tryon-clothes-pro] Upstream error', upstream.status, elapsedMs, 'ms');
      return json({ error: `Upstream returned ${upstream.status}` }, 502);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[tryon-clothes-pro] Malformed JSON from upstream', elapsedMs, 'ms');
      return json({ error: 'Malformed response from upstream' }, 502);
    }

    console.log('[tryon-clothes-pro] success', elapsedMs, 'ms');
    return json(payload);

  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';

    console.warn(
      '[tryon-clothes-pro]',
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
