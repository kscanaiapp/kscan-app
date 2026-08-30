import type { AvatarEngineConfig, AvatarEyeState } from '../types';

export interface BlinkRuntimeState {
  nextBlinkAtMs: number;
  blinkStartedAtMs: number | null;
  secondBlinkAtMs: number | null;
  seed: number;
}

/**
 * Blink cadence is pseudo-random but SEEDED, so iOS and Android calculate the
 * identical sequence for the same motion epoch. Randomness here is texture, not
 * entropy; a platform-divergent blink would show up as an engine defect during
 * cross-platform comparison.
 */
export function createBlinkState(nowMs = 0, seed = 0x4b534341): BlinkRuntimeState {
  return { nextBlinkAtMs: nowMs + 3500, blinkStartedAtMs: null, secondBlinkAtMs: null, seed: seed >>> 0 };
}

export function deriveBlink(
  nowMs: number,
  state: BlinkRuntimeState,
  enabled: boolean,
  config: AvatarEngineConfig,
): AvatarEyeState {
  if (!enabled || !Number.isFinite(nowMs)) return 'open';
  if (state.blinkStartedAtMs !== null) {
    const elapsed = nowMs - state.blinkStartedAtMs;
    if (elapsed < config.blinkClosedMs * 0.25) return 'half';
    if (elapsed < config.blinkClosedMs * 0.75) return 'closed';
    if (elapsed < config.blinkClosedMs) return 'half';
    state.blinkStartedAtMs = null;
    if (state.secondBlinkAtMs !== null) {
      state.nextBlinkAtMs = state.secondBlinkAtMs;
      state.secondBlinkAtMs = null;
    } else {
      scheduleNext(nowMs, state, config);
    }
    return 'open';
  }
  if (nowMs >= state.nextBlinkAtMs) {
    state.blinkStartedAtMs = nowMs;
    if (nextRandom(state) < config.blinkDoubleChance) {
      state.secondBlinkAtMs = nowMs + config.blinkClosedMs + config.blinkDoubleGapMs;
    }
    return 'half';
  }
  return 'open';
}

function scheduleNext(nowMs: number, state: BlinkRuntimeState, config: AvatarEngineConfig): void {
  const roll = nextRandom(state);
  const span = Math.max(0, config.blinkMaxIntervalMs - config.blinkMinIntervalMs);
  state.nextBlinkAtMs = nowMs + config.blinkMinIntervalMs + roll * span;
}

/** xorshift32 — deterministic, allocation-free, identical on every platform. */
function nextRandom(state: BlinkRuntimeState): number {
  let x = state.seed || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.seed = x >>> 0;
  return state.seed / 0xffffffff;
}
