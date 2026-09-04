/**
 * Temporal segmentation contract — Phase 3 Section 8.
 *
 * "The renderer must support a stream abstraction" over foreground masks,
 * and "no code may label a precomputed mask as real segmentation." This
 * module is the enforcement point for both: `ForegroundMaskFrame` is the
 * one shape a temporal mask source produces, and `ForegroundMaskProvenance`
 * is a closed union nothing downstream can widen or fake.
 *
 * Named `ForegroundMaskProvenance` rather than `MaskProvenance` on purpose:
 * `@kscan-live-vto/static-renderer` already exports a `MaskProvenance` type
 * (`'precomputed' | 'generated' | 'none'`) describing a single render call's
 * input. That is a different, coarser vocabulary answering a different
 * question ("should this one render trust its mask input"); this one
 * describes a per-frame *stream's* origin ("what produced this frame").
 * `toRendererMaskProvenance` below is the documented bridge between them.
 */

export const FOREGROUND_MASK_PROVENANCES = ['REAL_MODEL', 'NATIVE_REPLAY', 'PRECOMPUTED'] as const;
export type ForegroundMaskProvenance = (typeof FOREGROUND_MASK_PROVENANCES)[number];

/**
 * A single-channel coverage raster, one value per texel in [0,1] (1 = fully
 * foreground), row-major, top-left origin. Deliberately NOT
 * static-renderer's `RgbaImage`: this is the input contract a perception
 * source produces, before any compositing or color decision happens.
 */
export interface Mask {
  width: number;
  height: number;
  /** length === width * height. */
  coverage: Float64Array;
}

export interface ForegroundMaskFrame {
  /** Monotonic, sequence-relative ms. Not wall-clock: fixtures built from
   *  this contract must be deterministic and must never depend on
   *  Date.now(). */
  timestamp: number;
  mask: Mask;
  /** [0,1]. 1 = fully confident. A PRECOMPUTED mask may still carry a
   *  non-1 confidence value -- a fixture author simulating a low-confidence
   *  frame sets it explicitly; it is not implicitly trusted just because it
   *  was authored. */
  confidence: number;
  provenance: ForegroundMaskProvenance;
}

export type ForegroundMaskSequence = readonly ForegroundMaskFrame[];

export function createMask(width: number, height: number, fill = 0): Mask {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`createMask: width/height must be positive integers, got ${width}x${height}`);
  }
  return { width, height, coverage: new Float64Array(width * height).fill(fill) };
}

export function maskAt(mask: Mask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  return mask.coverage[y * mask.width + x] ?? 0;
}

export function setMaskAt(mask: Mask, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return;
  mask.coverage[y * mask.width + x] = Math.max(0, Math.min(1, value));
}

/** Fills an axis-aligned rectangle to `value`. Coordinates are clamped to
 *  the mask bounds so a fixture author cannot silently write out of range. */
export function fillRect(
  mask: Mask,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(mask.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(mask.height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      setMaskAt(mask, x, y, value);
    }
  }
}

export function cloneMask(mask: Mask): Mask {
  return { width: mask.width, height: mask.height, coverage: Float64Array.from(mask.coverage) };
}

/** Sum of all coverage values -- a cheap proxy for "how much foreground is
 *  currently visible," used by tests to check decay/hold behavior without
 *  a full mask-equality comparison. */
export function totalCoverage(mask: Mask): number {
  let sum = 0;
  for (let i = 0; i < mask.coverage.length; i += 1) sum += mask.coverage[i] ?? 0;
  return sum;
}

export function masksEqual(a: Mask, b: Mask): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.coverage.length !== b.coverage.length) return false;
  for (let i = 0; i < a.coverage.length; i += 1) {
    if ((a.coverage[i] ?? 0) !== (b.coverage[i] ?? 0)) return false;
  }
  return true;
}

/** Structural validity check used at every fixture/stream boundary. Throws
 *  with a specific reason rather than returning a boolean: every call site
 *  that needs this needs to fail loudly on a bad frame, not silently
 *  continue rendering it. */
export function assertValidForegroundMaskFrame(frame: ForegroundMaskFrame): void {
  if (!Number.isFinite(frame.timestamp) || frame.timestamp < 0) {
    throw new RangeError(
      `ForegroundMaskFrame.timestamp must be a non-negative finite number, got ${frame.timestamp}`,
    );
  }
  if (!(FOREGROUND_MASK_PROVENANCES as readonly string[]).includes(frame.provenance)) {
    throw new RangeError(
      `ForegroundMaskFrame.provenance must be one of ${FOREGROUND_MASK_PROVENANCES.join(', ')}, got ${String(frame.provenance)}`,
    );
  }
  if (!Number.isFinite(frame.confidence) || frame.confidence < 0 || frame.confidence > 1) {
    throw new RangeError(`ForegroundMaskFrame.confidence must be in [0,1], got ${frame.confidence}`);
  }
  const { mask } = frame;
  if (!Number.isInteger(mask.width) || mask.width <= 0 || !Number.isInteger(mask.height) || mask.height <= 0) {
    throw new RangeError(`ForegroundMaskFrame.mask dimensions must be positive integers, got ${mask.width}x${mask.height}`);
  }
  if (mask.coverage.length !== mask.width * mask.height) {
    throw new RangeError(
      `ForegroundMaskFrame.mask.coverage length ${mask.coverage.length} does not match width*height ${mask.width * mask.height}`,
    );
  }
  for (let i = 0; i < mask.coverage.length; i += 1) {
    const v = mask.coverage[i] ?? Number.NaN;
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new RangeError(`ForegroundMaskFrame.mask.coverage[${i}] must be in [0,1], got ${v}`);
    }
  }
}

export function assertValidSequence(sequence: ForegroundMaskSequence): void {
  let last = -Infinity;
  for (const frame of sequence) {
    assertValidForegroundMaskFrame(frame);
    if (frame.timestamp <= last) {
      throw new RangeError(
        `ForegroundMaskSequence timestamps must be strictly increasing: ${frame.timestamp} follows ${last}`,
      );
    }
    last = frame.timestamp;
  }
}

/**
 * Bridge to static-renderer's coarser, single-call vocabulary.
 *
 * Every frame this program can currently produce is PRECOMPUTED (see the
 * module header) and therefore always maps to 'precomputed'. REAL_MODEL and
 * NATIVE_REPLAY are mapped for completeness and future use -- neither can be
 * exercised today because no real perception model or compiled native replay
 * path exists in this repository (docs/vto-phase3-native-blockers.md).
 * REAL_MODEL maps to 'generated' (a model ran, right now, for this render).
 * NATIVE_REPLAY maps to 'generated' too: it is genuine model output, only
 * replayed rather than freshly inferred -- the renderer's distinction is
 * "is this real segmentation evidence," not "was it computed this second,"
 * and a replay of a real capture still answers that question yes.
 */
export function toRendererMaskProvenance(
  provenance: ForegroundMaskProvenance,
): 'precomputed' | 'generated' | 'none' {
  switch (provenance) {
    case 'PRECOMPUTED':
      return 'precomputed';
    case 'REAL_MODEL':
    case 'NATIVE_REPLAY':
      return 'generated';
    default: {
      const exhaustive: never = provenance;
      throw new RangeError(`toRendererMaskProvenance: unhandled provenance ${String(exhaustive)}`);
    }
  }
}
