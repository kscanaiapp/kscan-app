// KicksCrew Sneaker Description — Edge Function
//
// Accepts POST { productUrl }  →  proxies a RapidAPI GET request server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.
//
// Security hardening (Pass 4): verified auth + account-state enforcement,
// caller-aware CORS, request-size/content-type enforcement, provider-cost
// quota reservation, and bounded-retry provider fetch — layered around the
// existing field parsing and upstream-status-mapping logic, which are left
// behaviorally unchanged. Lower-risk function with a live caller
// (services/sneakers/providers/kickscrewRapidApi.ts, via components/
// AnalysisCard.tsx, SneakerMatchCard.tsx, hooks/useKScan.js) — not treated as
// a second reference implementation; kept as close to the minimal standard
// control set as the shared modules allow.

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

const FUNCTION_NAME = 'kickscrew-sneaker-description';
const PROVIDER_CATEGORY = 'sneaker_data';
const CORS_POLICY: CorsPolicy = { allowedMethods: ['POST'] };
const MAX_REQUEST_BODY_BYTES = 4 * 1024;

const RAPIDAPI_HOST = 'kickscrew-sneakers-data.p.rapidapi.com';
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;
const UPSTREAM_TIMEOUT_MS = 4000;
const KICKSCREW_ORIGIN = 'https://www.kickscrew.com/';

// ─── Helpers (field-parsing semantics unchanged from pre-hardening source) ───

export function parseBody(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const url  = body.productUrl;
  if (typeof url !== 'string' || !url.startsWith(KICKSCREW_ORIGIN)) return null;
  return url;
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...extraHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' },
  });
}

async function fetchOnce(url: string, apiKey: string, callerSignal: AbortSignal, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
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
    // Original source has no dedicated 400 branch — every non-ok status
    // (except 404, handled by the caller for its {error, productUrl} shape)
    // is classified so bounded retry can act on it.
    if (!res.ok && res.status !== 404) {
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

export async function handleKickscrewRequest(req: Request, overrides: RequestOverrides = {}): Promise<Response> {
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
    console.error('[kickscrew-sneaker-description] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'KicksCrew API is not configured', requestId }, 500, corsHeaders);
  }

  // ── Read + parse body ─────────────────────────────────────────────────────
  const bodyResult = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
  const productUrl = bodyResult.ok ? parseBody(bodyResult.value) : null;
  if (!productUrl) {
    return json({ error: 'productUrl is required and must start with https://www.kickscrew.com/', requestId }, 400, corsHeaders);
  }

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
      console.warn('[kickscrew-sneaker-description] reservation_unavailable requestId=%s reason=%s', requestId, reservation.error);
    }
  }

  // ── Build RapidAPI URL (unchanged) ───────────────────────────────────────
  const upstreamUrl = `${RAPIDAPI_BASE}/description/byurl?productUrl=${encodeURIComponent(productUrl)}`;
  const startedAt = Date.now();

  // ── Proxy GET to RapidAPI — status-mapping cascade preserved exactly; only
  // the transport (timeout/caller-cancellation/bounded retry on 429/5xx) is hardened.
  try {
    const upstream = await withBoundedRetries(
      () => fetchOnce(upstreamUrl, apiKey, req.signal, fetchImpl),
      { maxAttempts: 2, onRetry: (n, delayMs) => console.warn('[kickscrew-sneaker-description] transient_retry attempt=%d delayMs=%d', n, delayMs) },
    );
    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 404) {
      console.log('[kickscrew-sneaker-description] Product not found', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 404, reservationId);
      return json({ error: 'Product not found', productUrl, requestId }, 404, corsHeaders);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[kickscrew-sneaker-description] Malformed JSON from upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 502, reservationId);
      return json({ error: 'Malformed response from upstream', requestId }, 502, corsHeaders);
    }

    console.log('[kickscrew-sneaker-description] success', elapsedMs, 'ms');
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
      console.warn('[kickscrew-sneaker-description] upstream timeout elapsedMs=%d', elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', 504, reservationId);
      return json({ error: 'Upstream request timed out', requestId }, 504, corsHeaders);
    }
    if (err instanceof ProviderHttpError) {
      console.warn('[kickscrew-sneaker-description] upstream_http_error status=%d kind=%s elapsedMs=%d', err.status, err.kind, elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', err.status, reservationId);
      if (err.status === 401 || err.status === 403) {
        return json({ error: 'KicksCrew API authentication failed', requestId }, 502, corsHeaders);
      }
      if (err.status === 429) {
        return json({ error: 'Rate limited — retry later', requestId }, 429, corsHeaders, { 'Retry-After': '30' });
      }
      return json({ error: `Upstream returned ${err.status}`, requestId }, 502, corsHeaders);
    }

    console.warn('[kickscrew-sneaker-description] fetch error elapsedMs=%d', elapsedMs);
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

Deno.serve((req) => handleKickscrewRequest(req));
