// K+ Packing Intelligence V1 — Edge transport and wire validation.
//
// THE WIRE IS UNTRUSTED. Everything below re-validates the response before it
// becomes state, the same discipline edgeStyleChatProvider applies to weather
// context and advice metadata: what arrives is whatever the network produced,
// not necessarily what the server sent, and a screen that renders an unchecked
// payload is a screen that can render nonsense.
//
// The client never decides ownership. It receives a plan whose items the server
// already resolved against the traveller's own Closet rows, and its only
// addition is the local photograph matched by `clientId`.

import { supabase } from '../supabaseClient';
import { PACKING_REQUEST_SCHEMA_VERSION, type PackingResult, type PackingTripDraft } from '../../types/packing';
import { parsePackingResponse } from './packingResponse';
import {
  GEMINI_CONSENT_REQUIRED_CODE,
  GEMINI_CONSENT_REQUIRED_MESSAGE,
  isGeminiConsentDenial,
} from '../geminiConsentDenial';
export { parsePackingPlan, parseGeneralGuide, parsePackingResponse } from './packingResponse';

const EDGE_FN = 'stylechat-generate';

/**
 * Longer than the chat timeout: the backend's own provider budget is 20s, and a
 * client timeout below that would abandon a generation the user has already
 * paid a quota unit for.
 */
const PACKING_TIMEOUT_MS = 30_000;

export interface PackingRequestInput {
  sessionId: string;
  trip: PackingTripDraft;
  constraints?: {
    excludeItemIds?: string[];
    packLight?: boolean;
    notes?: string[];
  };
}

/**
 * supabase-js returns a non-2xx Edge response as FunctionsHttpError whose
 * `context` is the fetch Response. Its body can be read once, so it is read
 * here exactly once; a consumed or non-JSON body yields null.
 */
async function readHttpErrorBody(error: unknown): Promise<{ status: number; body: unknown } | null> {
  try {
    const context = (error as { context?: unknown })?.context as
      | { status?: unknown; json?: () => Promise<unknown> }
      | undefined;
    if (!context || typeof context.status !== 'number' || typeof context.json !== 'function') return null;
    return { status: context.status, body: await context.json() };
  } catch {
    return null;
  }
}

/**
 * The Packing handler answers a lapsed K+ (403) and a failed usage check (500)
 * with its own versioned envelope. That envelope explains the real cause and
 * goes through the same validator as a 200; anything else stays a transport
 * failure.
 */
function isPackingEnvelope(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as Record<string, unknown>).contractVersion === 'string'
    && typeof (body as Record<string, unknown>).message === 'string';
}

export async function requestPackingPlan(input: PackingRequestInput): Promise<PackingResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PACKING_TIMEOUT_MS);

  try {
    const { data, error } = await supabase.functions.invoke(EDGE_FN, {
      body: {
        schemaVersion: PACKING_REQUEST_SCHEMA_VERSION,
        sessionId: input.sessionId,
        trip: {
          destination: input.trip.destination,
          startDate: input.trip.startDate,
          endDate: input.trip.endDate,
          tripType: input.trip.tripType,
          activities: input.trip.activities,
          ...(input.trip.note.trim() ? { note: input.trip.note.trim() } : {}),
        },
        ...(input.constraints ? { constraints: input.constraints } : {}),
      },
      signal: controller.signal,
    });

    if (error) {
      // supabase-js reports our own abort as a returned fetch error, not a throw.
      if (controller.signal.aborted) return timeoutResult();
      const http = await readHttpErrorBody(error);
      if (http && isGeminiConsentDenial(http.status, http.body)) {
        // A user-controlled setting, not a connection problem: retrying cannot help.
        return {
          status: 'error',
          message: GEMINI_CONSENT_REQUIRED_MESSAGE,
          plan: null,
          generalGuide: null,
          errorCode: GEMINI_CONSENT_REQUIRED_CODE,
          retryable: false,
        };
      }
      if (http && isPackingEnvelope(http.body)) return parsePackingResponse(http.body);
      return {
        status: 'error',
        message: 'I could not reach K Scan to build your plan. Check your connection and try again.',
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_TRANSPORT_ERROR',
        retryable: true,
      };
    }

    return parsePackingResponse(data);
  } catch {
    return timeoutResult();
  } finally {
    clearTimeout(timeoutId);
  }
}

function timeoutResult(): PackingResult {
  return {
    status: 'error',
    message: 'Building your plan took too long. Your trip details are still here — try again.',
    plan: null,
    generalGuide: null,
    errorCode: 'PACKING_TIMEOUT',
    retryable: true,
  };
}
