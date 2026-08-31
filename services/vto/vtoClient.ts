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

export interface VtoGenerateArgs {
  requestId: string;
  origin: VtoOrigin;
  garment: VtoGarmentInput;
  /** Transient base64 of the sanitized person image. Never persisted, never
   *  logged, never attached to any other K Scan surface. */
  personDataUri: string;
  signal?: AbortSignal;
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
    return isVtoFailureCode(code) ? code : null;
  } catch {
    return null;
  }
}

function normalizeSuccess(requestId: string, data: unknown): VtoGenerateOutcome {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'invalid_output' };
  }
  const body = data as Record<string, unknown>;

  // A 200 carrying a failure envelope is still a failure.
  const inner = body.error;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    const code = (inner as Record<string, unknown>).code;
    return { ok: false, code: isVtoFailureCode(code) ? code : 'unknown' };
  }

  const result = body.result;
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
    requestId: typeof body.requestId === 'string' ? body.requestId : requestId,
    provider: typeof body.provider === 'string' ? body.provider : 'unknown',
    dataUri,
    mediaType,
    width: typeof media.width === 'number' ? media.width : null,
    height: typeof media.height === 'number' ? media.height : null,
    latencyMs: typeof media.latencyMs === 'number' ? media.latencyMs : 0,
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

    const body: Record<string, unknown> = {
      requestId: args.requestId,
      origin: args.origin,
      person: { dataUri: args.personDataUri },
      garment: {
        productRef: args.garment.productRef,
        imageUrl: args.garment.imageUrl,
        category: args.garment.category,
        brand: args.garment.brand,
        commerceSource: args.garment.commerceSource,
      },
    };
    if (args.devScenario) body.devScenario = args.devScenario;

    const { data, error } = await invoke(VTO_EDGE_FUNCTION, {
      body,
      signal: controller.signal,
    });

    if (error) {
      if (args.signal?.aborted) return { ok: false, code: 'cancelled' };
      const code = await readVtoContractError(error);
      return { ok: false, code: code ?? 'network_failure' };
    }

    return normalizeSuccess(args.requestId, data);
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    if (aborted && args.signal?.aborted) return { ok: false, code: 'cancelled' };
    return { ok: false, code: aborted ? 'provider_timeout' : 'network_failure' };
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener('abort', onOuterAbort);
  }
}
