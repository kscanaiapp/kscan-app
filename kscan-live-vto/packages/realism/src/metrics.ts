/**
 * Objective metrics — Phase 3 Section 18.
 *
 * "Add metrics only where they actually correspond to a defect... Do not
 * invent quality thresholds merely to create a PASS. Record distributions
 * first." Every function here returns a measurement or a distribution, never
 * a PASS/FAIL verdict -- thresholds, if any are ever adopted, belong to a
 * human reviewer deciding after seeing real distributions, not to this file.
 */

import type { ForegroundMaskSequence, Mask } from './foregroundMask';
import { paintOrderIndex, type OcclusionLayer } from './semanticOcclusion';
import type { StabilizedMaskFrame } from './maskStability';
import { holdEpisodeLengths } from './maskStability';

export interface MaskDiff {
  /** Texels the actual mask calls foreground that the expected mask does
   *  not -- the compositor is showing body/hair where it should not be. */
  leakagePixels: number;
  /** Texels the expected mask calls foreground that the actual mask does
   *  not -- the compositor is failing to occlude where it should. */
  missedPixels: number;
  totalPixels: number;
}

/** Binarizes both masks at `threshold` and counts disagreement in each
 *  direction separately, because "too much foreground" and "too little
 *  foreground" are different defects with different visual consequences
 *  (a sticker-like garment vs. an incorrectly hidden garment) and should
 *  not be collapsed into one number. */
export function diffMasks(expected: Mask, actual: Mask, threshold = 0.5): MaskDiff {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new RangeError(
      `diffMasks: mask dimensions must match, got ${expected.width}x${expected.height} vs ${actual.width}x${actual.height}`,
    );
  }
  let leakagePixels = 0;
  let missedPixels = 0;
  for (let i = 0; i < expected.coverage.length; i += 1) {
    const e = (expected.coverage[i] ?? 0) >= threshold;
    const a = (actual.coverage[i] ?? 0) >= threshold;
    if (a && !e) leakagePixels += 1;
    if (e && !a) missedPixels += 1;
  }
  return { leakagePixels, missedPixels, totalPixels: expected.coverage.length };
}

/**
 * Counts texels where a BODY region should have won paint order (per
 * Section 10: "BODY SHOULD OCCLUDE GARMENT") but the resolved compositor
 * output instead shows GARMENT on top. `expectedLayer`/`actualLayer` are
 * per-texel `OCCLUSION_PAINT_ORDER` indices, decoupled from any concrete
 * renderer pixel format so this can be driven directly from
 * `@kscan-live-vto/static-renderer` output once wired up (see
 * `@kscan-live-vto/realism-preview`) without this package depending on it.
 *
 * Deliberately narrow: only the BODY-should-win-but-GARMENT-won case counts.
 * Other disagreements (e.g. EXISTING_CLOTHING vs BACKGROUND) are a different
 * defect class and are not this metric's job to report.
 */
export function garmentOverForegroundViolationPixels(
  expectedLayer: Uint8Array,
  actualLayer: Uint8Array,
): number {
  if (expectedLayer.length !== actualLayer.length) {
    throw new RangeError(
      `garmentOverForegroundViolationPixels: length mismatch, ${expectedLayer.length} vs ${actualLayer.length}`,
    );
  }
  const garmentIdx = paintOrderIndex('GARMENT' satisfies OcclusionLayer);
  const bodyIdx = paintOrderIndex('BODY' satisfies OcclusionLayer);
  let violations = 0;
  for (let i = 0; i < expectedLayer.length; i += 1) {
    if (expectedLayer[i] === bodyIdx && actualLayer[i] === garmentIdx) violations += 1;
  }
  return violations;
}

/**
 * Per-consecutive-frame-pair fraction of texels whose binarized coverage
 * flips — a direct proxy for visible flicker/popping. Returns the full
 * distribution (one value per adjacent pair), per Section 18's "record
 * distributions first," rather than a single summary statistic that would
 * hide whether the flips are spread evenly or concentrated in one episode.
 */
export function temporalMaskChangeRate(sequence: ForegroundMaskSequence, threshold = 0.5): number[] {
  const rates: number[] = [];
  for (let i = 1; i < sequence.length; i += 1) {
    const prev = sequence[i - 1]?.mask;
    const curr = sequence[i]?.mask;
    if (!prev || !curr) continue;
    if (prev.width !== curr.width || prev.height !== curr.height) {
      throw new RangeError('temporalMaskChangeRate: mask dimensions must match across a sequence');
    }
    let changed = 0;
    for (let p = 0; p < prev.coverage.length; p += 1) {
      const a = (prev.coverage[p] ?? 0) >= threshold;
      const b = (curr.coverage[p] ?? 0) >= threshold;
      if (a !== b) changed += 1;
    }
    rates.push(prev.coverage.length === 0 ? 0 : changed / prev.coverage.length);
  }
  return rates;
}

/** Distribution of how many consecutive frames each dropout/loss episode
 *  spent in the stabilizer's held state before trust resumed. Thin wrapper
 *  over `maskStability.holdEpisodeLengths` kept here so every Section 18
 *  metric has one home, even though the computation lives with the
 *  stabilizer it measures. */
export function maskDropRecoveryFrames(stabilized: readonly StabilizedMaskFrame[]): number[] {
  return holdEpisodeLengths(stabilized);
}

/** Small helper used by review-corpus tooling to summarize a distribution
 *  without asserting a threshold over it -- min/max/mean only. */
export function summarizeDistribution(values: readonly number[]): {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
} {
  if (values.length === 0) return { count: 0, min: null, max: null, mean: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { count: values.length, min, max, mean: sum / values.length };
}
