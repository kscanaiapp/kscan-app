// Real-Time Product Search — Edge Function
//
// Accepts POST JSON  →  proxies a RapidAPI GET request server-side.
// Uses the shared RAPIDAPI_KEY secret.  The key never leaves this function;
// it is never forwarded, logged in plaintext, or included in any response body.
//
// Security hardening (Pass 4): verified auth + account-state enforcement,
// caller-aware CORS, request-size/content-type enforcement, provider-cost
// quota reservation, and bounded-retry provider fetch — layered around the
// original field parsing and upstream-status-mapping logic, which are left
// behaviorally unchanged so the existing (currently dormant) client contract
// is preserved exactly. Single-provider endpoint — no fan-out exists here.

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

const FUNCTION_NAME = 'product-search-deals';
const PROVIDER_CATEGORY = 'retail_search';
const CORS_POLICY: CorsPolicy = { allowedMethods: ['POST'] };
const MAX_REQUEST_BODY_BYTES = 4 * 1024;

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

// ─── Helpers (field-parsing semantics unchanged from pre-hardening source) ───

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

interface SearchRequest {
  q:                 string;
  limit:             number;
  offset:            number;
  country:           string;
  language:          string;
  sort_by:           string;
  product_condition: string;
}

export function parseRequest(raw: unknown): SearchRequest | { validationError: string } {
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
      headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': apiKey },
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

// Test-only injection point (mirrors context.ts's clientFactory pattern).
// Production call sites (Deno.serve below) must never set this.
export interface RequestOverrides {
  authenticate?: typeof authenticateRequest;
  fetchImpl?: typeof fetch;
}

export async function handleProductSearchRequest(req: Request, overrides: RequestOverrides = {}): Promise<Response> {
  const authenticate = overrides.authenticate ?? authenticateRequest;
  const fetchImpl = overrides.fetchImpl ?? fetch;

  const preflight = handleCorsPreflight(req, CORS_POLICY);
  if (preflight) return preflight;

  const corsHeaders = buildCorsHeaders(req, CORS_POLICY);

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  // ── Verified auth + account-state (new layer; the platform gateway already
  // required a Supabase JWT via verify_jwt, so this adds account-status
  // enforcement on top of an authentication requirement that already existed) ──
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
    console.error('[product-search-deals] RAPIDAPI_KEY secret is not configured');
    return json({ error: 'Product Search API is not configured', requestId }, 500, corsHeaders);
  }

  // ── Read + parse body (size-bounded read is new; field semantics unchanged) ─
  const bodyResult = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
  if (!bodyResult.ok) {
    const message = bodyResult.reason === 'too_large' ? 'Request body is too large' : 'Request body must be a JSON object';
    return json({ error: message, requestId }, 400, corsHeaders);
  }
  const parsed = parseRequest(bodyResult.value);
  if ('validationError' in parsed) {
    return json({ error: parsed.validationError, requestId }, 400, corsHeaders);
  }

  // ── Quota reservation ────────────────────────────────────────────────────
  let reservationId: string | null = null;
  {
    const fingerprint = await computeRequestFingerprint([userId, FUNCTION_NAME, parsed.q, parsed.country, parsed.language]);
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
      // Fail-open only at RPC-unavailability (e.g. migration not yet applied) —
      // a genuine allowed:false decision above already returned above.
      console.warn('[product-search-deals] reservation_unavailable requestId=%s reason=%s', requestId, reservation.error);
    }
  }

  // ── Build GET URL (unchanged) ────────────────────────────────────────────
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
  const startedAt = Date.now();

  // ── Proxy GET to RapidAPI — status-mapping cascade preserved exactly; only
  // the transport (timeout/caller-cancellation/bounded retry on 429/5xx) is hardened.
  try {
    const upstream = await withBoundedRetries(
      () => fetchOnce(upstreamUrl, apiKey, req.signal, fetchImpl),
      { maxAttempts: 2, onRetry: (n, delayMs) => console.warn('[product-search-deals] transient_retry attempt=%d delayMs=%d', n, delayMs) },
    );
    const elapsedMs = Date.now() - startedAt;

    if (upstream.status === 400) {
      const errBody = await upstream.json().catch(() => null);
      console.warn('[product-search-deals] Bad request to upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 400, reservationId);
      return json({ error: 'Bad request', detail: errBody, requestId }, 400, corsHeaders);
    }

    const payload = await upstream.json().catch(() => null);
    if (payload === null) {
      console.warn('[product-search-deals] Malformed JSON from upstream', elapsedMs, 'ms');
      await finalizeReservation(userClient, reservationId, true);
      logOutcome(requestId, uidFragment, 'provider_error', 502, reservationId);
      return json({ error: 'Malformed response from upstream', requestId }, 502, corsHeaders);
    }

    // Privacy fix: previously logged the raw user search query in plaintext
    // (`'q=', parsed.q`). Only its length is safe to log.
    console.log('[product-search-deals] success elapsedMs=%d qLength=%d', elapsedMs, parsed.q.length);
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
      console.warn('[product-search-deals] upstream timeout elapsedMs=%d', elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', 504, reservationId);
      return json({ error: 'Upstream request timed out', requestId }, 504, corsHeaders);
    }
    if (err instanceof ProviderHttpError) {
      console.warn('[product-search-deals] upstream_http_error status=%d kind=%s elapsedMs=%d', err.status, err.kind, elapsedMs);
      logOutcome(requestId, uidFragment, 'provider_error', err.status, reservationId);
      if (err.status === 401 || err.status === 403) {
        return json({ error: 'Product Search API authentication failed', requestId }, 502, corsHeaders);
      }
      if (err.status === 429) {
        return json({ error: 'Rate limited — retry later', requestId }, 429, corsHeaders, { 'Retry-After': '30' });
      }
      if (err.status === 404) {
        return json({ error: 'Product Search endpoint not found', requestId }, 404, corsHeaders);
      }
      return json({ error: `Upstream returned ${err.status}`, requestId }, 502, corsHeaders);
    }

    console.warn('[product-search-deals] fetch error elapsedMs=%d', elapsedMs);
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

Deno.serve((req) => handleProductSearchRequest(req));
