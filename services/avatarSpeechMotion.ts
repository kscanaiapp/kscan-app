import type {
  AvatarSpeechAlignment,
  AvatarSpeechPhase,
} from '../stores/avatarSpeechStore';

export type AvatarMouthState = 'closed' | 'halfOpen' | 'open' | 'round';

export interface MouthStateInterval {
  start: number;
  end: number;
  state: AvatarMouthState;
}

export const MOUTH_TIMING_POLICY = {
  /** Shortest interval a state should hold before switching; avoids flicker. */
  minStateDurationSeconds: 0.1,
  /** Rough ceiling on state changes per second under normal motion. */
  maxUpdateRatePerSecond: 10,
  /** Gap between characters that returns the mouth to closed. */
  pauseThresholdSeconds: 0.2,
} as const;

const SPEAKABLE_CHARACTER_RE = /[\p{L}\p{N}]/u;
const ROUND_CHARACTER_RE = /[oOuUwW]/;
const OPEN_CHARACTER_RE = /[aAeEiIyY]/;

export function characterToMouthState(char: string): Exclude<AvatarMouthState, 'closed'> {
  if (ROUND_CHARACTER_RE.test(char)) return 'round';
  if (OPEN_CHARACTER_RE.test(char)) return 'open';
  return 'halfOpen';
}

function isSpeakableCharacter(char: string): boolean {
  return SPEAKABLE_CHARACTER_RE.test(char);
}

function mergeConsecutiveIntervals(intervals: MouthStateInterval[]): MouthStateInterval[] {
  const merged: MouthStateInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && last.state === interval.state) {
      last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function enforceMinimumDuration(intervals: MouthStateInterval[]): MouthStateInterval[] {
  const minDuration = MOUTH_TIMING_POLICY.minStateDurationSeconds;
  const timingEpsilon = 1e-9;
  const result: MouthStateInterval[] = [];
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    const duration = interval.end - interval.start;
    if (duration + timingEpsilon < minDuration) {
      // Merge into the previous interval if one exists; otherwise absorb into the next.
      if (result.length > 0) {
        result[result.length - 1].end = interval.end;
      } else if (index < intervals.length - 1) {
        intervals[index + 1].start = interval.start;
      } else {
        result.push(interval);
      }
    } else {
      result.push(interval);
    }
  }
  return result;
}

function insertPauseIntervals(intervals: MouthStateInterval[]): MouthStateInterval[] {
  const pauseThreshold = MOUTH_TIMING_POLICY.pauseThresholdSeconds;
  const withPauses: MouthStateInterval[] = [];
  for (let index = 0; index < intervals.length; index += 1) {
    if (index > 0) {
      const gap = intervals[index].start - intervals[index - 1].end;
      if (gap >= pauseThreshold) {
        withPauses.push({
          start: intervals[index - 1].end,
          end: intervals[index].start,
          state: 'closed',
        });
      }
    }
    withPauses.push(intervals[index]);
  }
  return withPauses;
}

/**
 * Build a timeline of mouth-state intervals from normalized speech alignment data.
 *
 * - Non-speakable characters become closed.
 * - Consecutive identical states are merged.
 * - Intervals shorter than the minimum stable duration are merged into neighbors.
 * - Gaps between intervals that exceed the pause threshold become closed.
 */
export function buildMouthStateTimeline(
  alignment: AvatarSpeechAlignment,
): MouthStateInterval[] {
  const { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends } =
    alignment;

  const raw: MouthStateInterval[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const state = isSpeakableCharacter(characters[index])
      ? characterToMouthState(characters[index])
      : 'closed';
    raw.push({ start: starts[index], end: ends[index], state });
  }

  return insertPauseIntervals(
    enforceMinimumDuration(mergeConsecutiveIntervals(raw)),
  );
}

/**
 * Return the mouth state at a given playback position from a precomputed timeline.
 */
export function resolveMouthStateFromTimeline(
  timeline: MouthStateInterval[],
  playbackSeconds: number,
): AvatarMouthState {
  for (const interval of timeline) {
    if (playbackSeconds >= interval.start && playbackSeconds <= interval.end) {
      return interval.state;
    }
  }
  return 'closed';
}

function resolveFallbackMouthState(playbackSeconds: number): AvatarMouthState {
  const cycleDuration = 0.6;
  const t = playbackSeconds % cycleDuration;
  if (t < 0.15) return 'closed';
  if (t < 0.30) return 'halfOpen';
  if (t < 0.45) return 'open';
  return 'halfOpen';
}

export interface DeriveAvatarMouthStateInput {
  phase: AvatarSpeechPhase;
  playbackSeconds: number;
  alignment: AvatarSpeechAlignment | null;
  reducedMotion?: boolean;
}

/**
 * Derive the visible mouth state from playback progress and alignment.
 *
 * - Closed when not actively playing.
 * - Reduced motion keeps the mouth closed so all avatar motion stops.
 * - When alignment is missing, a deterministic fallback cycle tied to playback
 *   position is used.
 */
export function deriveAvatarMouthState(input: DeriveAvatarMouthStateInput): AvatarMouthState {
  if (input.phase !== 'playing' || !Number.isFinite(input.playbackSeconds) || input.playbackSeconds < 0) {
    return 'closed';
  }

  if (input.reducedMotion) return 'closed';

  if (!input.alignment) {
    return resolveFallbackMouthState(input.playbackSeconds);
  }

  return resolveMouthStateFromTimeline(
    buildMouthStateTimeline(input.alignment),
    input.playbackSeconds,
  );
}
