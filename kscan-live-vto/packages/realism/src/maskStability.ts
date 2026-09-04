/**
 * Mask temporal-stability layer — Phase 3 Section 9.
 *
 * Goals, verbatim: avoid single-frame edge popping; avoid visible
 * foreground flicker; fail safely when segmentation drops; do not create
 * large lag. Mechanics used: two-threshold confidence hysteresis (the same
 * "two thresholds, not one" shape as
 * `@kscan-live-vto/evaluation`'s `trackingStateMachine.ts`, applied here to
 * a mask stream rather than a lifecycle state), previous-valid-mask hold
 * for a bounded number of frames, gentle decay rather than an abrupt cut
 * once that budget is exceeded, and feathered (multi-frame) transition back
 * onto the live stream on recovery rather than an instantaneous snap.
 *
 * This module is algorithmic/deterministic evidence only, per Section 9's
 * own instruction not to invent device cadence targets: `MaskStabilityConfig`
 * is expressed in frame counts and confidence values, never milliseconds or
 * FPS, and its defaults are explicitly unmeasured placeholders — see
 * docs/vto-phase3-native-blockers.md.
 */

import {
  assertValidSequence,
  cloneMask,
  type ForegroundMaskSequence,
  type Mask,
} from './foregroundMask';

export interface MaskStabilityConfig {
  /** Below this confidence, an already-trusted stream stops being trusted. */
  confidenceLowThreshold: number;
  /** At or above this confidence, a distrusted stream becomes trusted again.
   *  Must be >= confidenceLowThreshold; the gap between the two is the
   *  hysteresis band that stops a confidence value hovering near one
   *  threshold from flip-flopping every frame. */
  confidenceHighThreshold: number;
  /** How many consecutive distrusted frames may hold/decay the last trusted
   *  mask before `failedSafe` is reported. Bounds "do not create large lag"
   *  from the other direction: past this budget the output is explicitly
   *  flagged as stale rather than silently held forever. */
  maxHoldFrames: number;
  /** Per-frame blend step applied while transitioning from a held mask back
   *  onto the live stream after recovery; 1 = snap immediately (no
   *  feathering), smaller = more frames spent blending. Must be in (0, 1]. */
  transitionBlendPerFrame: number;
}

/**
 * Placeholders pending real segmentation evidence, not measured against a
 * real model or device — same status as
 * `@kscan-live-vto/live-vto-contract`'s `DEFAULT_GUIDANCE_THRESHOLDS` and
 * `DEFAULT_DEVICE_CAPABILITY_THRESHOLDS`. Every field is named individually
 * so a reviewer can see and challenge each one rather than tuning an opaque
 * blob.
 */
export const DEFAULT_MASK_STABILITY_CONFIG: MaskStabilityConfig = {
  confidenceLowThreshold: 0.35,
  confidenceHighThreshold: 0.55,
  maxHoldFrames: 6,
  transitionBlendPerFrame: 0.34,
};

export interface StabilizedMaskFrame {
  timestamp: number;
  mask: Mask;
  rawConfidence: number;
  /** rawConfidence while trusted; the held/decayed confidence while not. */
  effectiveConfidence: number;
  /** This frame's own mask contributed to the output, wholly or via blend. */
  trusted: boolean;
  /** The output is wholly or partly the frozen/decaying prior mask rather
   *  than a full pass-through of this frame's own data — covers both the
   *  hold-on-distrust case and the still-blending recovery case. */
  held: boolean;
  /** Consecutive distrusted frames so far; 0 whenever trusted. */
  holdFramesUsed: number;
  /** True once holdFramesUsed has exceeded maxHoldFrames this episode. */
  failedSafe: boolean;
}

function lerpMask(a: Mask, b: Mask, t: number): Mask {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`lerpMask: mask dimensions must match, got ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const coverage = new Float64Array(a.coverage.length);
  for (let i = 0; i < coverage.length; i += 1) {
    const av = a.coverage[i] ?? 0;
    const bv = b.coverage[i] ?? 0;
    coverage[i] = av + (bv - av) * t;
  }
  return { width: a.width, height: a.height, coverage };
}

function scaleMask(mask: Mask, factor: number): Mask {
  const coverage = new Float64Array(mask.coverage.length);
  for (let i = 0; i < coverage.length; i += 1) coverage[i] = (mask.coverage[i] ?? 0) * factor;
  return { width: mask.width, height: mask.height, coverage };
}

/** Floor applied to the decay factor once maxHoldFrames is exceeded, so a
 *  persistently-lost mask fades toward faint rather than vanishing outright
 *  on the very frame the budget is exceeded — "fail safely," not "fail
 *  abruptly." */
const MIN_DECAY_FACTOR = 0.15;
const DECAY_PER_OVERSHOOT_FRAME = 0.1;

export function stabilizeSequence(
  sequence: ForegroundMaskSequence,
  config: MaskStabilityConfig = DEFAULT_MASK_STABILITY_CONFIG,
): StabilizedMaskFrame[] {
  assertValidSequence(sequence);
  if (config.confidenceHighThreshold < config.confidenceLowThreshold) {
    throw new RangeError('MaskStabilityConfig.confidenceHighThreshold must be >= confidenceLowThreshold');
  }
  if (config.transitionBlendPerFrame <= 0 || config.transitionBlendPerFrame > 1) {
    throw new RangeError('MaskStabilityConfig.transitionBlendPerFrame must be in (0, 1]');
  }
  if (!Number.isInteger(config.maxHoldFrames) || config.maxHoldFrames < 0) {
    throw new RangeError('MaskStabilityConfig.maxHoldFrames must be a non-negative integer');
  }

  const output: StabilizedMaskFrame[] = [];
  let trusting = false;
  let heldMask: Mask | null = null;
  let heldConfidence = 0;
  let holdFramesUsed = 0;
  let blendProgress = 1;
  let blendStart: Mask | null = null;

  for (const raw of sequence) {
    const wasTrusting = trusting;
    if (trusting) {
      if (raw.confidence < config.confidenceLowThreshold) trusting = false;
    } else if (raw.confidence >= config.confidenceHighThreshold) {
      trusting = true;
    }

    if (trusting) {
      if (!wasTrusting) {
        // Recovery this frame. Only start a feathered transition if there is
        // something to transition FROM; the very first ever trusted frame
        // (nothing held yet) has nothing to blend against and should just
        // start clean.
        if (heldMask) {
          blendStart = cloneMask(heldMask);
          blendProgress = 0;
        } else {
          blendStart = null;
          blendProgress = 1;
        }
      }
      blendProgress = Math.min(1, blendProgress + config.transitionBlendPerFrame);
      const outMask = blendProgress >= 1 || !blendStart ? cloneMask(raw.mask) : lerpMask(blendStart, raw.mask, blendProgress);

      heldMask = cloneMask(raw.mask);
      heldConfidence = raw.confidence;
      holdFramesUsed = 0;

      output.push({
        timestamp: raw.timestamp,
        mask: outMask,
        rawConfidence: raw.confidence,
        effectiveConfidence: raw.confidence,
        trusted: true,
        held: blendProgress < 1,
        holdFramesUsed: 0,
        failedSafe: false,
      });
      continue;
    }

    // Distrust branch.
    if (!heldMask) {
      // Nothing trustworthy has ever been seen yet -- there is nothing
      // better to fall back to than this frame's own (untrusted) geometry.
      output.push({
        timestamp: raw.timestamp,
        mask: cloneMask(raw.mask),
        rawConfidence: raw.confidence,
        effectiveConfidence: raw.confidence,
        trusted: false,
        held: false,
        holdFramesUsed: 0,
        failedSafe: false,
      });
      continue;
    }

    holdFramesUsed += 1;
    const overshoot = holdFramesUsed - config.maxHoldFrames;
    const failedSafe = overshoot > 0;
    const decay = failedSafe ? Math.max(MIN_DECAY_FACTOR, 1 - DECAY_PER_OVERSHOOT_FRAME * overshoot) : 1;
    const outMask = decay === 1 ? cloneMask(heldMask) : scaleMask(heldMask, decay);

    output.push({
      timestamp: raw.timestamp,
      mask: outMask,
      rawConfidence: raw.confidence,
      effectiveConfidence: heldConfidence * decay,
      trusted: false,
      held: true,
      holdFramesUsed,
      failedSafe,
    });
  }

  return output;
}

/** Run-length of consecutive `held === true` frames, one entry per episode
 *  (a stretch of holding bounded on both sides by fully-live frames, or by
 *  the ends of the sequence). This is the raw material for the Section 18
 *  "mask-drop recovery frames" metric — see metrics.ts. */
export function holdEpisodeLengths(stabilized: readonly Pick<StabilizedMaskFrame, 'held'>[]): number[] {
  const episodes: number[] = [];
  let current = 0;
  for (const entry of stabilized) {
    if (entry.held) {
      current += 1;
    } else if (current > 0) {
      episodes.push(current);
      current = 0;
    }
  }
  if (current > 0) episodes.push(current);
  return episodes;
}
