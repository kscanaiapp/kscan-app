import type { AvatarEngineConfig } from '../types';
import type { AvatarBreathingState, AvatarHeadMotion } from '../contract';

export interface CompositeMotionResult {
  breathing: AvatarBreathingState;
  headMotion: AvatarHeadMotion;
}

/**
 * Idle presence only — breathing and a slow head drift.
 *
 * This is the one channel that legitimately uses host wall-clock time rather
 * than playback position, because it must keep running when nothing is being
 * spoken. It is deliberately kept out of the speech path: the mouth never
 * consults `nowMs`, so idle motion and lip sync cannot drift against each other.
 */
export function deriveCompositeMotion(
  nowMs: number,
  enabled: boolean,
  config: AvatarEngineConfig,
  tapActive: boolean,
): CompositeMotionResult {
  if (!enabled || !Number.isFinite(nowMs) || nowMs < 0) return neutralComposite();
  const breathingPhase = (nowMs / config.breathingCycleMs) % 1;
  const breathing = Math.sin(breathingPhase * Math.PI * 2);
  const head = Math.sin((nowMs / config.headCycleMs) * Math.PI * 2 + 0.65);
  let rotateDeg = head * config.headTiltDegrees;
  if (tapActive) rotateDeg = Math.max(-2, Math.min(2, rotateDeg + 0.65));
  return {
    breathing: { scale: 1 + breathing * config.breathingScaleAmplitude, phase: breathingPhase },
    headMotion: { rotateDeg, translateX: 0, translateY: 0 },
  };
}

export function neutralComposite(): CompositeMotionResult {
  return {
    breathing: { scale: 1, phase: 0 },
    headMotion: { rotateDeg: 0, translateX: 0, translateY: 0 },
  };
}
