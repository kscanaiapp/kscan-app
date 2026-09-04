/**
 * Explicit still capture — Phase 3 Sections 21, 23.
 *
 * "There must be no automatic live-frame upload." `ExplicitStillCapture`
 * can only be constructed through `buildExplicitStillCapture`, and that
 * function refuses to produce one unless `userConfirmed` is literally
 * `true` -- there is no path that fabricates confirmation from a default or
 * a truthy-ish value. This mirrors the existing governed VTO's own person-
 * input contract (`VtoPersonInput.sanitizedUri` on
 * `integration/backend-kplus-complimentary-staging-v1`): a local file
 * handle, never raw pixel bytes, never a live buffer.
 */

export interface ExplicitStillCapture {
  captureId: string;
  /** Literal-typed so a caller cannot construct this shape by hand with a
   *  different string and have it type-check as an ExplicitStillCapture. */
  capturedAtState: 'STILL_CAPTURED';
  /** Always `true` in a value that reached this type -- see
   *  `buildExplicitStillCapture`, the only constructor. */
  userConfirmed: true;
  /** Local-only handle to the captured pixel data (e.g. a cache file URI),
   *  never the raw bytes/pixels themselves. */
  localUri: string;
  width: number | null;
  height: number | null;
}

export const STILL_CAPTURE_FAILURE_REASONS = ['capture_cancelled', 'no_usable_still'] as const;
export type StillCaptureFailureReason = (typeof STILL_CAPTURE_FAILURE_REASONS)[number];

export type StillCaptureOutcome =
  | { ok: true; capture: ExplicitStillCapture }
  | { ok: false; reason: StillCaptureFailureReason };

export interface StillCaptureRequest {
  captureId: string;
  /** Must be exactly `true` for a capture to be produced. Typed as `boolean`
   *  (not `true`) deliberately: this is the one place in the contract where
   *  an untrusted/upstream value (e.g. from a UI event) is checked, not
   *  assumed. */
  userConfirmed: boolean;
  localUri: string | null;
  width?: number | null;
  height?: number | null;
}

/**
 * The only way to construct an `ExplicitStillCapture`. Cancellation
 * (`userConfirmed !== true`) and a missing/failed capture (`localUri` falsy)
 * are both ordinary outcomes, not thrown errors -- consistent with the
 * existing governed VTO's own `pickVtoPersonInput`, where cancellation is a
 * no-op outcome rather than an error state.
 */
export function buildExplicitStillCapture(request: StillCaptureRequest): StillCaptureOutcome {
  if (request.userConfirmed !== true) return { ok: false, reason: 'capture_cancelled' };
  if (!request.localUri) return { ok: false, reason: 'no_usable_still' };
  return {
    ok: true,
    capture: {
      captureId: request.captureId,
      capturedAtState: 'STILL_CAPTURED',
      userConfirmed: true,
      localUri: request.localUri,
      width: request.width ?? null,
      height: request.height ?? null,
    },
  };
}
