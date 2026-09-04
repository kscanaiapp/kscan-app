/**
 * Provider-neutral bridge adapter — Phase 3 Section 24. TEST ONLY.
 *
 * Transforms a Phase 3 `PhotorealBridgePayload` into the exact request
 * shape `services/vto/vtoClient.ts#requestVtoGeneration` sends to the
 * existing governed `vto-generate` Edge Function -- verified directly
 * against source on `integration/backend-kplus-complimentary-staging-v1` @
 * f5ff48c8f764ab3158d1385ea2518e58265f3456 (see
 * docs/vto-phase3-hybrid-contract.md for the full read-only inventory this
 * shape was checked against).
 *
 * This module builds a request object. It does NOT send one: there is no
 * `fetch`, `XMLHttpRequest`, `supabase`, or any transport import anywhere in
 * this file, which `__tests__/mockBridgeAdapter.test.ts` checks mechanically
 * against this file's own source text -- the same static source-audit
 * pattern already used for the native scaffold in
 * docs/vto-native-device-handoff.md. This module must never be pointed at
 * staging or production; it has no way to, since it contains no transport
 * code at all.
 */

import { assertNoLiveStreamFields, type PhotorealBridgePayload } from './bridgePayload';

/** Mirrors `services/vto/vtoClient.ts`'s `VtoGenerateArgs` -> request body
 *  shape field-for-field (requestId, origin, person.dataUri, garment.*,
 *  optional requestGeneration/devScenario). */
export interface VtoGenerateRequestShape {
  requestId: string;
  origin: string;
  person: { dataUri: string };
  garment: {
    productRef: string;
    imageUrl: string;
    category: string;
    brand: string | null;
    commerceSource: string | null;
  };
  requestGeneration?: string;
  devScenario?: string;
}

/**
 * A deterministic, tiny, local fixture data URI (a 1x1 transparent PNG)
 * standing in for a real sanitized person photo. Real captured bytes never
 * flow through this test-only adapter -- `buildVtoGenerateRequestFromCapture`
 * reads `capture.localUri` only to confirm one was provided; it never opens
 * or transmits the file it points to.
 */
export const MOCK_PERSON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export type MockBridgeAdapterOutcome =
  | { ok: true; request: VtoGenerateRequestShape }
  | { ok: false; reason: 'bridge_contract_mismatch' };

/**
 * Builds the request object the existing governed VTO would receive, from a
 * Phase 3 payload. Refuses (rather than fabricates a value) if the capture
 * has no local URI to point to -- the one input this contract cannot
 * proceed without.
 */
export function buildVtoGenerateRequestFromCapture(payload: PhotorealBridgePayload): MockBridgeAdapterOutcome {
  assertNoLiveStreamFields(payload);
  if (!payload.capture.localUri) {
    return { ok: false, reason: 'bridge_contract_mismatch' };
  }
  return {
    ok: true,
    request: {
      requestId: payload.requestId,
      origin: payload.origin,
      person: { dataUri: MOCK_PERSON_DATA_URI },
      garment: {
        productRef: payload.garment.productRef,
        imageUrl: payload.garment.imageUrl,
        category: payload.garment.category,
        brand: payload.garment.brand,
        commerceSource: payload.garment.commerceSource,
      },
    },
  };
}
