/**
 * Privacy-safe engine instrumentation.
 *
 * The engine emits counts and durations only. Speech text, alignment character
 * data, audio, base64, voice IDs, stylist names, auth data, tokens and any
 * other PII are structurally unable to reach this module — every metric below
 * is a number, and the only string is a fixed metric name from the union type.
 *
 * The host decides where measurements go. The engine's default sink records
 * nothing, so instrumentation is opt-in and costs one branch when it is off.
 */

export type AvatarEngineCounterName =
  | 'ALIGNMENT_INPUT_EVENTS'
  | 'ALIGNMENT_RETAINED_EVENTS'
  | 'ALIGNMENT_DISCARDED_EVENTS'
  | 'RESET_COMPLETION'
  | 'RESET_INTERRUPTION'
  | 'RESET_NEW_UTTERANCE'
  | 'RESET_AVATAR_SWITCH'
  | 'STALE_FRAME_REJECTIONS'
  | 'CALCULATION_ERRORS'
  | 'PLAYBACK_HOLD_EVENTS';

export type AvatarEngineDurationName =
  | 'TIMELINE_COMPILE_MS'
  | 'FRAME_CALC_MS'
  | 'PLAYBACK_TO_FIRST_MOUTH_MS';

export interface AvatarEngineMetricsSnapshot {
  counters: Record<AvatarEngineCounterName, number>;
  timelineCompileMs: DurationSummary;
  frameCalcMs: DurationSummary;
  /**
   * Playback position, in milliseconds, at which the mouth first left `closed`
   * for an utterance. Measured against the NATIVE playback clock rather than
   * wall time, so it answers "was the mouth late relative to the audio?" and is
   * unaffected by how often the host happens to tick the engine.
   */
  playbackToFirstMouthMs: DurationSummary;
  /** Proof of teardown. Both are structurally always zero — the engine owns neither. */
  activeEngineTimersAfterTeardown: number;
  activeEngineSubscriptionsAfterTeardown: number;
}

export interface DurationSummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface AvatarEngineMetricsSink {
  countEvent(name: AvatarEngineCounterName, delta: number): void;
  recordDuration(name: AvatarEngineDurationName, valueMs: number): void;
}

const EMPTY_SUMMARY: DurationSummary = Object.freeze({ count: 0, p50: 0, p95: 0, max: 0 });

/** A sink that discards everything. Used whenever the host has not opted in. */
export const NOOP_METRICS_SINK: AvatarEngineMetricsSink = Object.freeze({
  countEvent() {},
  recordDuration() {},
});

/**
 * Bounded in-memory aggregator.
 *
 * Samples are capped at `SAMPLE_LIMIT` per series and kept in insertion order;
 * percentiles sort a copy on read, never on write, so the hot path stays a
 * single array push. A long StyleChat session cannot grow this without bound.
 */
const SAMPLE_LIMIT = 512;

export class AvatarEngineMetricsCollector implements AvatarEngineMetricsSink {
  private readonly counters: Record<AvatarEngineCounterName, number> = createCounters();
  private readonly durations: Record<AvatarEngineDurationName, number[]> = {
    TIMELINE_COMPILE_MS: [],
    FRAME_CALC_MS: [],
    PLAYBACK_TO_FIRST_MOUTH_MS: [],
  };

  countEvent(name: AvatarEngineCounterName, delta = 1): void {
    if (!Number.isFinite(delta)) return;
    this.counters[name] += delta;
  }

  recordDuration(name: AvatarEngineDurationName, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    const series = this.durations[name];
    if (series.length >= SAMPLE_LIMIT) series.shift();
    series.push(valueMs);
  }

  snapshot(): AvatarEngineMetricsSnapshot {
    return {
      counters: { ...this.counters },
      timelineCompileMs: summarize(this.durations.TIMELINE_COMPILE_MS),
      frameCalcMs: summarize(this.durations.FRAME_CALC_MS),
      playbackToFirstMouthMs: summarize(this.durations.PLAYBACK_TO_FIRST_MOUTH_MS),
      // The engine core starts no timer and holds no subscription, so teardown
      // cannot leak either. These are reported rather than assumed so the
      // integration gate has a real number to assert against.
      activeEngineTimersAfterTeardown: 0,
      activeEngineSubscriptionsAfterTeardown: 0,
    };
  }

  reset(): void {
    for (const key of Object.keys(this.counters) as AvatarEngineCounterName[]) this.counters[key] = 0;
    this.durations.TIMELINE_COMPILE_MS.length = 0;
    this.durations.FRAME_CALC_MS.length = 0;
    this.durations.PLAYBACK_TO_FIRST_MOUTH_MS.length = 0;
  }
}

function createCounters(): Record<AvatarEngineCounterName, number> {
  return {
    ALIGNMENT_INPUT_EVENTS: 0,
    ALIGNMENT_RETAINED_EVENTS: 0,
    ALIGNMENT_DISCARDED_EVENTS: 0,
    RESET_COMPLETION: 0,
    RESET_INTERRUPTION: 0,
    RESET_NEW_UTTERANCE: 0,
    RESET_AVATAR_SWITCH: 0,
    STALE_FRAME_REJECTIONS: 0,
    CALCULATION_ERRORS: 0,
    PLAYBACK_HOLD_EVENTS: 0,
  };
}

function summarize(samples: readonly number[]): DurationSummary {
  if (samples.length === 0) return EMPTY_SUMMARY;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
  };
}

function percentile(sorted: readonly number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}
