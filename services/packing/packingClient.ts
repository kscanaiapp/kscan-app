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
    return {
      status: 'error',
      message: 'Building your plan took too long. Your trip details are still here — try again.',
      plan: null,
      generalGuide: null,
      errorCode: 'PACKING_TIMEOUT',
      retryable: true,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
