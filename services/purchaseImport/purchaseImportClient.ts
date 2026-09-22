// Receipt & Purchase Intelligence V1 — the one network call.
//
// ONE DOCUMENT -> ONE STRUCTURED EXTRACTION (spec section 35). This module
// sends one prepared, cropped, metadata-free image to the governed
// purchase-import-extract Edge Function and returns a review model or a typed
// error. No Commerce, retailer or product-resolution call is made for any
// extracted item.
//
// It never reads a server message body for display. Only the HTTP status and
// the enum `errorClass` are consulted.

import { supabase } from '../supabaseClient';
import { resolveAuthenticatedFunctionSession } from '../authenticatedFunctionSession';
import { RECEIPT_INTELLIGENCE_V1 } from '../../constants/featureFlags';
import {
  PURCHASE_IMPORT_CONTRACT_VERSION,
  PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES,
  type PurchaseImportInputTier,
} from './purchaseImportContract';
import { classifyTransportFailure, type PurchaseImportErrorClass } from './purchaseImportErrors';
import { normalizePurchaseExtraction, type PurchaseReviewModel } from './purchaseImportNormalizer';

export const PURCHASE_IMPORT_FUNCTION_NAME = 'purchase-import-extract';

/**
 * Client ceiling. The server's provider budget is two attempts at most, each
 * bounded below this, so a request that outlives it is abandoned rather than
 * left spinning.
 */
export const PURCHASE_IMPORT_CLIENT_TIMEOUT_MS = 45_000;

export type ExtractResult =
  | { ok: true; review: Extract<PurchaseReviewModel, { state: 'ready' }> }
  | { ok: false; errorClass: PurchaseImportErrorClass };

type InvokeFn = (
  name: string,
  options: { body: unknown; signal?: AbortSignal },
) => Promise<{ data: unknown; error: unknown }>;

export type ExtractDeps = {
  enabled?: boolean;
  invoke?: InvokeFn;
  resolveSession?: typeof resolveAuthenticatedFunctionSession;
  today?: () => string;
  timeoutMs?: number;
};

async function readServerFailure(error: unknown): Promise<{ httpStatus: number | null; errorClass: unknown }> {
  try {
    const context = (error as { context?: unknown })?.context as
      | { status?: unknown; json?: () => Promise<unknown> }
      | undefined;
    const httpStatus = typeof context?.status === 'number' ? context.status : null;
    if (!context || typeof context.json !== 'function') return { httpStatus, errorClass: undefined };
    const body = await context.json();
    const errorClass =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).errorClass
        : undefined;
    return { httpStatus, errorClass };
  } catch {
    return { httpStatus: null, errorClass: undefined };
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract purchase candidates from one prepared image.
 *
 * `signal` is the workflow's cancellation. Cancelling it, or the timeout
 * firing, abandons the request, and its late result is never applied.
 */
export async function extractPurchaseCandidates(
  input: { imageBase64: string; inputTier: PurchaseImportInputTier; requestId: string; signal?: AbortSignal },
  deps: ExtractDeps = {},
): Promise<ExtractResult> {
  // BLOCK-RPI-33: with the flag off there is no extraction path at all, even
  // if something reaches this function directly.
  const enabled = deps.enabled ?? RECEIPT_INTELLIGENCE_V1;
  if (!enabled) return { ok: false, errorClass: 'feature_disabled' };

  if (typeof input.imageBase64 !== 'string' || input.imageBase64.length === 0) {
    return { ok: false, errorClass: 'invalid_file' };
  }
  if (input.imageBase64.length > PURCHASE_IMPORT_MAX_IMAGE_BASE64_BYTES) {
    return { ok: false, errorClass: 'file_too_large' };
  }
  if (input.signal?.aborted) return { ok: false, errorClass: 'provider_unavailable' };

  const session = await (deps.resolveSession ?? resolveAuthenticatedFunctionSession)();
  if (session.ok === false) return { ok: false, errorClass: 'unauthorized' };

  const invoke: InvokeFn =
    deps.invoke ?? ((name, options) => supabase.functions.invoke(name, options as never) as never);
  const controller = new AbortController();
  const forward = () => controller.abort();
  input.signal?.addEventListener('abort', forward);
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PURCHASE_IMPORT_CLIENT_TIMEOUT_MS);

  try {
    const { data, error } = await invoke(PURCHASE_IMPORT_FUNCTION_NAME, {
      body: {
        contractVersion: PURCHASE_IMPORT_CONTRACT_VERSION,
        requestId: input.requestId,
        inputTier: input.inputTier,
        imageBase64: input.imageBase64,
      },
      signal: controller.signal,
    });

    if (error) {
      if (controller.signal.aborted) return { ok: false, errorClass: 'provider_unavailable' };
      const failure = await readServerFailure(error);
      const offline =
        failure.httpStatus === null &&
        /network|fetch|failed to fetch/i.test(String((error as { name?: unknown })?.name ?? ''));
      return {
        ok: false,
        errorClass: classifyTransportFailure({
          offline,
          httpStatus: failure.httpStatus,
          serverErrorClass: failure.errorClass,
        }),
      };
    }

    const body = data as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || body.contractVersion !== PURCHASE_IMPORT_CONTRACT_VERSION) {
      return { ok: false, errorClass: 'schema_validation_failed' };
    }
    if (body.ok !== true) {
      return { ok: false, errorClass: classifyTransportFailure({ serverErrorClass: body.errorClass }) };
    }

    const review = normalizePurchaseExtraction(body, { today: (deps.today ?? todayIso)() });
    switch (review.state) {
      case 'ready':
        return { ok: true, review };
      case 'no_fashion':
        return { ok: false, errorClass: 'no_fashion_purchases' };
      case 'unreadable':
        return { ok: false, errorClass: 'unreadable_document' };
      case 'too_many_items':
        return { ok: false, errorClass: 'too_many_items' };
      default:
        return { ok: false, errorClass: 'schema_validation_failed' };
    }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, errorClass: 'provider_unavailable' };
    const name = String((err as { name?: unknown })?.name ?? '');
    return {
      ok: false,
      errorClass: /network|fetch/i.test(name) ? 'network_unavailable' : 'provider_unavailable',
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', forward);
  }
}
