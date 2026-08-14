import type { AvatarMouthState } from './avatarSpeechMotion';
import type { AvatarMotionState } from './avatarMotionState';

// Renderer adapter boundary.
//
// A renderer receives finished motion states and paints them; it never owns
// timers, the state machine, speech timing, or provider decisions. Anything
// that can be computed without react-native lives here so the mapping is
// directly testable and reusable by future renderers (round mouth, blink,
// brows, gaze) without controller changes.

export interface AvatarMotionRenderer {
  applyFacialMotion(state: AvatarMotionState): void;
  resetFacialMotion(): void;
}

export interface MouthStateSourcesLike {
  closed?: number | null;
  halfOpen?: number | null;
  open?: number | null;
  round?: number | null;
}

/**
 * Asset fallback chain: a missing richer state degrades stepwise toward
 * closed (round → open → half-open → closed) and never blocks rendering.
 */
export function resolveMouthStateSource(
  sources: MouthStateSourcesLike,
  target: AvatarMouthState,
): number | null {
  if (target === 'closed') return sources.closed ?? null;
  if (target === 'halfOpen') return sources.halfOpen ?? sources.closed ?? null;
  if (target === 'open') return sources.open ?? sources.halfOpen ?? sources.closed ?? null;
  if (target === 'round') {
    return sources.round ?? sources.open ?? sources.halfOpen ?? sources.closed ?? null;
  }
  return null;
}

/**
 * The rigid-composite transform for the current motion state. Head roll maps
 * to a whole-composite rotation and breathing to a whole-composite scale, so
 * the base portrait, the mouth overlay, and every future facial layer move
 * as one unit and can never drift apart.
 */
export interface CompositeTransformSpec {
  rotateDeg: number;
  scale: number;
}

export function computeCompositeTransform(state: AvatarMotionState): CompositeTransformSpec {
  return {
    rotateDeg: state.head.rollDeg,
    scale: state.breathingScale,
  };
}

/** Neutral transform used for reset and for every degraded/static path. */
export const NEUTRAL_COMPOSITE_TRANSFORM: CompositeTransformSpec = Object.freeze({
  rotateDeg: 0,
  scale: 1,
});
