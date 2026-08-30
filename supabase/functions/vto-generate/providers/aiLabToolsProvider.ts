/**
 * Real VTO provider adapter — AILabTools "Try On Clothes Pro", reached via
 * the already-provisioned RapidAPI account (`RAPIDAPI_KEY`, the same secret
 * `nike-shoe-details` and `kickscrew-sneaker-description` already use).
 *
 * PROVIDER STATE AT WRITE TIME: contract-complete, ACCOUNT NOT SUBSCRIBED.
 * An empirical probe against the live endpoint (2026-08-30, staging) returned
 * `403 {"message":"You are not subscribed to this API."}` — the key
 * authenticates against RapidAPI's gateway (proving the host/path/header
 * shape below is correct), but this specific marketplace listing has never
 * been subscribed on the account behind that key. Subscribing is an owner
 * action (RapidAPI dashboard), not something this adapter or this session
 * does. See docs/vto-provider-benchmark.md.
 *
 * Contract, empirically verified live (2026-08-30, staging, synthetic
 * non-personal test images) against `try-on-clothes-pro.p.rapidapi.com`:
 *   POST /portrait/editing/try-on-clothes-pro  (multipart/form-data)
 *     task_type=async, person_image (file), top_garment (file, REQUIRED),
 *     bottom_garment (file, optional), resolution, restore_face
 *   -> { error_code, task_type: 'async', task_id }
 *   GET  /api/rapidapi/query-async-task-result?task_id=...
 *   -> { error_code, task_status: 0|1|2, output: { image_url }, usage }
 *
 * POLL PATH CORRECTED 2026-08-30: the path above (`/api/rapidapi/...`) is
 * this RapidAPI listing's OWN path, discovered from its playground UI --
 * NOT `/common/query-async-task-result`, the path AILabTools' direct
 * (non-RapidAPI) API documentation uses. That mismatch is exactly why the
 * original version of this adapter never got a real end-to-end proof: the
 * submit call succeeded (real task_id) but every poll 404'd against a path
 * this listing simply doesn't expose. A live submit+poll+result round trip
 * now succeeds; see docs/vto-provider-benchmark.md for the transcript.
 *
 * ONE-PIECE / DRESS MAPPING (corrected 2026-08-30 after re-reading the
 * documented contract, confirmed verbatim and identically across two
 * independent doc pages): "If lower body clothing is not needed (e.g., when
 * the upper body garment is a dress), this value should be left empty."
 * `top_garment` is the documented, supported slot for a one-piece garment --
 * `bottom_garment` is simply omitted. So `full_body` IS servable: it is
 * submitted exactly like `top` (garment -> `top_garment`, no
 * `bottom_garment`). Only `bottom` remains unservable, because
 * `top_garment` is REQUIRED and there is no way to submit a bottom alone --
 * see `unsupportedSlotReason`.
 *
 * A prior version of this adapter (and of docs/vto-provider-benchmark.md)
 * incorrectly refused `full_body` outright, on an initial reading of the
 * docs that missed this note. That was wrong; both were corrected together.
 */

import type {
  VtoProvider,
  VtoProviderInput,
  VtoProviderMedia,
  VtoProviderOutcome,
} from '../vtoContract.ts';

export const AILABTOOLS_PROVIDER_ID = 'ailabtools_tryon_clothes_pro';

interface SubmitFetcher {
  (url: string, init: RequestInit): Promise<Response>;
}

const RAPIDAPI_HOST = 'try-on-clothes-pro.p.rapidapi.com';
const SUBMIT_URL = `https://${RAPIDAPI_HOST}/portrait/editing/try-on-clothes-pro`;
const POLL_URL = `https://${RAPIDAPI_HOST}/api/rapidapi/query-async-task-result`;

/** Bounded: this is a 4096x4096px-capped, 5MB-capped upstream contract; a
 *  garment fetch far past that is either wrong data or an attempt to make
 *  this server fetch something unreasonable. */
const GARMENT_FETCH_MAX_BYTES = 8 * 1024 * 1024;
const GARMENT_FETCH_TIMEOUT_MS = 8_000;
const RESULT_FETCH_TIMEOUT_MS = 15_000;

/** Poll cadence. The vendor documents no SLA; this is a conservative budget
 *  bounded well inside the orchestrator's own 45s generation ceiling. */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 18; // ~36s of polling after submit

function dataUriToBlob(dataUri: string): { blob: Blob; mediaType: string } | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { blob: new Blob([bytes], { type: match[1] }), mediaType: match[1] };
  } catch {
    return null;
  }
}

async function fetchWithTimeoutAndCap(
  url: string,
  timeoutMs: number,
  maxBytes: number,
  outerSignal: AbortSignal,
  fetchImpl: SubmitFetcher,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer>; mediaType: string } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' };
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    return { ok: true, bytes: new Uint8Array(buf) as Uint8Array<ArrayBuffer>, mediaType };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'fetch_error' };
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Maps a slot this adapter cannot serve into a K Scan failure reason.
 *
 * `top` and `full_body` are both submitted through `top_garment` -- the
 * documented mechanism for a one-piece garment is exactly "use top_garment,
 * leave bottom_garment empty" (see the module doc comment). Only `bottom` is
 * genuinely unservable: `top_garment` is REQUIRED, so there is no way to
 * submit a bottom-only garment without also supplying an unrelated top image
 * the caller never chose.
 */
export function unsupportedSlotReason(slot: VtoProviderInput['slot']): string | null {
  if (slot === 'top' || slot === 'full_body') return null;
  return 'this provider requires a top_garment image and has no bottom-only path';
}


export interface AiLabToolsAdapterOptions {
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: SubmitFetcher;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}

function mapSubmitFailure(httpStatus: number, body: unknown): VtoProviderOutcome & { ok: false } {
  if (httpStatus === 401 || httpStatus === 403) {
    return { ok: false, failure: 'provider_unavailable', detail: `submit_http_${httpStatus}` };
  }
  if (httpStatus === 429) {
    return { ok: false, failure: 'rate_limited', detail: 'submit_http_429' };
  }
  if (httpStatus >= 500) {
    return { ok: false, failure: 'provider_unavailable', detail: `submit_http_${httpStatus}` };
  }
  const message =
    typeof (body as Record<string, unknown> | null)?.error_msg === 'string'
      ? ((body as Record<string, unknown>).error_msg as string)
      : typeof (body as Record<string, unknown> | null)?.message === 'string'
        ? ((body as Record<string, unknown>).message as string)
        : '';
  if (/moderat|nsfw|explicit|inappropriate/i.test(message)) {
    return { ok: false, failure: 'provider_moderation', detail: 'submit_rejected_moderation' };
  }
  return { ok: false, failure: 'provider_rejected_input', detail: `submit_http_${httpStatus}` };
}

export function createAiLabToolsProvider(options: AiLabToolsAdapterOptions): VtoProvider {
  const doFetch: SubmitFetcher = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollMaxAttempts = options.pollMaxAttempts ?? POLL_MAX_ATTEMPTS;

  return {
    id: AILABTOOLS_PROVIDER_ID,
    async generate(input: VtoProviderInput, { signal }: { signal: AbortSignal }): Promise<VtoProviderOutcome> {
      const unsupported = unsupportedSlotReason(input.slot);
      if (unsupported) {
        return { ok: false, failure: 'unsupported_category', detail: unsupported };
      }

      const person = dataUriToBlob(input.personDataUri);
      if (!person) {
        return { ok: false, failure: 'invalid_person_input', detail: 'person_data_uri_undecodable' };
      }

      const garment = await fetchWithTimeoutAndCap(
        input.garmentImageUrl,
        GARMENT_FETCH_TIMEOUT_MS,
        GARMENT_FETCH_MAX_BYTES,
        signal,
        doFetch,
      );
      if (!garment.ok) {
        return { ok: false, failure: 'invalid_garment_input', detail: `garment_fetch_${garment.reason}` };
      }

      const form = new FormData();
      form.set('task_type', 'async');
      form.set('person_image', person.blob, 'person.jpg');
      form.set(
        'top_garment',
        new Blob([garment.bytes], { type: garment.mediaType }),
        'garment.jpg',
      );

      let submitResponse: Response;
      try {
        submitResponse = await doFetch(SUBMIT_URL, {
          method: 'POST',
          headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': options.apiKey },
          body: form,
          signal,
        });
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        return {
          ok: false,
          failure: aborted ? 'cancelled' : 'network_failure',
          detail: aborted ? 'submit_aborted' : 'submit_fetch_threw',
        };
      }

      const submitBody = await submitResponse.json().catch(() => null);
      if (!submitResponse.ok) {
        return mapSubmitFailure(submitResponse.status, submitBody);
      }
      const errorCode = (submitBody as Record<string, unknown> | null)?.error_code;
      if (typeof errorCode === 'number' && errorCode !== 0) {
        return mapSubmitFailure(submitResponse.status, submitBody);
      }
      const taskId = (submitBody as Record<string, unknown> | null)?.task_id;
      if (typeof taskId !== 'string' || !taskId) {
        return { ok: false, failure: 'invalid_output', detail: 'submit_missing_task_id' };
      }

      for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
        if (signal.aborted) return { ok: false, failure: 'cancelled', detail: 'poll_aborted' };
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, pollIntervalMs);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }).catch(() => {});
        if (signal.aborted) return { ok: false, failure: 'cancelled', detail: 'poll_aborted' };

        let pollResponse: Response;
        try {
          pollResponse = await doFetch(`${POLL_URL}?task_id=${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: { 'x-rapidapi-host': RAPIDAPI_HOST, 'x-rapidapi-key': options.apiKey },
            signal,
          });
        } catch (err) {
          const aborted = err instanceof DOMException && err.name === 'AbortError';
          if (aborted) return { ok: false, failure: 'cancelled', detail: 'poll_aborted' };
          continue; // one transient poll failure is not fatal; keep polling within the budget
        }

        const pollBody = await pollResponse.json().catch(() => null);
        const pollErrorCode = (pollBody as Record<string, unknown> | null)?.error_code;
        // A non-2xx poll response with a parseable error_code is a REAL,
        // terminal AILabTools processing error (proven live 2026-08-30: a
        // 413 FILE_SIZE_EXCEEDS_LIMIT during processing) -- it must fail
        // immediately, not be treated as transient. Only a non-2xx response
        // with NO error body at all (an unexpected gateway hiccup) is worth
        // retrying within the poll budget.
        if (!pollResponse.ok) {
          if (pollBody && typeof pollErrorCode === 'number' && pollErrorCode !== 0) {
            return mapSubmitFailure(pollResponse.status, pollBody);
          }
          continue;
        }
        if (typeof pollErrorCode === 'number' && pollErrorCode !== 0) {
          return mapSubmitFailure(pollResponse.status, pollBody);
        }

        const taskStatus = (pollBody as Record<string, unknown> | null)?.task_status;
        if (taskStatus === 2) {
          const output = (pollBody as Record<string, unknown> | null)?.output as
            | Record<string, unknown>
            | undefined;
          const imageUrl = output?.image_url;
          if (typeof imageUrl !== 'string' || !imageUrl) {
            return { ok: false, failure: 'invalid_output', detail: 'poll_missing_image_url' };
          }
          const media = await fetchResultAsMedia(imageUrl, signal, doFetch);
          return media;
        }
        // 0 (queued) / 1 (processing) / anything else: keep polling.
      }

      return { ok: false, failure: 'provider_timeout', detail: 'poll_budget_exhausted' };
    },
  };
}

async function fetchResultAsMedia(
  imageUrl: string,
  signal: AbortSignal,
  fetchImpl: SubmitFetcher,
): Promise<VtoProviderOutcome> {
  const fetched = await fetchWithTimeoutAndCap(imageUrl, RESULT_FETCH_TIMEOUT_MS, 8 * 1024 * 1024, signal, fetchImpl);
  if (!fetched.ok) {
    return { ok: false, failure: 'invalid_output', detail: `result_fetch_${fetched.reason}` };
  }
  const media: VtoProviderMedia = {
    dataUri: `data:${fetched.mediaType};base64,${bytesToBase64(fetched.bytes)}`,
    mediaType: fetched.mediaType,
    width: null,
    height: null,
  };
  return { ok: true, media };
}
