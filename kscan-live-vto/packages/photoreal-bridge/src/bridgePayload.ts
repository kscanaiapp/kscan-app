/**
 * Hybrid bridge payload contract — Phase 3 Section 23.
 *
 * "The Phase 3 hybrid interface may pass: an explicit captured still,
 * garment/product identifier, required provider-neutral metadata. It may
 * NOT pass continuously: live camera frames, segmentation frames, landmark
 * streams, or body proxy streams." `FORBIDDEN_BRIDGE_PAYLOAD_KEYS` is the
 * enforcement point, mirroring the existing `FORBIDDEN_EVENT_PAYLOAD_KEYS`
 * pattern in `@kscan-live-vto/contract`'s `nativeView.ts` -- same idea,
 * applied at a different boundary (the hybrid bridge to the existing
 * generative VTO, rather than the JS/native bridge).
 */

import type { GarmentDescriptor } from '@kscan-live-vto/garment-contract';
import type { ExplicitStillCapture } from './stillCapture';

/**
 * Provider-neutral commerce reference, matching the shape the existing
 * governed VTO already accepts (`VtoGarmentInput` on
 * `integration/backend-kplus-complimentary-staging-v1`) rather than
 * inventing a parallel one -- see docs/vto-phase3-hybrid-contract.md.
 */
export interface CommerceGarmentReference {
  productRef: string;
  imageUrl: string;
  category: string;
  brand: string | null;
  commerceSource: string | null;
}

/**
 * `GarmentDescriptor` (this program's local rendering contract) and
 * `VtoGarmentInput` (the existing governed VTO's contract) are different
 * vocabularies with a real gap, not just a rename: `GarmentDescriptor` has
 * no remote image URL, brand, or commerce-source field at all, because
 * nothing in the static-renderer's synthetic fixtures ever carried commerce
 * provenance (see `docs/vto-integration-candidate.md`'s own mapping table).
 * This function makes that gap a compile-time requirement rather than a
 * silently-invented default: a caller MUST supply `imageUrl`/`brand`/
 * `commerceSource` from the original commerce record, because there is no
 * way to derive them from `GarmentDescriptor` alone.
 */
export function commerceReferenceFromGarmentDescriptor(
  descriptor: Pick<GarmentDescriptor, 'productId' | 'category'>,
  commerceFields: { imageUrl: string; brand: string | null; commerceSource: string | null },
): CommerceGarmentReference {
  return {
    productRef: descriptor.productId,
    imageUrl: commerceFields.imageUrl,
    category: descriptor.category,
    brand: commerceFields.brand,
    commerceSource: commerceFields.commerceSource,
  };
}

export interface PhotorealBridgePayload {
  capture: ExplicitStillCapture;
  garment: CommerceGarmentReference;
  /** Echoes the existing VtoOrigin vocabulary as a plain string (this
   *  package does not depend on the production `types/vto.ts`, per Section
   *  25); Phase 3 introduces no new origin value. */
  origin: string;
  requestId: string;
}

/** Every field name this program has ever used for a per-frame, per-mask,
 *  or per-landmark LIVE stream, collected in one place so a payload can be
 *  checked against all of them at once. Deliberately broader than the
 *  existing `FORBIDDEN_EVENT_PAYLOAD_KEYS` list (which only needs to cover
 *  the JS/native bridge's own vocabulary): this one also covers this
 *  program's own naming (`*Stream` suffixes) for a payload shape that does
 *  not exist yet and could be named differently by a future change. */
export const FORBIDDEN_BRIDGE_PAYLOAD_KEYS = [
  'frame',
  'frames',
  'liveFrame',
  'cameraFrame',
  'cameraStream',
  'pixels',
  'imageData',
  'mask',
  'segmentationMask',
  'segmentationStream',
  'landmarks',
  'landmarkStream',
  'bodyFrame',
  'bodyFrameStream',
  'bodyProxy',
  'bodyProxyStream',
  'pose',
  'poseStream',
] as const;
export type ForbiddenBridgePayloadKey = (typeof FORBIDDEN_BRIDGE_PAYLOAD_KEYS)[number];

function collectKeysDeep(value: unknown, seen: Set<unknown>): string[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const keys: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    keys.push(key);
    keys.push(...collectKeysDeep(nested, seen));
  }
  return keys;
}

/**
 * Walks a payload's own key names (not values -- a key named `mask` is
 * forbidden regardless of what it holds) at every nesting depth and throws
 * if any forbidden key is present. Intended for use both as a runtime guard
 * before any bridge send, and as the assertion a contract test drives with
 * a deliberately poisoned payload to prove the guard actually catches
 * something (see `__tests__/bridgePayload.test.ts`).
 */
export function assertNoLiveStreamFields(payload: unknown): void {
  const keys = collectKeysDeep(payload, new Set());
  const forbidden = keys.filter((key) => (FORBIDDEN_BRIDGE_PAYLOAD_KEYS as readonly string[]).includes(key));
  if (forbidden.length > 0) {
    throw new RangeError(`PhotorealBridgePayload carries forbidden live-stream field(s): ${forbidden.join(', ')}`);
  }
}
