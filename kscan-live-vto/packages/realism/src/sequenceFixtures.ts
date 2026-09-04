/**
 * Deterministic temporal fixtures — Phase 3 Section 8.
 *
 * "Build deterministic sequence tests for: stable foreground; arm crossing;
 * arm raising; tracking loss; mask dropout; temporary confidence
 * reduction." Every sequence here is authored arithmetic, not sampled from
 * any model or device -- every frame carries provenance PRECOMPUTED, never
 * REAL_MODEL or NATIVE_REPLAY (see foregroundMask.ts's header). Coordinates
 * are an abstract coarse grid, not a claim about real body proportions —
 * SYNTHETIC, MECHANICS EVIDENCE ONLY, matching the honesty convention
 * already established by `@kscan-live-vto/static-renderer`'s own fixtures.
 */

import {
  createMask,
  fillRect,
  type ForegroundMaskFrame,
  type ForegroundMaskSequence,
} from './foregroundMask';
import type { SemanticMaskFrame, SemanticRegion, SemanticScene } from './semanticOcclusion';
import { PRECOMPUTED_SEMANTIC_MASK_LABEL } from './semanticOcclusion';

/** Shared frame size for every fixture in this module: small enough for
 *  fast deterministic tests, large enough that a rectangle's edges are
 *  unambiguous. Not a claim about any real capture resolution. */
export const FIXTURE_WIDTH = 40;
export const FIXTURE_HEIGHT = 60;

/** Arbitrary sequence-step spacing, in ms. Not a claimed device cadence —
 *  Section 9 explicitly forbids inventing one; these are just evenly
 *  spaced ordinal steps so `assertValidSequence`'s strictly-increasing
 *  timestamp rule is satisfied. */
const STEP_MS = 100;

function frame(
  index: number,
  build: (mask: ReturnType<typeof createMask>) => void,
  confidence: number,
): ForegroundMaskFrame {
  const mask = createMask(FIXTURE_WIDTH, FIXTURE_HEIGHT, 0);
  build(mask);
  return { timestamp: index * STEP_MS, mask, confidence, provenance: 'PRECOMPUTED' };
}

/** The torso rectangle every sequence in this module treats as "the
 *  garment region" — a fixed reference so per-sequence differences are
 *  legible. */
const TORSO_RECT = { x: 12, y: 14, w: 16, h: 34 };

function torsoOnly(mask: ReturnType<typeof createMask>): void {
  fillRect(mask, TORSO_RECT, 1);
}

// ─── Section 8 required sequences ──────────────────────────────────────────

/** Foreground geometry and confidence both constant. The control case: a
 *  stabilizer must pass every frame through unchanged. */
export function stableForegroundSequence(frameCount = 8): ForegroundMaskSequence {
  return Array.from({ length: frameCount }, (_, i) => frame(i, torsoOnly, 0.92));
}

/** A forearm rectangle sweeps left-to-right across the torso, ending
 *  overlapping its centre. Confidence stays high throughout — occlusion by
 *  a crossing arm is not, by itself, a tracking-confidence problem. */
export function armCrossingSequence(frameCount = 10): ForegroundMaskSequence {
  return Array.from({ length: frameCount }, (_, i) => {
    const t = i / (frameCount - 1);
    const armX = -6 + t * 34; // sweeps from off the left edge to off the right edge
    return frame(
      i,
      (mask) => {
        torsoOnly(mask);
        fillRect(mask, { x: armX, y: 24, w: 8, h: 6 }, 1);
      },
      0.9,
    );
  });
}

/** A forearm rectangle starts beside the torso at mid-height and moves
 *  upward past the shoulder line into a raised position. Geometry changes
 *  continuously; nothing drops out. */
export function armRaisingSequence(frameCount = 10): ForegroundMaskSequence {
  return Array.from({ length: frameCount }, (_, i) => {
    const t = i / (frameCount - 1);
    const armY = 30 - t * 26; // moves from beside the torso up above the shoulder line
    return frame(
      i,
      (mask) => {
        torsoOnly(mask);
        fillRect(mask, { x: 28, y: armY, w: 7, h: 6 }, 1);
      },
      0.88,
    );
  });
}

/** Stable, then a sustained loss (near-zero coverage, low confidence) for
 *  several frames, then exact reacquisition of the original geometry. This
 *  is the "arm crossing detector accidentally decides the whole subject is
 *  gone" class of failure, authored directly rather than waited for. */
export function trackingLossSequence(
  stableFrames = 3,
  lossFrames = 4,
  recoveredFrames = 3,
): ForegroundMaskSequence {
  const frames: ForegroundMaskFrame[] = [];
  let i = 0;
  for (let k = 0; k < stableFrames; k += 1, i += 1) frames.push(frame(i, torsoOnly, 0.9));
  for (let k = 0; k < lossFrames; k += 1, i += 1) frames.push(frame(i, () => {}, 0.08));
  for (let k = 0; k < recoveredFrames; k += 1, i += 1) frames.push(frame(i, torsoOnly, 0.9));
  return frames;
}

/** Like tracking loss, but much shorter: a single corrupted frame (or a
 *  couple) surrounded by otherwise-good frames — the specific case Section
 *  9 calls "avoid single-frame edge popping," isolated from sustained loss
 *  so the two failure modes can be tested independently. */
export function maskDropoutSequence(
  goodFramesBefore = 4,
  dropoutFrames = 1,
  goodFramesAfter = 4,
): ForegroundMaskSequence {
  const frames: ForegroundMaskFrame[] = [];
  let i = 0;
  for (let k = 0; k < goodFramesBefore; k += 1, i += 1) frames.push(frame(i, torsoOnly, 0.9));
  for (let k = 0; k < dropoutFrames; k += 1, i += 1) frames.push(frame(i, () => {}, 0.0));
  for (let k = 0; k < goodFramesAfter; k += 1, i += 1) frames.push(frame(i, torsoOnly, 0.9));
  return frames;
}

/** Geometry never changes; only confidence dips (e.g. a lighting flicker
 *  the perception source is unsure about) and recovers. Isolates
 *  confidence-driven hysteresis from any geometric change. */
export function confidenceReductionSequence(
  highFrames = 3,
  lowFrames = 3,
  recoveredFrames = 3,
  lowConfidence = 0.4,
): ForegroundMaskSequence {
  const frames: ForegroundMaskFrame[] = [];
  let i = 0;
  for (let k = 0; k < highFrames; k += 1, i += 1) frames.push(frame(i, torsoOnly, 0.9));
  for (let k = 0; k < lowFrames; k += 1, i += 1) frames.push(frame(i, torsoOnly, lowConfidence));
  for (let k = 0; k < recoveredFrames; k += 1, i += 1) frames.push(frame(i, torsoOnly, 0.9));
  return frames;
}

export const TEMPORAL_SEQUENCE_FIXTURES = {
  stableForeground: stableForegroundSequence,
  armCrossing: armCrossingSequence,
  armRaising: armRaisingSequence,
  trackingLoss: trackingLossSequence,
  maskDropout: maskDropoutSequence,
  confidenceReduction: confidenceReductionSequence,
} as const;

// ─── Section 10 adverse semantic fixtures ──────────────────────────────────

function semanticFrame(
  region: SemanticRegion,
  build: (mask: ReturnType<typeof createMask>) => void,
  confidence: number,
): SemanticMaskFrame {
  const mask = createMask(FIXTURE_WIDTH, FIXTURE_HEIGHT, 0);
  build(mask);
  return {
    region,
    frame: { timestamp: 0, mask, confidence, provenance: 'PRECOMPUTED' },
    label: PRECOMPUTED_SEMANTIC_MASK_LABEL,
  };
}

/** One forearm crossing the chest at mid-torso height. */
export function oneForearmCrossingChestScene(): SemanticScene {
  return {
    forearm_hand: semanticFrame('forearm_hand', (m) => fillRect(m, { x: 10, y: 26, w: 20, h: 6 }, 1), 0.9),
  };
}

/** Both forearms crossing, one above the other, spanning most of the chest
 *  width — the harder case named explicitly in Section 10. */
export function bothForearmsCrossingScene(): SemanticScene {
  return {
    forearm_hand: semanticFrame(
      'forearm_hand',
      (m) => {
        fillRect(m, { x: 8, y: 22, w: 24, h: 5 }, 1);
        fillRect(m, { x: 8, y: 30, w: 24, h: 5 }, 1);
      },
      0.85,
    ),
    upper_arm: semanticFrame(
      'upper_arm',
      (m) => {
        fillRect(m, { x: 4, y: 18, w: 6, h: 20 }, 1);
        fillRect(m, { x: 30, y: 18, w: 6, h: 20 }, 1);
      },
      0.85,
    ),
  };
}

/** A hand resting near the neckline — the case Section 10 calls out
 *  separately from a general forearm crossing because it interacts with
 *  the collar region a Phase 3 contact-shadow layer also touches. */
export function handNearNecklineScene(): SemanticScene {
  return {
    forearm_hand: semanticFrame('forearm_hand', (m) => fillRect(m, { x: 16, y: 10, w: 8, h: 8 }, 1), 0.87),
  };
}

/** Long hair draped forward over one shoulder, in front of the garment. */
export function longHairOverShoulderScene(): SemanticScene {
  return {
    hair: semanticFrame(
      'hair',
      (m) => {
        fillRect(m, { x: 6, y: 2, w: 8, h: 12 }, 1); // head/hair mass
        fillRect(m, { x: 8, y: 12, w: 6, h: 16 }, 1); // strand falling over the shoulder onto the torso
      },
      0.8,
    ),
  };
}

/** Hair swept behind the shoulder — the complementary case: hair present
 *  but NOT expected to occlude the garment at torso level, so a
 *  regression here would show up as an unwanted foreground patch. */
export function hairBehindShoulderScene(): SemanticScene {
  return {
    hair: semanticFrame('hair', (m) => fillRect(m, { x: 6, y: 2, w: 8, h: 12 }, 1), 0.8),
  };
}

/** Partial segmentation failure: the hair region's own confidence collapses
 *  mid-scene while the rest of the frame (not modelled here) is fine — the
 *  specific "one region drops out, not the whole mask" failure Section 10
 *  asks to be tested separately from full tracking loss. */
export function partialSegmentationFailureScene(): SemanticScene {
  return {
    hair: semanticFrame('hair', (m) => fillRect(m, { x: 6, y: 2, w: 8, h: 12 }, 0.5), 0.15),
    forearm_hand: semanticFrame('forearm_hand', (m) => fillRect(m, { x: 10, y: 26, w: 20, h: 6 }, 1), 0.9),
  };
}

export const ADVERSE_SEMANTIC_SCENES = {
  oneForearmCrossingChest: oneForearmCrossingChestScene,
  bothForearmsCrossing: bothForearmsCrossingScene,
  handNearNeckline: handNearNecklineScene,
  longHairOverShoulder: longHairOverShoulderScene,
  hairBehindShoulder: hairBehindShoulderScene,
  partialSegmentationFailure: partialSegmentationFailureScene,
} as const;
