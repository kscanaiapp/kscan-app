/**
 * Transport for the `vto-generate` Edge Function.
 *
 * The client's whole job here is: attach a usable session, send the request,
 * and turn whatever comes back into a K Scan failure code. It never sees a
 * provider credential, never chooses a provider, and never surfaces a raw
 * error body -- only the enum `error.code`, read the same bounded way
 * services/scanIdentification.ts reads a contract error.
 */

import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import { isVtoFailureCode } from './vtoFailures';
import type { VtoFailureCode, VtoGarmentInput, VtoOrigin } from '../../types/vto';

export const VTO_EDGE_FUNCTION = 'vto-generate';

/** Client-side ceiling on one invoke. Deliberately longer than the server's
 *  own 45s generation timeout so a server-classified provider_timeout wins
 *  the race and the user is told what actually happened. */
export const VTO_INVOKE_TIMEOUT_MS = 55_000;

/**
 * Transport ceiling for an inline (user-supplied) garment data URI. The same
 * number as VTO_GARMENT_PAYLOAD_MAX_CHARS in types/vto and in the server
 * contract; __tests__/vtoEliseContextualOffer.test.js pins all three equal. Written
 * out here, like the person ceiling in vtoPersonInput, so this transport keeps
 * importing types only.
 */
export const VTO_GARMENT_TRANSPORT_MAX_CHARS = 3_000_000;

export interface VtoGenerateArgs {
  requestId: string;
  origin: VtoOrigin;
  garment: VtoGarmentInput;
  /** Transient base64 of the sanitized person image. Never persisted, never
   *  logged, never attached to any other K Scan surface. */
  personDataUri: string;
  /**
   * Transient data URI of a user-supplied garment, read at generation time.
   * Required for that source and ignored for every other. Like the person
   * payload it is never persisted, never logged, and exists only for this call.
   */
  garmentDataUri?: string;
  signal?: AbortSignal;
  /**
   * VTO-QUOTA-001. The attempt generation for this intent, echoed into the
   * server's idempotency identity (supabase/functions/vto-generate/
   * vtoReservation.ts#buildVtoIdempotencyKey).
   *
   * Two rapid taps carry the SAME generation and collapse to one paid job; an
   * explicit user Retry carries a NEW one and is honoured as a new, separately
   * counted intent. The server documented this mechanism from the start, but no
   * client ever sent the field, so every attempt for a given (actor, product,
   * photo) resolved to the literal 'default' and shared one key -- which is how
   * an unbounded retry loop stayed invisible to the daily cap.
   */
  requestGeneration?: string;
  /** Development only. Ignored by the server unless that deployment has
   *  explicitly opted in via VTO_ALLOW_DEV_SCENARIOS. */
  devScenario?: string;
}

export interface VtoGenerateSuccess {
  ok: true;
  requestId: string;
  provider: string;
  dataUri: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  latencyMs: number;
}

export interface VtoGenerateFailure {
  ok: false;
  code: VtoFailureCode;
  retryAfterSeconds?: number;
}

export type VtoGenerateOutcome = VtoGenerateSuccess | VtoGenerateFailure;

/**
 * Pulls the enum failure code out of a failed invoke.
 *
 * supabase-js reports a non-2xx as a FunctionsHttpError carrying the raw
 * Response on `.context`. Only `error.code` is read; the message and the rest
 * of the body are never surfaced, because a body can carry request content.
 * Any unexpected shape yields null and the caller treats it as a network
 * failure rather than inventing a classification.
 */
export async function readVtoContractError(error: unknown): Promise<VtoFailureCode | null> {
  return (await readVtoContractErrorDetail(error))?.code ?? null;
}

export async function readVtoContractErrorDetail(
  error: unknown,
): Promise<{ code: VtoFailureCode; retryAfterSeconds?: number } | null> {
  try {
    const context = (error as { context?: unknown })?.context as
      | { status?: unknown; json?: () => Promise<unknown> }
      | undefined;
    if (!context || typeof context.json !== 'function') return null;
    const body = await context.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const inner = (body as Record<string, unknown>).error;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
    const code = (inner as Record<string, unknown>).code;
    if (!isVtoFailureCode(code)) return null;
    return withRetryAfter({ code }, (inner as Record<string, unknown>).retryAfterSeconds);
  } catch {
    return null;
  }
}

function withRetryAfter<T extends { code: VtoFailureCode }>(
  detail: T,
  retryAfterSeconds: unknown,
): T & { retryAfterSeconds?: number } {
  return typeof retryAfterSeconds === 'number' ? { ...detail, retryAfterSeconds } : detail;
}

function normalizeSuccess(requestId: string, data: unknown, garment: VtoGarmentInput): VtoGenerateOutcome {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'invalid_output' };
  }
  const body = data as Record<string, unknown>;

  // A 200 carrying a failure envelope is still a failure.
  const inner = body.error;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    const code = (inner as Record<string, unknown>).code;
    return withRetryAfter(
      { ok: false as const, code: isVtoFailureCode(code) ? code : 'unknown' },
      (inner as Record<string, unknown>).retryAfterSeconds,
    );
  }

  const result = body.result;
  if (body.requestId !== requestId) {
    return { ok: false, code: 'invalid_output' };
  }
  // A result is bound to the SOURCE that asked for it: the server echoes what it
  // resolved, and anything that is not exactly that source is not this result.
  if (garment.source?.type === 'closet_item') {
    const source = body.garmentSource as { type?: unknown; closetItemId?: unknown } | undefined;
    if (source?.type !== 'closet_item' || source.closetItemId !== garment.source.closetItemId) {
      return { ok: false, code: 'invalid_output' };
    }
  } else if (garment.source?.type === 'user_supplied_garment') {
    const source = body.garmentSource as
      | { type?: unknown; contentHash?: unknown; contentHashVersion?: unknown }
      | undefined;
    if (
      source?.type !== 'user_supplied_garment'
      || source.contentHash !== garment.source.contentHash
      || source.contentHashVersion !== garment.source.contentHashVersion
    ) {
      return { ok: false, code: 'invalid_output' };
    }
  } else if (garment.source) {
    return { ok: false, code: 'invalid_output' };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, code: 'invalid_output' };
  }
  const media = result as Record<string, unknown>;
  const dataUri = media.dataUri;
  const mediaType = media.mediaType;
  if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) {
    return { ok: false, code: 'invalid_output' };
  }
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) {
    return { ok: false, code: 'invalid_output' };
  }
  return {
    ok: true,
    requestId,
    provider: typeof body.provider === 'string' ? body.provider : 'unknown',
    dataUri,
    mediaType,
    width: typeof media.width === 'number' ? media.width : null,
    height: typeof media.height === 'number' ? media.height : null,
    latencyMs: typeof media.latencyMs === 'number' ? media.latencyMs : 0,
  };
}

/**
 * The garment half of the request, by source.
 *
 *   closet_item           -- a reference only; the server resolves the media.
 *   user_supplied_garment -- the content fingerprint, the category, and the
 *                            bounded bytes. No local id, path or URI is sent:
 *                            the server neither needs nor could use one.
 *   (none)                -- the commerce candidate, as before.
 *
 * Returns null when a user-supplied garment has no bytes or exceeds its bound.
 */
function buildGarmentBody(args: VtoGenerateArgs): Record<string, unknown> | null {
  const { garment } = args;
  if (garment.source?.type === 'closet_item') return { source: garment.source };
  if (garment.source?.type === 'user_supplied_garment') {
    const dataUri = args.garmentDataUri;
    if (typeof dataUri !== 'string' || !dataUri || dataUri.length > VTO_GARMENT_TRANSPORT_MAX_CHARS) {
      return null;
    }
    return {
      source: {
        type: garment.source.type,
        contentHash: garment.source.contentHash,
        contentHashVersion: garment.source.contentHashVersion,
      },
      category: garment.category,
      dataUri,
    };
  }
  if (garment.source) return null;
  return {
    productRef: garment.productRef,
    imageUrl: garment.imageUrl,
    category: garment.category,
    brand: garment.brand,
    commerceSource: garment.commerceSource,
  };
}

export async function requestVtoGeneration(
  args: VtoGenerateArgs,
  deps?: {
    invoke?: typeof supabase.functions.invoke;
    resolveSession?: typeof resolveAuthenticatedFunctionSession;
  },
): Promise<VtoGenerateOutcome> {
  const invoke = deps?.invoke ?? supabase.functions.invoke.bind(supabase.functions);
  const resolveSession = deps?.resolveSession ?? resolveAuthenticatedFunctionSession;

  // Refuse to invoke a protected function without a usable session rather
  // than spending a round trip to be told 401.
  const session = await resolveSession();
  if (session.ok === false) {
    return { ok: false, code: 'authorization_failed' };
  }

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), VTO_INVOKE_TIMEOUT_MS);

  try {
    if (args.signal?.aborted) return { ok: false, code: 'cancelled' };

    const garmentBody = buildGarmentBody(args);
    // No usable garment means no request at all, rather than a round trip the
    // server would have to refuse.
    if (!garmentBody) return { ok: false, code: 'invalid_garment_input' };

    const body: Record<string, unknown> = {
      requestId: args.requestId,
      origin: args.origin,
      person: { dataUri: args.personDataUri },
      garment: garmentBody,
    };
    if (args.requestGeneration) body.requestGeneration = args.requestGeneration;
    if (args.devScenario) body.devScenario = args.devScenario;

    const { data, error } = await invoke(VTO_EDGE_FUNCTION, {
      body,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });

    // Abort remains authoritative even if the underlying transport resolves
    // successfully after cancellation (for example after an actor reset).
    if (args.signal?.aborted) return { ok: false, code: 'cancelled' };
    if (controller.signal.aborted) return { ok: false, code: 'provider_timeout' };

    if (error) {
      if (args.signal?.aborted) return { ok: false, code: 'cancelled' };
      const detail = await readVtoContractErrorDetail(error);
      return detail ? { ok: false, ...detail } : { ok: false, code: 'network_failure' };
    }

    return normalizeSuccess(args.requestId, data, args.garment);
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    if (aborted && args.signal?.aborted) return { ok: false, code: 'cancelled' };
    return { ok: false, code: aborted ? 'provider_timeout' : 'network_failure' };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onOuterAbort);
  }
}
