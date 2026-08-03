// Experimental provider. Upstream RapidAPI endpoint returned 404 for tested Nike URLs as of setup. Do not wire into production flows until a supported URL or endpoint is confirmed.
//
// Nike Shoe Details — Edge Function
//
// Accepts POST { product_url }  →  proxies a RapidAPI GET request server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.
//
// Security hardening (Pass 4): shared lightweight provider guard (auth,
// account-state, caller-aware CORS, validation, quota, bounded-retry
// provider fetch) layered around the existing field parsing and
// upstream-status-mapping logic, unchanged. Zero live callers
// (services/nikeShoeDetailsDevHelper.ts exists but is itself unimported) and
// removed from staging in a prior cleanup pass — stays hardened-in-source and
// undeployed; no live caller, no explicit deploy decision made this pass.

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

const FUNCTION_NAME = 'nike-shoe-details';
const PROVIDER_CATEGORY = 'sneaker_data';
const CORS_POLICY: CorsPolicy = { allowedMethods: ['POST'] };
const MAX_REQUEST_BODY_BYTES = 4 * 1024;

const RAPIDAPI_HOST    = 'nike-api.p.rapidapi.com';
const RAPIDAPI_URL     = `https://${RAPIDAPI_HOST}/get-mens-shoe-details`;
const UPSTREAM_TIMEOUT = 8_000;

const NIKE_ORIGINS = [
  'https://www.nike.com/',
  'https://nike.com/',
];

// ─── Helpers (field-parsing semantics unchanged from pre-hardening source) ───

export function validNikeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === 'undefined' || value.trim().length === 0) {
    return false;
  }
  return NIKE_ORIGINS.some(origin => value.startsWith(origin));
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...extraHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' },
  });
}

async function fetchOnce(url: string, apiKey: string, callerSignal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const onCallerAbort = () => controller.abort();
  callerSignal.addEventListener('abort', onCallerAbort);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Content-Type':    'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key':  apiKey,
      },
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

export async function handleNikeShoeDetailsRequest(req: Request, overrides: RequestOverrides = {}): Promise<Response> {
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
    console.error('[nike-shoe-details] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'RapidAPI is not configured', requestId }, 500, corsHeaders);
  }

  // ── Read + parse body ─────────────────────────────────────────────────────
  const bodyResult = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
  if (!bodyResult.ok) {
    return json({ error: 'Request body must be a JSON object', requestId }, 400, corsHeaders);
  }
  const body = bodyResult.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Request body must be a JSON object', requestId }, 400, corsHeaders);
  }
  const record = body as Record<string, unknown>;
  if (!validNikeUrl(record.product_url)) {
    return json({ error: 'product_url is required and must start with https://www.nike.com/ or https://nike.com/', requestId }, 400, corsHeaders);
  }
  const productUrl = (record.product_url as string).trim();

  // ── Quota reservation ────────────────────────────────────────────────────
  let reservationId: string | null = null;
  {
    const fingerprint = await computeRequestFingerprint([userId, FUNCTION_NAME, productUrl]);
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
      console.warn('[nike-shoe-details] reservation_unavailable requestId=%s reason=%s', requestId, reservation.error);
    }
  }

  // ── Build GET URL (unchanged) ────────────────────────────────────────────
  const upstreamUrl = `${RAPIDAPI_URL}?product_url=${encodeURIComponent(productUrl)}`;
  const startedAt = Date.now();

  // ── Proxy GET to RapidAPI — status-mapping cascade preserved exactly; only
  // the transport (timeout/caller-cancellation/bounded retry on 429/5xx) is hardened.
  try {
    const upstream = await withBoundedRetries(
      () => fetchOnce(upstreamUrl, apiKey, req.signal, fetchImpl),
      { maxAttempts: 2, onRetry: (n, delayMs) => console.warn('[nike-shoe-details] transient_retry attempt=%d delayMs=%d', n, delayMs) },
    );
    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 400) {
      const errBody = await upstream.json().catch(() => null);
      console.warn('[nike-shoe-details] Bad request to upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 400, reservationId);
      return json({ error: 'Bad request', detail: errBody, requestId }, 400, corsHeaders);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[nike-shoe-details] Malformed JSON from upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 502, reservationId);
      return json({ error: 'Malformed response from upstream', requestId }, 502, corsHeaders);
    }

    console.log('[nike-shoe-details] success', elapsedMs, 'ms');
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
      console.warn('[nike-shoe-details] upstream timeout elapsedMs=%d', elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', 504, reservationId);
      return json({ error: 'Upstream request timed out', requestId }, 504, corsHeaders);
    }
    if (err instanceof ProviderHttpError) {
      console.warn('[nike-shoe-details] upstream_http_error status=%d kind=%s elapsedMs=%d', err.status, err.kind, elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', err.status, reservationId);
      if (err.status === 401 || err.status === 403) {
        return json({ error: 'Nike API authentication failed', requestId }, 502, corsHeaders);
      }
      if (err.status === 429) {
        return json({ error: 'Rate limited — retry later', requestId }, 429, corsHeaders, { 'Retry-After': '30' });
      }
      if (err.status === 404) {
        return json({ error: 'Product not found', productUrl, requestId }, 404, corsHeaders);
      }
      return json({ error: `Nike API returned ${err.status}`, requestId }, 502, corsHeaders);
    }

    console.warn('[nike-shoe-details] fetch error elapsedMs=%d', elapsedMs);
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

Deno.serve((req) => handleNikeShoeDetailsRequest(req));
