// Try-On Clothes Pro — Edge Function
//
// Accepts POST JSON  →  proxies a RapidAPI form-POST server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.
// Provider is RapidAPI (try-on-clothes-pro.p.rapidapi.com) — confirmed by
// reading this function's actual source; it does NOT use ModelsLab despite
// MODELSLAB_API_KEY/MODELSLAB_TRYON_ENABLED being present on staging for an
// unrelated path.
//
// Zero-Knowledge constraint: person_image/top_garment/bottom_garment carry
// user image data (or an image reference). This function never logs their
// content, never persists them (no DB writes exist in this function), and
// never echoes them back beyond the raw upstream passthrough the caller
// already expects. Security hardening (Pass 4) adds a bounded request-size
// limit — previously absent — specifically because unbounded image payloads
// are both a cost-abuse vector and a privacy-surface-area concern; every
// other control (auth, quota, provider hardening) mirrors the other 4
// functions in this pass. There is currently no live caller
// (services/tryOnClothesPro.ts is unimported anywhere under app/components/
// hooks/contexts), so this function is hardened and tested here but stays
// undeployed pending a real product need.

import { authenticateRequest } from '../_shared/security/context.ts';
import { buildCorsHeaders, handleCorsPreflight, type CorsPolicy } from '../_shared/security/cors.ts';
import { securityErrorResponse } from '../_shared/security/errors.ts';
import { logSecurityEvent, safeUserIdFragment } from '../_shared/security/logging.ts';
import {
  CallerCancelledError,
  ProviderHttpError,
  ProviderTimeoutError,
  classifyProviderStatus,
  withBoundedRetries,
} from '../_shared/security/provider.ts';
import {
  completeProviderRequest,
  computeRequestFingerprint,
  releaseProviderRequest,
  reserveProviderRequest,
} from '../_shared/security/quota.ts';
import { readJsonBody } from '../_shared/security/validation.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const FUNCTION_NAME = 'tryon-clothes-pro';
const PROVIDER_CATEGORY = 'visual_tryon';
const CORS_POLICY: CorsPolicy = { allowedMethods: ['POST'] };
// Generous enough for two base64-encoded phone photos (person + garment)
// while still bounding request size — previously unbounded.
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

const RAPIDAPI_HOST    = 'try-on-clothes-pro.p.rapidapi.com';
const RAPIDAPI_URL     = `https://${RAPIDAPI_HOST}/portrait/editing/try-on-clothes-pro`;
const UPSTREAM_TIMEOUT = 20_000;

// ─── Helpers (field-parsing semantics unchanged from pre-hardening source) ───

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

interface TryOnRequest {
  personImage:   string;
  topGarment:    string | null;
  bottomGarment: string | null;
  resolution:    string | null;
  restoreFace:   boolean | null;
}

export function parseRequest(raw: unknown): TryOnRequest | { validationError: string } {
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

function json(body: unknown, status: number, corsHeaders: Record<string, string>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...extraHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' },
  });
}

async function fetchOnce(body: string, apiKey: string, callerSignal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const onCallerAbort = () => controller.abort();
  callerSignal.addEventListener('abort', onCallerAbort);
  try {
    const res = await fetchImpl(RAPIDAPI_URL, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/x-www-form-urlencoded',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key':  apiKey,
      },
      body,
      signal: controller.signal,
    });
    // 400 is handled by the caller directly (its body carries `detail`); every
    // other non-ok status is classified so bounded retry can act on it.
    if (!res.ok && res.status !== 400) {
      const kind = classifyProviderStatus(res.status);
      throw new ProviderHttpError(res.status, kind === 'ok' ? 'server_error' : kind);
    }
    return res;
  } catch (err) {
    if (err instanceof ProviderHttpError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (callerSignal.aborted) throw new CallerCancelledError();
      throw new ProviderTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

async function finalizeReservation(client: SupabaseClient, reservationId: string | null, failed: boolean): Promise<void> {
  if (!reservationId) return;
  if (failed) await releaseProviderRequest(client, reservationId, 'provider_error');
  else await completeProviderRequest(client, reservationId);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

// Test-only injection point. Production call sites (Deno.serve below) must
// never set this.
export interface RequestOverrides {
  authenticate?: typeof authenticateRequest;
  fetchImpl?: typeof fetch;
}

export async function handleTryOnRequest(req: Request, overrides: RequestOverrides = {}): Promise<Response> {
  const authenticate = overrides.authenticate ?? authenticateRequest;
  const fetchImpl = overrides.fetchImpl ?? fetch;

  const preflight = handleCorsPreflight(req, CORS_POLICY);
  if (preflight) return preflight;

  const corsHeaders = buildCorsHeaders(req, CORS_POLICY);

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  // ── Verified auth + account-state ────────────────────────────────────────
  const authResult = await authenticate(req);
  if (!authResult.ok) {
    const status = authResult.category === 'unauthorized' ? 401 : authResult.category === 'internal_error' ? 500 : 403;
    logSecurityEvent({
      requestId: authResult.requestId,
      functionName: FUNCTION_NAME,
      providerCategory: PROVIDER_CATEGORY,
      outcome: authResult.category === 'internal_error' ? 'internal_error' : 'denied',
      status,
      errorCategory: authResult.category,
    });
    return securityErrorResponse(authResult.category, authResult.requestId, { message: authResult.message, corsHeaders });
  }
  const { context: authContext, supabaseClient: userClient } = authResult;
  const { userId, requestId } = authContext;
  const uidFragment = safeUserIdFragment(userId);

  // ── Validate secret ──────────────────────────────────────────────────────
  const apiKey = Deno.env.get('RAPIDAPI_KEY');
  if (!apiKey) {
    console.error('[tryon-clothes-pro] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'Try-On API is not configured', requestId }, 500, corsHeaders);
  }

  // ── Read + parse body. Size-bounded read is new — previously unbounded,
  // a real gap given these fields carry image data. ──────────────────────────
  const bodyResult = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
  if (!bodyResult.ok) {
    const message = bodyResult.reason === 'too_large' ? 'Request body is too large' : 'Request body must be a JSON object';
    return json({ error: message, requestId }, 400, corsHeaders);
  }
  const parsed = parseRequest(bodyResult.value);
  if ('validationError' in parsed) {
    return json({ error: parsed.validationError, requestId }, 400, corsHeaders);
  }

  // ── Quota reservation (visual_tryon: the tightest concurrency/cost budget
  // of the 5 functions in this pass, reflecting real per-call provider cost). ──
  let reservationId: string | null = null;
  {
    const fingerprint = await computeRequestFingerprint([userId, FUNCTION_NAME, parsed.personImage, parsed.topGarment ?? '', parsed.bottomGarment ?? '', parsed.resolution ?? '']);
    const reservation = await reserveProviderRequest(userClient, {
      functionName: FUNCTION_NAME,
      providerCategory: PROVIDER_CATEGORY,
      requestId,
      requestFingerprint: fingerprint,
    });
    if (reservation.ok && !reservation.value.allowed) {
      logSecurityEvent({
        requestId, userIdFragment: uidFragment, functionName: FUNCTION_NAME, providerCategory: PROVIDER_CATEGORY,
        outcome: 'denied', status: 429, quotaDecision: 'denied', abuseState: reservation.value.abuseState, errorCategory: 'rate_limited',
      });
      return securityErrorResponse('rate_limited', requestId, { retryAfterSeconds: reservation.value.retryAfterSeconds ?? 60, corsHeaders });
    }
    if (reservation.ok) {
      reservationId = reservation.value.reservationId;
    } else {
      console.warn('[tryon-clothes-pro] reservation_unavailable requestId=%s reason=%s', requestId, reservation.error);
    }
  }

  // ── Build form body (unchanged) ──────────────────────────────────────────
  const params = new URLSearchParams();
  params.set('task_type',    'try_on');
  params.set('person_image', parsed.personImage);
  if (parsed.topGarment)    params.set('top_garment',    parsed.topGarment);
  if (parsed.bottomGarment) params.set('bottom_garment', parsed.bottomGarment);
  if (parsed.resolution)    params.set('resolution',     parsed.resolution);
  if (parsed.restoreFace !== null) {
    params.set('restore_face', String(parsed.restoreFace));
  }
  const startedAt = Date.now();

  // ── Proxy POST to RapidAPI — status-mapping cascade preserved exactly; only
  // the transport (timeout/caller-cancellation/bounded retry on 429/5xx) is
  // hardened. Never logs person_image/top_garment/bottom_garment content. ────
  try {
    const upstream = await withBoundedRetries(
      () => fetchOnce(params.toString(), apiKey, req.signal, fetchImpl),
      { maxAttempts: 2, onRetry: (n, delayMs) => console.warn('[tryon-clothes-pro] transient_retry attempt=%d delayMs=%d', n, delayMs) },
    );
    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 400) {
      const errBody = await upstream.json().catch(() => null);
      console.warn('[tryon-clothes-pro] Bad request to upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 400, reservationId);
      return json({ error: 'Bad request', detail: errBody, requestId }, 400, corsHeaders);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[tryon-clothes-pro] Malformed JSON from upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 502, reservationId);
      return json({ error: 'Malformed response from upstream', requestId }, 502, corsHeaders);
    }

    console.log('[tryon-clothes-pro] success elapsedMs=%d', elapsedMs);
    await finalizeReservation(userClient, reservationId, false);
    logOutcome(requestId, uidFragment, 'success', 200, reservationId);
    return json({ ...payload, requestId }, 200, corsHeaders);

  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    await finalizeReservation(userClient, reservationId, true);

    if (err instanceof CallerCancelledError) {
      logOutcome(requestId, uidFragment, 'provider_error', 499, reservationId);
      return json({ error: 'Request cancelled', requestId }, 499, corsHeaders);
    }
    if (err instanceof ProviderTimeoutError) {
      console.warn('[tryon-clothes-pro] upstream timeout elapsedMs=%d', elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', 504, reservationId);
      return json({ error: 'Upstream request timed out', requestId }, 504, corsHeaders);
    }
    if (err instanceof ProviderHttpError) {
      console.warn('[tryon-clothes-pro] upstream_http_error status=%d kind=%s elapsedMs=%d', err.status, err.kind, elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', err.status, reservationId);
      if (err.status === 401 || err.status === 403) {
        return json({ error: 'Try-On API authentication failed', requestId }, 502, corsHeaders);
      }
      if (err.status === 429) {
        return json({ error: 'Rate limited — retry later', requestId }, 429, corsHeaders, { 'Retry-After': '30' });
      }
      if (err.status === 404) {
        return json({ error: 'Try-On endpoint not found', requestId }, 404, corsHeaders);
      }
      return json({ error: `Upstream returned ${err.status}`, requestId }, 502, corsHeaders);
    }

    console.warn('[tryon-clothes-pro] fetch error elapsedMs=%d', elapsedMs);
    logOutcome(requestId, uidFragment, 'provider_error', 502, reservationId);
    return json({ error: 'Failed to reach upstream', requestId }, 502, corsHeaders);
  }
}

function logOutcome(requestId: string, uidFragment: string, outcome: 'success' | 'provider_error', status: number, reservationId: string | null) {
  logSecurityEvent({
    requestId, userIdFragment: uidFragment, functionName: FUNCTION_NAME, providerCategory: PROVIDER_CATEGORY,
    outcome, status, quotaDecision: reservationId ? (outcome === 'success' ? 'completed' : 'released') : 'not_applicable',
  });
}

Deno.serve((req) => handleTryOnRequest(req));
