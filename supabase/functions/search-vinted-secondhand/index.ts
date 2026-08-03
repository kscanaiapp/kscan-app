// Vinted secondhand search — Edge Function
//
// Accepts POST JSON → runs an Apify actor server-side and normalizes the
// results into a stable, always-well-formed contract the client can parse
// unconditionally: { enabled, items, error, meta }. Every provider failure
// mode (missing config, timeout, unexpected schema) degrades gracefully into
// that same shape rather than throwing, because hooks/useKScan.js invokes this
// automatically after every scan and must never let a secondhand-search
// hiccup break the scan result it's enriching.
//
// Security hardening (Pass 4): verified auth + account-state enforcement,
// caller-aware CORS, request-size/content-type enforcement, and provider-cost
// quota reservation are layered around the existing field-parsing, Apify
// invocation, and item-normalization logic, which are left behaviorally
// unchanged. Provider mechanism is Apify (APIFY_API_TOKEN / APIFY_VINTED_*),
// not RapidAPI — confirmed by reading this function's actual source before
// making any change. Required Apify secrets are absent from staging, so this
// function is hardened and tested here but deliberately NOT deployed this
// pass (see staging-deployment-allowlist.js).

import { authenticateRequest } from '../_shared/security/context.ts';
import { buildCorsHeaders, handleCorsPreflight, type CorsPolicy } from '../_shared/security/cors.ts';
import { securityErrorResponse } from '../_shared/security/errors.ts';
import { logSecurityEvent, safeUserIdFragment } from '../_shared/security/logging.ts';
import { completeProviderRequest, computeRequestFingerprint, releaseProviderRequest, reserveProviderRequest } from '../_shared/security/quota.ts';
import { readJsonBody } from '../_shared/security/validation.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const FUNCTION_NAME = 'search-vinted-secondhand';
const PROVIDER_CATEGORY = 'secondhand_search';
const CORS_POLICY: CorsPolicy = { allowedMethods: ['POST'] };
const MAX_REQUEST_BODY_BYTES = 4 * 1024;

type VintedSecondhandErrorCode =
  | 'SECONDHAND_RESULTS_UNAVAILABLE'
  | 'FEATURE_DISABLED'
  | 'INVALID_REQUEST'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_SCHEMA_UNEXPECTED';

type SearchRequest = {
  query: string;
  category?: string | null;
  color?: string | null;
  brand?: string | null;
  size?: string | null;
  limit?: number;
};

type SecondhandItem = {
  id: string;
  title: string;
  price?: string;
  currency?: string;
  imageUrl?: string;
  listingUrl: string;
  brand?: string;
  size?: string;
  source: 'vinted';
};

// ─── Response / field-parsing helpers (unchanged from pre-hardening source) ──

function json(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private' },
  });
}

// Built via RegExp(string) with double-escaped code points rather than a
// literal inline pattern so no raw control byte is ever embedded in
// this source file.
const CONTROL_CHAR_RE = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function cleanString(value: unknown, maxLength = 120) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHAR_RE, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

export function response(
  enabled: boolean,
  items: SecondhandItem[],
  query?: string,
  error?: VintedSecondhandErrorCode,
) {
  return {
    enabled,
    items,
    error,
    meta: {
      resultCount: items.length,
      query,
      source: 'vinted',
    },
  };
}

function isEnabled() {
  return Deno.env.get('SECONDHAND_VINTED_ENABLED')?.toLowerCase() !== 'false';
}

export function parseRequest(raw: unknown): SearchRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const query = cleanString(body.query);
  if (!query || query.length < 2) return null;

  const rawLimit = Number(body.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 12)
    : 8;

  return {
    query,
    category: cleanString(body.category),
    color: cleanString(body.color),
    brand: cleanString(body.brand),
    size: cleanString(body.size),
    limit,
  };
}

function buildActorInput(request: SearchRequest) {
  const template = Deno.env.get('APIFY_VINTED_INPUT_TEMPLATE');
  if (template) {
    try {
      return {
        ...JSON.parse(template),
        query: request.query,
        search: request.query,
        searchText: request.query,
        maxItems: request.limit,
        limit: request.limit,
      };
    } catch {
      console.warn('[search-vinted-secondhand] APIFY_VINTED_INPUT_TEMPLATE is invalid JSON');
    }
  }

  return {
    query: request.query,
    search: request.query,
    searchText: request.query,
    maxItems: request.limit,
    limit: request.limit,
    filters: {
      category: request.category,
      color: request.color,
      brand: request.brand,
      size: request.size,
    },
  };
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value, 300);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function firstNestedString(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const cleaned = firstString(record[key]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function imageFrom(raw: Record<string, unknown>) {
  const direct = firstString(raw.imageUrl, raw.image_url, raw.image, raw.photoUrl, raw.photo_url, raw.thumbnail);
  if (direct) return direct;

  const photo = firstNestedString(raw.photo, ['url', 'full_size_url', 'src']);
  if (photo) return photo;

  const images = raw.images ?? raw.photos;
  if (Array.isArray(images)) {
    for (const image of images) {
      const fromObject = firstNestedString(image, ['url', 'full_size_url', 'src']);
      if (fromObject) return fromObject;
      const fromString = firstString(image);
      if (fromString) return fromString;
    }
  }

  return undefined;
}

function normalizeUrl(value: unknown) {
  const url = firstString(value, 500);
  if (!url) return undefined;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `https://www.vinted.com${url}`;
  return undefined;
}

function normalizeItems(raw: unknown[], limit: number): SecondhandItem[] {
  return raw
    .map((item, index): SecondhandItem | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const listingUrl = normalizeUrl(
        record.listingUrl ?? record.listing_url ?? record.itemUrl ?? record.url ?? record.web_url,
      );
      const title = firstString(record.title, record.name, record.description);
      if (!listingUrl || !title) return null;

      return {
        id: firstString(record.id, record.itemId, record.item_id) ?? `vinted-${index}`,
        title,
        price: firstString(record.price, record.total_item_price, record.amount),
        currency: firstString(record.currency, record.currencyCode, record.currency_code),
        imageUrl: imageFrom(record),
        listingUrl,
        brand: firstString(record.brand, record.brandTitle, record.brand_title),
        size: firstString(record.size, record.sizeTitle, record.size_title),
        source: 'vinted' as const,
      };
    })
    .filter((item): item is SecondhandItem => item !== null)
    .slice(0, limit);
}

async function runApify(request: SearchRequest, fetchImpl: typeof fetch) {
  const actorId = Deno.env.get('APIFY_VINTED_ACTOR_ID');
  const token = Deno.env.get('APIFY_API_TOKEN');
  if (!actorId || !token) {
    console.warn('[search-vinted-secondhand] Missing Apify configuration');
    return { items: [] as SecondhandItem[], error: 'SECONDHAND_RESULTS_UNAVAILABLE' as const };
  }

  const timeoutSecs = Math.min(Math.max(Number(Deno.env.get('APIFY_VINTED_TIMEOUT_SECS')) || 20, 5), 30);
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?timeout=${timeoutSecs}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSecs * 1000 + 1500);
  const startedAt = Date.now();

  try {
    const upstream = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildActorInput(request)),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;

    if (!upstream.ok) {
      console.warn('[search-vinted-secondhand] Apify failure', JSON.stringify({
        status: upstream.status,
        elapsedMs,
      }));
      return { items: [] as SecondhandItem[], error: 'SECONDHAND_RESULTS_UNAVAILABLE' as const };
    }

    const raw = await upstream.json().catch(() => null);
    if (!Array.isArray(raw)) {
      console.warn('[search-vinted-secondhand] Unexpected Apify schema', JSON.stringify({
        elapsedMs,
        schema: raw && typeof raw,
      }));
      return { items: [] as SecondhandItem[], error: 'UPSTREAM_SCHEMA_UNEXPECTED' as const };
    }

    const items = normalizeItems(raw, request.limit ?? 8);
    console.log('[search-vinted-secondhand] success', JSON.stringify({
      elapsedMs,
      rawCount: raw.length,
      resultCount: items.length,
    }));
    return { items };
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError';
    console.warn('[search-vinted-secondhand] Apify exception', JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      items: [] as SecondhandItem[],
      error: isTimeout ? 'UPSTREAM_TIMEOUT' as const : 'SECONDHAND_RESULTS_UNAVAILABLE' as const,
    };
  } finally {
    clearTimeout(timeoutId);
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

export async function handleSearchVintedRequest(req: Request, overrides: RequestOverrides = {}): Promise<Response> {
  const authenticate = overrides.authenticate ?? authenticateRequest;
  const fetchImpl = overrides.fetchImpl ?? fetch;

  const preflight = handleCorsPreflight(req, CORS_POLICY);
  if (preflight) return preflight;

  const corsHeaders = buildCorsHeaders(req, CORS_POLICY);

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  // ── Verified auth + account-state. hooks/useKScan.js's caller already uses
  // an authenticated Supabase client, so this is transparent for active users;
  // the client already degrades gracefully on ANY invoke() error, so a new
  // 401/403 here is a safe rejection path, not a contract break. ────────────
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

  if (!isEnabled()) {
    return json(response(false, [], undefined, 'FEATURE_DISABLED'), 200, corsHeaders);
  }

  // ── Read + parse body (size-bounded read is new; field semantics unchanged;
  // malformed/oversized bodies map to the same INVALID_REQUEST shape the
  // original returned for any unparseable body). ─────────────────────────────
  const bodyResult = await readJsonBody(req, MAX_REQUEST_BODY_BYTES);
  const request = bodyResult.ok ? parseRequest(bodyResult.value) : null;
  if (!request) {
    return json(response(true, [], undefined, 'INVALID_REQUEST'), 400, corsHeaders);
  }

  // ── Quota reservation ────────────────────────────────────────────────────
  let reservationId: string | null = null;
  {
    const fingerprint = await computeRequestFingerprint([userId, FUNCTION_NAME, request.query, request.category ?? '', request.color ?? '', request.brand ?? '', request.size ?? '']);
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
      console.warn('[search-vinted-secondhand] reservation_unavailable requestId=%s reason=%s', requestId, reservation.error);
    }
  }

  const result = await runApify(request, fetchImpl);
  await finalizeReservation(userClient, reservationId, Boolean(result.error));
  logSecurityEvent({
    requestId, userIdFragment: uidFragment, functionName: FUNCTION_NAME, providerCategory: PROVIDER_CATEGORY,
    outcome: result.error ? 'provider_error' : 'success', status: 200,
    quotaDecision: reservationId ? (result.error ? 'released' : 'completed') : 'not_applicable',
    errorCategory: result.error,
  });
  return json(response(true, result.items, request.query, result.error), 200, corsHeaders);
}

Deno.serve((req) => handleSearchVintedRequest(req));
