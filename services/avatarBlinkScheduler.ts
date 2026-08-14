import type { AvatarEyeState } from './avatarMotionState';

// Deterministic blink scheduling.
//
// Pure planning functions over an injected random source and caller-supplied
// timestamps: the scheduler itself owns no timer, no clock, and no state, so
// every schedule is exactly reproducible in tests. A driver (hook) turns
// plans into timers and owns their cancellation.
//
// Blink is a renderer-local behavior: it never enters motion arbitration and
// may coexist with any mouth state, including active speech. It requires the
// complete eye overlay package (open / half-closed / closed) — with assets
// missing the capability is false and no blink is ever scheduled.

export const BLINK_POLICY = {
  /** Bounds for the irregular gap between blinks. */
  minIntervalMs: 2_800,
  maxIntervalMs: 7_600,
  /** Frame durations for one blink: open→half→closed→half→open. */
  closingHalfMs: 40,
  closedMs: 70,
  openingHalfMs: 60,
  /** Probability that a blink is a restrained double blink. */
  doubleBlinkProbability: 0.12,
  /** Gap between the two closures of a double blink. */
  doubleBlinkGapMs: 180,
  /**
   * Hard floor between the end of one blink and the start of the next,
   * whatever the random source produces. Prevents rapid/continuous blinking.
   */
  minRestMs: 1_500,
} as const;

export interface BlinkFrame {
  /** Offset from the blink's start. */
  atMs: number;
  eyes: AvatarEyeState;
}

export interface BlinkPlan {
  /** Delay from "now" until the blink begins. */
  startInMs: number;
  /** Whether this is a double blink. */
  double: boolean;
  /** Eye-state frames, offsets relative to the blink start; ends open. */
  frames: readonly BlinkFrame[];
  /** Total duration of the frame sequence. */
  durationMs: number;
}

function singleBlinkFrames(startMs: number): BlinkFrame[] {
  const { closingHalfMs, closedMs, openingHalfMs } = BLINK_POLICY;
  return [
    { atMs: startMs, eyes: 'halfOpen' },
    { atMs: startMs + closingHalfMs, eyes: 'closed' },
    { atMs: startMs + closingHalfMs + closedMs, eyes: 'halfOpen' },
    { atMs: startMs + closingHalfMs + closedMs + openingHalfMs, eyes: 'open' },
  ];
}

/**
 * Plan the next blink from a uniform [0,1) random source.
 *
 * The interval is irregular but bounded; a small fraction of blinks are
 * restrained double blinks. Given the same random sequence the plan is
 * byte-for-byte identical.
 */
export function planNextBlink(random: () => number): BlinkPlan {
  const { minIntervalMs, maxIntervalMs, doubleBlinkProbability, doubleBlinkGapMs } = BLINK_POLICY;
  const span = maxIntervalMs - minIntervalMs;
  const startInMs = Math.max(
    BLINK_POLICY.minRestMs,
    minIntervalMs + Math.floor(random() * span),
  );
  const double = random() < doubleBlinkProbability;

  const first = singleBlinkFrames(0);
  const frames = double
    ? [...first, ...singleBlinkFrames(first[first.length - 1].atMs + doubleBlinkGapMs)]
    : first;
  return {
    startInMs,
    double,
    frames,
    durationMs: frames[frames.length - 1].atMs,
  };
}

/**
 * Resolve the eye state at an offset into a blink plan. Before the first
 * frame and after the last the eyes are open. Used by tests and by drivers
 * that render frames from elapsed time instead of per-frame timers.
 */
export function resolveEyeStateAt(plan: BlinkPlan, offsetMs: number): AvatarEyeState {
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return 'open';
  let eyes: AvatarEyeState = 'open';
  for (const frame of plan.frames) {
    if (frame.atMs <= offsetMs) eyes = frame.eyes;
  }
  return eyes;
}

/**
 * Validate that a plan respects the anti-rapid-blink policy: bounded start,
 * bounded duration, ends open, and no frame regresses time.
 */
export function isRestrainedBlinkPlan(plan: BlinkPlan): boolean {
  if (plan.startInMs < BLINK_POLICY.minRestMs) return false;
  if (plan.startInMs > BLINK_POLICY.maxIntervalMs) return false;
  if (plan.frames.length === 0) return false;
  if (plan.frames[plan.frames.length - 1].eyes !== 'open') return false;
  let previous = -1;
  for (const frame of plan.frames) {
    if (!Number.isFinite(frame.atMs) || frame.atMs <= previous) return false;
    previous = frame.atMs;
  }
  // Even a double blink stays under one second of eye activity.
  return plan.durationMs <= 1_000;
}
