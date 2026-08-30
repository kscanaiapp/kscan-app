/**
 * VTO generation orchestration.
 *
 * Separated from index.ts so the whole authority chain is callable as a
 * plain function in tests. A module whose only entry point is Deno.serve can
 * be asserted about only by reading its own source text, and a source-text
 * test is green over code that cannot actually run.
 *
 * Server-controlled orchestration for Virtual Try-On. The client can start a
 * try-on; it cannot decide who it is, whether the feature is on, whether it
 * is entitled, which provider runs, what credential is used, or what counts
 * as a valid result.
 *
 * Order is deliberate and fail-closed at every step:
 *   1. drain the request body (see BODY DRAIN below)
 *   2. authenticate  -- identity comes from the verified JWT only
 *   3. account guard -- a deactivated/locked account reaches no provider
 *   4. feature control (app_config) -- disabled means nothing runs
 *   5. K+ entitlement (user_entitlements) -- the existing authority, unchanged
 *   6. eligibility   -- server re-derives it; the client's opinion is advisory
 *   7. person input  -- shape and size bounds
 *   8. provider adapter -- selected by server config, never by the body
 *   9. result validation -- 200 from a provider is not a displayable result
 *
 * BODY DRAIN. Supabase Edge Functions hang for ~160s and then 503 when a
 * handler responds without consuming a request body that was already being
 * streamed to it. Every early return here therefore happens AFTER the body
 * has been read. This is why parsing precedes authentication -- parsing is
 * cheap and total, and no parsed value is trusted for identity.
 *
 * NO PERSISTENCE. This function writes no row and no Storage object. The
 * person image exists only for the life of this request; the result is
 * returned inline and never stored. VTO is visualization and evidence -- it
 * is not ownership, not a Closet write, and not a style signal.
 *
 * NO FIT, NO BODY INFERENCE. Nothing here derives measurements, size advice,
 * body composition, or any health/body judgement, and no such field exists in
 * the contract for one to be smuggled into.
 */

import {
  assertAccountActive,
  corsHeaders,
  json,
  requireUser,
  shortUserId,
} from '../_shared/deletion/common.ts';
import {
  VTO_ORIGINS,
  VTO_PERSON_PAYLOAD_MAX_CHARS,
  type VtoFailureCode,
  type VtoOrigin,
} from './vtoContract.ts';
import { evaluateServerVtoEligibility } from './vtoEligibility.ts';
import { readVtoFeatureConfig } from './vtoFeatureControl.ts';
import { resolveVtoEntitlement } from './vtoEntitlement.ts';
import { validateVtoResultMedia } from './vtoResultValidation.ts';
import { dimensionBucket, logVtoEvent, payloadBucket } from './vtoTelemetry.ts';
import { isMockVtoScenario, resolveVtoProvider } from './providers/index.ts';

/** Wall-clock ceiling on one generation attempt. Bounded well inside the
 *  platform's own request budget so a hung provider surfaces as a clean
 *  provider_timeout instead of an opaque gateway error. */
const GENERATION_TIMEOUT_MS = 45_000;

/** Hard ceiling on the whole request body. Rejected before any parse work. */
const MAX_BODY_CHARS = VTO_PERSON_PAYLOAD_MAX_CHARS + 8_192;

const PERSON_DATA_URI_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const HTTP_STATUS_BY_FAILURE: Readonly<Record<VtoFailureCode, number>> = {
  invalid_person_input: 422,
  invalid_garment_input: 422,
  unsupported_category: 422,
  provider_rejected_input: 422,
  provider_moderation: 422,
  provider_timeout: 504,
  provider_unavailable: 503,
  rate_limited: 429,
  generation_failed: 502,
  invalid_output: 502,
  authorization_failed: 401,
  entitlement_required: 403,
  feature_disabled: 403,
  network_failure: 502,
  cancelled: 499,
  unknown: 500,
};

const RETRYABLE: ReadonlySet<VtoFailureCode> = new Set<VtoFailureCode>([
  'provider_rejected_input',
  'provider_moderation',
  'provider_timeout',
  'provider_unavailable',
  'rate_limited',
  'generation_failed',
  'invalid_output',
  'network_failure',
  'invalid_person_input',
]);

/** Eligibility vocabulary to failure vocabulary. Two eligibility reasons
 *  describe the item's data rather than an attempt, so they are mapped
 *  explicitly instead of leaking a name the client's taxonomy lacks. */
const INELIGIBILITY_TO_FAILURE: Readonly<Record<string, VtoFailureCode>> = {
  unsupported_category: 'unsupported_category',
  missing_garment_image: 'invalid_garment_input',
  invalid_product_reference: 'invalid_garment_input',
  feature_disabled: 'feature_disabled',
  entitlement_required: 'entitlement_required',
  provider_unavailable: 'provider_unavailable',
};

interface FailureContext {
  requestId: string;
  uid?: string;
  origin?: string;
  provider?: string;
  stage: string;
  providerDetail?: string;
  latencyMs?: number;
}

/**
 * The single failure exit. Every denial and every error leaves through here,
 * so the response shape is uniform and a provider's own words can never be
 * one of the branches.
 */
function fail(code: VtoFailureCode, context: FailureContext): Response {
  logVtoEvent('vto_generate_failed', {
    requestId: context.requestId,
    uid: context.uid,
    origin: context.origin,
    provider: context.provider,
    stage: context.stage,
    failureCode: code,
    providerDetail: context.providerDetail,
    latencyMs: context.latencyMs,
  });
  return json(
    {
      requestId: context.requestId,
      status: 'failed',
      error: { code, retryable: RETRYABLE.has(code) },
    },
    HTTP_STATUS_BY_FAILURE[code],
  );
}

function normalizeOrigin(value: unknown): VtoOrigin {
  return typeof value === 'string' && (VTO_ORIGINS as readonly string[]).includes(value)
    ? (value as VtoOrigin)
    : 'commerce_product';
}

/** A client-supplied correlation token, echoed so the app can match a late
 *  response to the request that asked for it. Treated as an opaque label:
 *  bounded, character-restricted, and never used for authorization. */
function normalizeRequestId(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[A-Za-z0-9_.:-]{1,64}$/.test(trimmed)) return trimmed;
  }
  return 'unlabelled';
}

export interface VtoHandlerDeps {
  requireUser: typeof requireUser;
  assertAccountActive: typeof assertAccountActive;
  readVtoFeatureConfig: typeof readVtoFeatureConfig;
  resolveVtoEntitlement: typeof resolveVtoEntitlement;
  resolveVtoProvider: typeof resolveVtoProvider;
  generationTimeoutMs: number;
  devScenariosAllowed: () => boolean;
}

export const defaultVtoHandlerDeps: VtoHandlerDeps = {
  requireUser,
  assertAccountActive,
  readVtoFeatureConfig,
  resolveVtoEntitlement,
  resolveVtoProvider,
  generationTimeoutMs: GENERATION_TIMEOUT_MS,
  devScenariosAllowed: () => Deno.env.get('VTO_ALLOW_DEV_SCENARIOS') === 'true',
};

export async function handleVtoRequest(
  req: Request,
  overrides: Partial<VtoHandlerDeps> = {},
): Promise<Response> {
  // An explicitly-undefined override must fall back to the real dependency
  // rather than blanking it -- a plain spread would install `undefined` and
  // turn a test's "use the default here" into a runtime TypeError.
  const deps: VtoHandlerDeps = { ...defaultVtoHandlerDeps };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (deps as unknown as Record<string, unknown>)[key] = value;
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Read the body FIRST, even for a request we are about to reject on method:
  // responding without draining a streamed body is what produced the 160s
  // hang / 503 in this project's other Edge Functions.
  let rawBodyText = '';
  try {
    rawBodyText = await req.text();
  } catch {
    rawBodyText = '';
  }

  if (req.method !== 'POST') {
    return json({ status: 'failed', error: { code: 'unknown', retryable: false } }, 405);
  }

  if (rawBodyText.length > MAX_BODY_CHARS) {
    return fail('invalid_person_input', { requestId: 'unlabelled', stage: 'body_size' });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = rawBodyText ? JSON.parse(rawBodyText) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const requestId = normalizeRequestId(body.requestId);
  const origin = normalizeOrigin(body.origin);

  // -- 2. Identity: the verified JWT, and nothing else -----------------------
  let authUser;
  try {
    authUser = await deps.requireUser(req);
  } catch {
    return fail('authorization_failed', { requestId, origin, stage: 'authenticate' });
  }
  const uid = shortUserId(authUser.id);

  // -- 3. Account guard ------------------------------------------------------
  try {
    await deps.assertAccountActive(authUser.id);
  } catch {
    return fail('authorization_failed', { requestId, uid, origin, stage: 'account_guard' });
  }

  // -- 4. Feature control (kill switch) --------------------------------------
  const config = await deps.readVtoFeatureConfig();
  if (!config.enabled) {
    return fail('feature_disabled', { requestId, uid, origin, stage: 'feature_control' });
  }

  // -- 5. K+ entitlement, via the existing authority -------------------------
  const entitlement = await deps.resolveVtoEntitlement(authUser.id);
  if (entitlement.state === 'unknown') {
    return fail('authorization_failed', { requestId, uid, origin, stage: 'entitlement_read' });
  }
  if (entitlement.state !== 'active') {
    return fail('entitlement_required', { requestId, uid, origin, stage: 'entitlement' });
  }

  // -- 6. Eligibility, re-derived here ---------------------------------------
  const garment = (body.garment && typeof body.garment === 'object' && !Array.isArray(body.garment)
    ? body.garment
    : {}) as Record<string, unknown>;
  const eligibility = evaluateServerVtoEligibility({
    category: garment.category,
    garmentImageUrl: garment.imageUrl,
    productRef: garment.productRef,
    supportedCategories: config.supportedCategories,
  });
  if (!eligibility.eligible) {
    return fail(INELIGIBILITY_TO_FAILURE[eligibility.reason] ?? 'unknown', {
      requestId,
      uid,
      origin,
      stage: 'eligibility',
    });
  }

  // -- 7. Person input -------------------------------------------------------
  const person = (body.person && typeof body.person === 'object' && !Array.isArray(body.person)
    ? body.person
    : {}) as Record<string, unknown>;
  const personDataUri = typeof person.dataUri === 'string' ? person.dataUri : '';
  if (
    !PERSON_DATA_URI_PATTERN.test(personDataUri)
    || personDataUri.length > VTO_PERSON_PAYLOAD_MAX_CHARS
  ) {
    return fail('invalid_person_input', { requestId, uid, origin, stage: 'person_input' });
  }

  // -- 8. Provider: chosen by server config, never by the request ------------
  // A mock scenario may be driven from the request ONLY when the deployment
  // has explicitly opted in via VTO_ALLOW_DEV_SCENARIOS. Production leaves it
  // unset, so a body can never steer generation behaviour there.
  const devScenariosAllowed = deps.devScenariosAllowed();
  const requestedScenario = devScenariosAllowed && isMockVtoScenario(body.devScenario)
    ? body.devScenario
    : undefined;
  const configuredScenario = isMockVtoScenario(config.mockScenario) ? config.mockScenario : undefined;

  const selection = deps.resolveVtoProvider({
    providerId: config.provider,
    scenario: requestedScenario ?? configuredScenario,
    latencyMs: config.mockLatencyMs ?? undefined,
  });
  if (!selection.ok) {
    return fail('provider_unavailable', {
      requestId,
      uid,
      origin,
      provider: config.provider,
      stage: 'provider_resolve',
    });
  }

  logVtoEvent('vto_generate_start', {
    requestId,
    uid,
    origin,
    provider: selection.provider.id,
    slot: eligibility.slot,
    category: eligibility.canonicalCategory,
    inputBucket: payloadBucket(personDataUri.length),
  });

  // -- 9. Generate, bounded --------------------------------------------------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.generationTimeoutMs);
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = await selection.provider.generate(
      {
        personDataUri,
        garmentImageUrl: eligibility.garmentImageUrl,
        slot: eligibility.slot,
        canonicalCategory: eligibility.canonicalCategory,
      },
      { signal: controller.signal },
    );
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return fail(aborted ? 'provider_timeout' : 'generation_failed', {
      requestId,
      uid,
      origin,
      provider: selection.provider.id,
      stage: 'generate',
      latencyMs: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - startedAt;

  if (!outcome.ok) {
    return fail(outcome.failure, {
      requestId,
      uid,
      origin,
      provider: selection.provider.id,
      stage: 'provider_outcome',
      // Adapter-authored, non-sensitive, server-log only. It is deliberately
      // NOT part of the response body.
      providerDetail: outcome.detail,
      latencyMs,
    });
  }

  // -- 10. A provider success is not yet a K Scan result ---------------------
  const validation = validateVtoResultMedia(outcome.media);
  if (!validation.ok) {
    return fail('invalid_output', {
      requestId,
      uid,
      origin,
      provider: selection.provider.id,
      stage: 'result_validation',
      providerDetail: validation.detail,
      latencyMs,
    });
  }

  logVtoEvent('vto_generate_succeeded', {
    requestId,
    uid,
    origin,
    provider: selection.provider.id,
    slot: eligibility.slot,
    category: eligibility.canonicalCategory,
    latencyMs,
    inputBucket: payloadBucket(personDataUri.length),
    outputBucket: dimensionBucket(validation.media.width, validation.media.height),
    outputBytes: validation.byteLength,
    billedUnits: validation.media.billedUnits ?? undefined,
  });

  return json({
    requestId,
    status: 'success',
    provider: selection.provider.id,
    result: {
      dataUri: validation.media.dataUri,
      mediaType: validation.media.mediaType,
      width: validation.media.width,
      height: validation.media.height,
      isAiVisualization: true,
      latencyMs,
    },
  });
}
