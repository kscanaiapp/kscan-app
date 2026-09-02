/**
 * Development VTO provider.
 *
 * Built to behave like a real network-bound generation provider, not like an
 * instantly-successful stub: it takes real wall-clock time, it honours the
 * caller's AbortSignal, and it can be driven into each failure the UI has to
 * survive. That is the point -- loading, cancellation, supersede, retry and
 * failure states are only trustworthy if they were exercised against
 * something that behaves like the real thing.
 *
 * Scenarios are DETERMINISTIC. There is no randomness here: an automated test
 * that sometimes fails teaches nothing.
 */

import {
  type VtoProvider,
  type VtoProviderInput,
  type VtoProviderOutcome,
} from '../vtoContract.ts';
import {
  MOCK_VTO_RESULT_DATA_URI,
  MOCK_VTO_RESULT_HEIGHT,
  MOCK_VTO_RESULT_MEDIA_TYPE,
  MOCK_VTO_RESULT_WIDTH,
} from './mockResultAsset.ts';

export const MOCK_VTO_PROVIDER_ID = 'mock';

export const MOCK_VTO_SCENARIOS = [
  'success',
  'timeout',
  'rejected_input',
  'provider_unavailable',
  'invalid_output',
  'moderation',
  'rate_limited',
] as const;
export type MockVtoScenario = (typeof MOCK_VTO_SCENARIOS)[number];

/** Interactive default: long enough that a spinner, a cancel button and a
 *  supersede are all reachable by a human, short enough to be usable. */
export const MOCK_VTO_DEFAULT_LATENCY_MS = 6_000;

export function isMockVtoScenario(value: unknown): value is MockVtoScenario {
  return typeof value === 'string' && (MOCK_VTO_SCENARIOS as readonly string[]).includes(value);
}

export interface MockProviderOptions {
  scenario?: MockVtoScenario;
  /** Simulated generation time. 0 is the fast path automated tests use. */
  latencyMs?: number;
  /** Injectable clock so tests never actually sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Largest delay setTimeout represents faithfully. Anything above this
 *  overflows to a 32-bit signed int and fires almost immediately -- which
 *  silently turns "sleep forever" into "return at once", so it is clamped
 *  rather than passed through. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Abort-aware sleep. Rejects with an AbortError the moment the signal fires,
 *  which is exactly how a real fetch behaves under cancellation. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal.aborted
      ? Promise.reject(new DOMException('Aborted', 'AbortError'))
      : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(ms, MAX_TIMEOUT_MS));
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A promise that settles only when the signal aborts. */
export function neverSettle(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** An output that is structurally a data URI but is not a usable image.
 *  Used by the 'invalid_output' scenario to prove the validation seam is
 *  load-bearing rather than decorative. */
const CORRUPT_OUTPUT_DATA_URI = 'data:image/png;base64,bm90LWFuLWltYWdl';

export function createMockVtoProvider(options: MockProviderOptions = {}): VtoProvider {
  const scenario: MockVtoScenario = options.scenario ?? 'success';
  const latencyMs = typeof options.latencyMs === 'number' && options.latencyMs >= 0
    ? options.latencyMs
    : MOCK_VTO_DEFAULT_LATENCY_MS;
  const sleep = options.sleep ?? abortableSleep;

  return {
    id: MOCK_VTO_PROVIDER_ID,
    async generate(
      input: VtoProviderInput,
      { signal }: { signal: AbortSignal },
    ): Promise<VtoProviderOutcome> {
      // Input shape is checked before any simulated work: a real provider
      // rejects a malformed request immediately, and the orchestrator's
      // error mapping should be exercised on that path too.
      if (!input.personDataUri.startsWith('data:image/')) {
        return {
          ok: false, failure: 'provider_rejected_input', detail: 'person_not_image_data_uri', billable: false,
        };
      }
      if (!input.garmentImageUrl.startsWith('https://')) {
        return { ok: false, failure: 'invalid_garment_input', detail: 'garment_not_https', billable: false };
      }

      // VTO-QUOTA-003. These two model a gateway refusal BEFORE any work, so
      // they are non-billable -- which is also what makes the mock able to
      // exercise the orchestrator's release path at all.
      if (scenario === 'provider_unavailable') {
        return { ok: false, failure: 'provider_unavailable', detail: 'mock_scenario', billable: false };
      }
      if (scenario === 'rate_limited') {
        return { ok: false, failure: 'rate_limited', detail: 'mock_scenario', billable: false };
      }

      // Everything past here spends time, exactly like a generation call.
      await sleep(latencyMs, signal);

      switch (scenario) {
        case 'timeout':
          // Genuinely never resolves: only the caller's abort ends this, so
          // the orchestrator's own timeout is what gets exercised. It is NOT
          // written as a very long sleep -- setTimeout overflows above 2^31-1
          // and would fire at once, quietly turning this into an ordinary
          // failure return that looks like the timeout path but is not.
          await neverSettle(signal);
          throw new DOMException('Aborted', 'AbortError');
        case 'rejected_input':
          return { ok: false, failure: 'provider_rejected_input', detail: 'mock_scenario' };
        case 'moderation':
          return { ok: false, failure: 'provider_moderation', detail: 'mock_scenario' };
        case 'invalid_output':
          return {
            ok: true,
            media: {
              dataUri: CORRUPT_OUTPUT_DATA_URI,
              mediaType: 'image/png',
              width: null,
              height: null,
              billedUnits: null,
            },
          };
        case 'success':
        default:
          return {
            ok: true,
            media: {
              dataUri: MOCK_VTO_RESULT_DATA_URI,
              mediaType: MOCK_VTO_RESULT_MEDIA_TYPE,
              width: MOCK_VTO_RESULT_WIDTH,
              height: MOCK_VTO_RESULT_HEIGHT,
              // The mock has no real vendor billing unit; null is honest,
              // not a fabricated "1".
              billedUnits: null,
            },
          };
      }
    },
  };
}
