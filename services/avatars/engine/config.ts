import type { AvatarEngineConfig } from './types';

/**
 * Defaults are inherited from the V9 candidate so shadow-mode comparisons
 * measure the integration, not a simultaneous retune. The one deliberate
 * change is that anti-pop attack is now expressed in PLAYBACK milliseconds
 * (`speechAttackPlaybackMs`) rather than wall-clock milliseconds.
 */
export const DEFAULT_AVATAR_ENGINE_CONFIG: Readonly<AvatarEngineConfig> = Object.freeze({
  speechAttackPlaybackMs: 50,
  transitionMs: 90,
  pauseThresholdMs: 160,
  microGapMergeMs: 24,
  noiseIntervalMs: 28,
  minVisibleHoldMs: 90,
  fallbackCycleMs: 360,
  breathingCycleMs: 5200,
  breathingScaleAmplitude: 0.006,
  headCycleMs: 9800,
  headTiltDegrees: 0.8,
  blinkMinIntervalMs: 2800,
  blinkMaxIntervalMs: 6200,
  blinkClosedMs: 120,
  blinkDoubleChance: 0.12,
  blinkDoubleGapMs: 145,
  tapCooldownMs: 2500,
  tapReactionMs: 360,
  gazeMaxX: 0.045,
  gazeMaxY: 0.035,
  blinkDuringSpeech: false,
});

export function normalizeEngineConfig(config?: Partial<AvatarEngineConfig>): AvatarEngineConfig {
  const d = DEFAULT_AVATAR_ENGINE_CONFIG;
  const c = config ?? {};
  return {
    speechAttackPlaybackMs: finiteRange(c.speechAttackPlaybackMs, d.speechAttackPlaybackMs, 0, 250),
    transitionMs: finiteRange(c.transitionMs, d.transitionMs, 0, 300),
    pauseThresholdMs: finiteRange(c.pauseThresholdMs, d.pauseThresholdMs, 40, 1000),
    microGapMergeMs: finiteRange(c.microGapMergeMs, d.microGapMergeMs, 0, 100),
    noiseIntervalMs: finiteRange(c.noiseIntervalMs, d.noiseIntervalMs, 0, 80),
    // 0 disables the hold entirely, which is what the pre-Build-34 behaviour was.
    minVisibleHoldMs: finiteRange(c.minVisibleHoldMs, d.minVisibleHoldMs, 0, 260),
    fallbackCycleMs: finiteRange(c.fallbackCycleMs, d.fallbackCycleMs, 180, 1200),
    breathingCycleMs: finiteRange(c.breathingCycleMs, d.breathingCycleMs, 2500, 10000),
    breathingScaleAmplitude: finiteRange(c.breathingScaleAmplitude, d.breathingScaleAmplitude, 0, 0.01),
    headCycleMs: finiteRange(c.headCycleMs, d.headCycleMs, 6000, 30000),
    headTiltDegrees: finiteRange(c.headTiltDegrees, d.headTiltDegrees, 0, 2),
    blinkMinIntervalMs: finiteRange(c.blinkMinIntervalMs, d.blinkMinIntervalMs, 1500, 10000),
    blinkMaxIntervalMs: finiteRange(c.blinkMaxIntervalMs, d.blinkMaxIntervalMs, 2000, 15000),
    blinkClosedMs: finiteRange(c.blinkClosedMs, d.blinkClosedMs, 60, 250),
    blinkDoubleChance: finiteRange(c.blinkDoubleChance, d.blinkDoubleChance, 0, 0.35),
    blinkDoubleGapMs: finiteRange(c.blinkDoubleGapMs, d.blinkDoubleGapMs, 80, 300),
    tapCooldownMs: finiteRange(c.tapCooldownMs, d.tapCooldownMs, 500, 10000),
    tapReactionMs: finiteRange(c.tapReactionMs, d.tapReactionMs, 100, 1000),
    gazeMaxX: finiteRange(c.gazeMaxX, d.gazeMaxX, 0, 0.08),
    gazeMaxY: finiteRange(c.gazeMaxY, d.gazeMaxY, 0, 0.06),
    blinkDuringSpeech: typeof c.blinkDuringSpeech === 'boolean' ? c.blinkDuringSpeech : d.blinkDuringSpeech,
  };
}

function finiteRange(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}
