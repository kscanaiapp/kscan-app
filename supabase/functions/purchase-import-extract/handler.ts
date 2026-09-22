/**
 * Receipt & Purchase Intelligence V1 — purchase-import-extract orchestration.
 *
 * ONE DOCUMENT -> ONE STRUCTURED EXTRACTION. One cropped image in, one bounded
 * JSON review payload out. No Commerce call, no product resolution, no retailer
 * lookup, no persistence.
 *
 * Order is deliberate and fail-closed at every step:
 *   1. drain the request body (Edge Functions hang when a streamed body is
 *      left unread, see vto-generate/vtoHandler.ts BODY DRAIN)
 *   2. authenticate -- identity from the verified JWT only
 *   3. anonymous identities refused -- no anonymous paid-provider access
 *   4. account guard -- a deactivated or deleting account reaches nothing
 *   5. kill switch -- PURCHASE_IMPORT_EXTRACT_ENABLED must be exactly "true"
 *   6. input bounds -- contract version, tier, base64 shape and size
 *   7. per-actor reservation -- reserve_provider_request (BLOCK-RPI-31)
 *   8. one provider call, with one approved fallback on transient failure
 *   9. settle: complete on a billable call, release on a non-billable failure
 *  10. sanitize -- confidence floor, item bound, scrub, enums
 *
 * NO PERSISTENCE AND NO CONTENT IN LOGS. This function writes no row and no
 * Storage object. The image and the model response exist only for the life of
 * the request. Log lines carry classes and counts, never document content, and
 * never the raw provider body.
 */

import {
  assertAccountActive,
  corsHeaders,
  env,
  isEligibleAccountActor,
  json,
  logEvent,
  requireUser,
  shortUserId,
} from '../_shared/deletion/common.ts';
import {
  classifyProviderHttpFailure,
  isRetryableProviderFailure,
  nextAttemptModel,
  resolveRetryDelayMs,
  resolveRoutePlan,
} from '../_shared/llmModelRouting.ts';
import {
  completeProviderRequest,
  computeRequestFingerprint,
  releaseProviderRequest,
  reserveProviderRequest,
} from '../_shared/security/quota.ts';
import {
  INPUT_TIERS,
  PURCHASE_EXTRACTION_RESPONSE_SCHEMA,
  PURCHASE_IMPORT_CONTRACT_VERSION,
  PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES,
  buildExtractionPrompt,
  parseGeminiEnvelope,
  sanitizeExtraction,
  type InputTier,
} from './extraction.ts';

export const FUNCTION_NAME = 'purchase-import-extract';
export const PROVIDER_CATEGORY = 'vision_ai';
/** Body cap: the image bound plus room for the small JSON envelope. */
export const MAX_BODY_CHARS = PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES + 4_096;
/** Per-attempt provider timeout. Two attempts stay inside the client's 45s ceiling. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 18_000;
export const MAX_OUTPUT_TOKENS = 6_144;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export type FailureClass =
  | 'invalid_file'
  | 'file_too_large'
  | 'unreadable_document'
  | 'too_many_items'
  | 'provider_unavailable'
  | 'schema_validation_failed'
  | 'unauthorized'
  | 'rate_limited'
  | 'feature_disabled';

const STATUS: Record<FailureClass, number> = {
  invalid_file: 400,
  file_too_large: 413,
  unreadable_document: 200,
  too_many_items: 200,
  provider_unavailable: 503,
  schema_validation_failed: 502,
  unauthorized: 401,
  rate_limited: 429,
  feature_disabled: 503,
};

type Reservation = { allowed: boolean; reservationId: string | null; retryAfterSeconds: number | null };

export interface PurchaseImportDeps {
  requireUser: typeof requireUser;
  assertAccountActive: typeof assertAccountActive;
  isEnabled: () => boolean;
  reserve: (accessToken: string, requestId: string, userId: string) => Promise<Reservation | null>;
  settle: (accessToken: string, reservationId: string, billable: boolean) => Promise<void>;
  callProvider: (
    model: string,
    body: unknown,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; status: number; text: string; retryAfter: string | null }>;
  sleep: (ms: number) => Promise<void>;
  attemptTimeoutMs: number;
}

async function userClient(accessToken: string) {
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  return createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export const defaultPurchaseImportDeps: PurchaseImportDeps = {
  requireUser,
  assertAccountActive,
  isEnabled: () => (Deno.env.get('PURCHASE_IMPORT_EXTRACT_ENABLED') ?? '').trim() === 'true',
  reserve: async (accessToken, requestId, userId) => {
    try {
      const client = await userClient(accessToken);
      // The fingerprint covers the actor and the client's random session id
      // only. It is never derived from the image, so it cannot identify a
      // receipt (spec section 22).
      const fingerprint = await computeRequestFingerprint([FUNCTION_NAME, userId, requestId]);
      const outcome = await reserveProviderRequest(client as never, {
        functionName: FUNCTION_NAME,
        providerCategory: PROVIDER_CATEGORY,
        requestId,
        requestFingerprint: fingerprint,
        costUnits: 2,
      });
      if (!outcome.ok) return null;
      return {
        allowed: outcome.value.allowed,
        reservationId: outcome.value.reservationId,
        retryAfterSeconds: outcome.value.retryAfterSeconds,
      };
    } catch {
      return null;
    }
  },
  settle: async (accessToken, reservationId, billable) => {
    try {
      const client = await userClient(accessToken);
      if (billable) await completeProviderRequest(client as never, reservationId);
      else await releaseProviderRequest(client as never, reservationId, 'provider_not_billable');
    } catch {
      // The reservation TTL reclaims an unsettled reservation.
    }
  },
  callProvider: async (model, body, signal) => {
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return { ok: false, status: 500, text: '', retryAfter: null };
    const url = new URL(`${GEMINI_API_BASE}/${model}:generateContent`);
    url.searchParams.set('key', key);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text, retryAfter: res.headers.get('retry-after') };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attemptTimeoutMs: PROVIDER_ATTEMPT_TIMEOUT_MS,
};

function respondFailure(
  errorClass: FailureClass,
  log: Record<string, unknown>,
  retryAfterSeconds: number | null = null,
): Response {
  logEvent('purchase_import_extract_failed', { ...log, errorClass });
  const headers: Record<string, string> = {};
  if (errorClass === 'rate_limited' && retryAfterSeconds) headers['Retry-After'] = String(retryAfterSeconds);
  const response = json(
    { ok: false, contractVersion: PURCHASE_IMPORT_CONTRACT_VERSION, errorClass, retryAfterSeconds },
    STATUS[errorClass],
  );
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

function normalizeRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{6,64}$/.test(value.trim()) ? value.trim() : null;
}

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

function looksLikeJpeg(base64: string): boolean {
  // A JPEG starts FF D8 FF, which is "/9j/" in base64. The client always sends
  // a re-encoded JPEG, so anything else is not an image this contract accepts.
  return base64.startsWith('/9j/');
}

export async function handlePurchaseImportRequest(
  req: Request,
  overrides: Partial<PurchaseImportDeps> = {},
): Promise<Response> {
  const deps: PurchaseImportDeps = { ...defaultPurchaseImportDeps };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (deps as unknown as Record<string, unknown>)[key] = value;
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // 1. Drain first.
  let rawBody = '';
  try {
    rawBody = await req.text();
  } catch {
    rawBody = '';
  }
  if (req.method !== 'POST') return respondFailure('invalid_file', { stage: 'method' });
  if (rawBody.length > MAX_BODY_CHARS) return respondFailure('file_too_large', { stage: 'body_size' });

  let body: Record<string, unknown> = {};
  try {
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  // 2-4. Identity, anonymous refusal, account guard.
  let user;
  try {
    user = await deps.requireUser(req);
  } catch {
    return respondFailure('unauthorized', { stage: 'authenticate' });
  }
  if (!isEligibleAccountActor(user)) {
    return respondFailure('unauthorized', { stage: 'anonymous_actor' });
  }
  const uid = shortUserId(user.id);
  try {
    await deps.assertAccountActive(user.id);
  } catch {
    return respondFailure('unauthorized', { uid, stage: 'account_guard' });
  }

  // 5. Kill switch. Default off.
  if (!deps.isEnabled()) return respondFailure('feature_disabled', { uid, stage: 'kill_switch' });

  // 6. Input bounds. Refused, never truncated.
  if (body.contractVersion !== PURCHASE_IMPORT_CONTRACT_VERSION) {
    return respondFailure('invalid_file', { uid, stage: 'contract_version' });
  }
  const requestId = normalizeRequestId(body.requestId);
  if (!requestId) return respondFailure('invalid_file', { uid, stage: 'request_id' });
  const inputTier = (INPUT_TIERS as readonly string[]).includes(body.inputTier as string)
    ? (body.inputTier as InputTier)
    : null;
  if (!inputTier) return respondFailure('invalid_file', { uid, stage: 'input_tier' });
  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
  if (imageBase64.length > PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES) {
    return respondFailure('file_too_large', { uid, stage: 'image_size' });
  }
  if (imageBase64.length < 64 || imageBase64.length % 4 === 1 || !BASE64_SHAPE.test(imageBase64) || !looksLikeJpeg(imageBase64)) {
    return respondFailure('invalid_file', { uid, stage: 'image_shape' });
  }

  // 7. Per-actor reservation (BLOCK-RPI-31). Fails closed: no reservation, no call.
  const reservation = await deps.reserve(user.accessToken, requestId, user.id);
  if (!reservation) return respondFailure('provider_unavailable', { uid, stage: 'reserve_unavailable' });
  if (!reservation.allowed || !reservation.reservationId) {
    return respondFailure('rate_limited', { uid, stage: 'reserve_denied' }, reservation.retryAfterSeconds);
  }

  // 8. One extraction, with one approved fallback on a transient failure only.
  //    Scanner routing with NO environment override: the model is pinned to
  //    the approved allowlist.
  const plan = resolveRoutePlan('scanner', () => undefined);
  const geminiBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: buildExtractionPrompt(inputTier) },
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: PURCHASE_EXTRACTION_RESPONSE_SCHEMA,
    },
  };

  let billable = false;
  let providerText = '';
  let attempts = 0;
  let lastKind = 'none';
  try {
    for (let attempt = 1; attempt <= plan.maxAttempts; attempt += 1) {
      const model = nextAttemptModel(plan, attempt);
      if (!model) break;
      attempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.attemptTimeoutMs);
      let result;
      try {
        result = await deps.callProvider(model, geminiBody, controller.signal);
      } catch {
        result = { ok: false, status: 0, text: '', retryAfter: null };
      } finally {
        clearTimeout(timer);
      }
      if (result.ok) {
        billable = true;
        providerText = result.text;
        break;
      }
      let meta: Record<string, unknown> = {};
      try {
        meta = (JSON.parse(result.text)?.error ?? {}) as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const kind = result.status === 0 ? 'timeout' : classifyProviderHttpFailure(result.status, meta);
      lastKind = kind;
      if (!isRetryableProviderFailure(kind as never) || attempt >= plan.maxAttempts) break;
      await deps.sleep(resolveRetryDelayMs(attempt, result.retryAfter));
    }
  } finally {
    // 9. Settle. A call that never produced a billable response is released,
    //    so a provider outage does not consume the customer's allowance.
    await deps.settle(user.accessToken, reservation.reservationId, billable);
  }

  if (!billable) {
    return respondFailure('provider_unavailable', { uid, stage: 'provider', attempts, kind: lastKind });
  }

  // 10. Parse and sanitize. The raw provider body never leaves this function.
  let envelope: unknown = null;
  try {
    envelope = JSON.parse(providerText);
  } catch {
    envelope = null;
  }
  const parsed = parseGeminiEnvelope(envelope);
  if (parsed.ok === false) return respondFailure(parsed.errorClass, { uid, stage: 'parse', attempts });
  const sanitized = sanitizeExtraction(parsed.value);
  if (sanitized.ok === false) return respondFailure(sanitized.errorClass, { uid, stage: 'sanitize', attempts });

  logEvent('purchase_import_extract_completed', {
    uid,
    attempts,
    inputTier,
    itemCount: sanitized.items.length,
  });
  return json(
    {
      ok: true,
      contractVersion: PURCHASE_IMPORT_CONTRACT_VERSION,
      document: sanitized.document,
      items: sanitized.items,
    },
    200,
  );
}
