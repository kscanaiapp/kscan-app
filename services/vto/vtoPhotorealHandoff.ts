/**
 * Live -> Photoreal: the one bridge from a local Live session into the
 * existing governed generative path.
 *
 * WHAT IT DOES, AND DELIBERATELY DOES NOT DO. It turns an explicitly captured
 * clean person frame into the SAME `VtoPersonInput` the photo picker
 * produces, and hands it to the SAME store, the SAME client, and the SAME
 * `vto-generate` Edge Function. It contains no provider call, no endpoint, no
 * credential, and no alternative request shape -- there is nothing here for a
 * bypass to be built out of. Authentication, K+ entitlement, eligibility,
 * quota, reservation, idempotency, provider selection, SSRF/media safety and
 * result validation all remain exactly where they are, server-side, unchanged
 * by this lane.
 *
 * THREE REFUSALS, IN ORDER:
 *
 *   1. NOT A PERSON FRAME. `assertCleanPersonFrame` rejects a PREVIEW handle.
 *      This is the clean-frame rule and it is enforced by the capture's own
 *      declared kind -- never by inspecting the image. A dimension comparison
 *      or a "does this look composited" heuristic would be both defeatable and
 *      wrong, and none exists anywhere in this integration.
 *   2. HARNESS ACTIVE. A simulated Live session may not spend a real
 *      generation, a real quota attempt, or real money. The dev harness is
 *      provider-inert and this is where that is enforced.
 *   3. SANITIZER REFUSED. The frame goes through the same metadata-stripping
 *      re-encode as a picked photo, and if the sanitizer reports it did not
 *      strip metadata, the image does not leave the device.
 *
 * A FAILURE NEVER ENDS THE LIVE SESSION. Every outcome below returns
 * `liveSessionRemainsUsable: true` through the single shared handler -- there
 * is no per-code branch that could quietly make one failure fatal.
 */

import {
  cleanupSanitizedImage,
  prepareImageForPrivacyUpload,
} from '../privacyImageUpload';
import { isLiveVtoHarnessActive } from './vtoLiveHarness';
import {
  VTO_PERSON_JPEG_QUALITY,
  VTO_PERSON_MAX_DIMENSION,
} from './vtoPersonInput';
import {
  assertCleanPersonFrame,
  handlePhotorealFailure,
  type LiveVtoCapturedFrame,
  type PhotorealFailureOutcome,
} from '../../types/vtoLive';
import type { VtoPersonInput } from '../../types/vto';

export type PhotorealHandoffOutcome =
  | { ok: true; person: VtoPersonInput }
  | { ok: false; failure: PhotorealFailureOutcome };

/**
 * Produces the generative person input for an explicit Photoreal request.
 *
 * The caller then drives the ORDINARY generative flow with it
 * (`setVtoPersonInput` -> `startVtoGeneration`), which is what keeps Live's
 * path through the backend identical to AI Photo's rather than parallel to it.
 */
export async function buildPhotorealPersonInput(
  frame: LiveVtoCapturedFrame,
  deps?: {
    prepare?: typeof prepareImageForPrivacyUpload;
    harnessActive?: () => boolean;
  },
): Promise<PhotorealHandoffOutcome> {
  const harnessActive = deps?.harnessActive ?? isLiveVtoHarnessActive;
  const prepare = deps?.prepare ?? prepareImageForPrivacyUpload;

  try {
    assertCleanPersonFrame(frame);
  } catch {
    return { ok: false, failure: handlePhotorealFailure('no_usable_still') };
  }

  if (harnessActive()) {
    return { ok: false, failure: handlePhotorealFailure('harness_active') };
  }

  if (typeof frame.localUri !== 'string' || !frame.localUri.trim()) {
    return { ok: false, failure: handlePhotorealFailure('no_usable_still') };
  }

  try {
    const prepared = await prepare(frame.localUri, {
      maxDimension: VTO_PERSON_MAX_DIMENSION,
      quality: VTO_PERSON_JPEG_QUALITY,
    });
    if (!prepared.policy.metadataStripped) {
      await cleanupSanitizedImage(prepared.sanitizedUri);
      return { ok: false, failure: handlePhotorealFailure('no_usable_still') };
    }
    return {
      ok: true,
      person: {
        source: 'live_capture',
        sanitizedUri: prepared.sanitizedUri,
        width: prepared.width ?? null,
        height: prepared.height ?? null,
        metadataStripped: true,
        sanitizerVersion: prepared.policy.sanitizerVersion,
      },
    };
  } catch {
    return { ok: false, failure: handlePhotorealFailure('no_usable_still') };
  }
}

/**
 * Maps a generative failure back into a Photoreal outcome.
 *
 * Exists so a caller never has to decide for itself whether a given backend
 * failure should end the Live session -- the answer is always no, and routing
 * every code through the shared handler is what makes that structural.
 */
export function photorealOutcomeForGenerativeFailure(
  code: string | null | undefined,
): PhotorealFailureOutcome {
  switch (code) {
    case 'feature_disabled':
      return handlePhotorealFailure('feature_disabled');
    case 'entitlement_required':
      return handlePhotorealFailure('entitlement_missing');
    case 'unsupported_category':
      return handlePhotorealFailure('garment_not_eligible');
    case 'provider_unavailable':
    case 'provider_timeout':
    case 'rate_limited':
      return handlePhotorealFailure('provider_unavailable');
    case 'cancelled':
      return handlePhotorealFailure('capture_cancelled');
    default:
      return handlePhotorealFailure('generation_failed');
  }
}
