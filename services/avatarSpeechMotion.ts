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
 * Structural validation for provider alignment data.
 *
 * Alignment arrives from outside this module and is not trustworthy: a
 * mismatched, reversed, or non-finite entry would otherwise become a mouth
 * interval with a corrupt range, and an interval like `[NaN, NaN]` or
 * `[end, start]` can leave the mouth held open for the rest of playback.
 * Every character is validated independently so a single bad entry degrades
 * to closed instead of discarding usable speech.
 */
function isUsableInterval(start: number, end: number): boolean {
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end >= start
  );
}

export function isValidSpeechAlignment(
  alignment: AvatarSpeechAlignment | null | undefined,
): alignment is AvatarSpeechAlignment {
  if (!alignment || typeof alignment !== 'object') return false;
  const { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends } =
    alignment;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) {
    return false;
  }
  // Mismatched array lengths mean the timing cannot be attributed to
  // characters at all; there is no safe partial interpretation.
  if (characters.length !== starts.length || characters.length !== ends.length) return false;
  return true;
}

let timelineBuildCount = 0;

/** Test instrumentation: total raw timeline constructions this process. */
export function getMouthTimelineBuildCountForTests(): number {
  return timelineBuildCount;
}

/** Test instrumentation: reset the construction counter. */
export function resetMouthTimelineBuildCountForTests(): void {
  timelineBuildCount = 0;
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
  timelineBuildCount += 1;
  // Structurally unusable alignment yields an empty timeline; the resolver
  // then reports closed, which is always a safe visual.
  if (!isValidSpeechAlignment(alignment)) return [];

  const { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends } =
    alignment;

  const raw: MouthStateInterval[] = [];
  let previousEnd = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const start = starts[index];
    const end = ends[index];
    // A corrupt or reversed interval is dropped rather than repaired: an
    // invented range would place the mouth open at a time the provider never
    // described. Dropping it leaves a gap, which reads as a natural pause.
    if (!isUsableInterval(start, end)) continue;
    // Non-monotonic timing (an interval that starts before the previous one
    // ended) cannot be sequenced against an advancing cursor, so it is
    // dropped for the same reason.
    if (start < previousEnd) continue;
    const character = characters[index];
    const state =
      typeof character === 'string' && isSpeakableCharacter(character)
        ? characterToMouthState(character)
        : 'closed';
    raw.push({ start, end, state });
    previousEnd = end;
  }

  if (raw.length === 0) return [];

  return insertPauseIntervals(
    enforceMinimumDuration(mergeConsecutiveIntervals(raw)),
  );
}

// ── Once-per-generation construction and bounded lookup ──────────────────────
//
// A speech generation carries exactly one alignment object, so caching by
// alignment reference makes construction once-per-generation without any
// explicit invalidation: a superseding generation brings a new alignment
// object and the old entries become unreachable. Stale timelines can never
// serve the current speech because the key is the alignment itself.

const timelineCache = new WeakMap<AvatarSpeechAlignment, MouthStateInterval[]>();

/** Return the cached timeline for an alignment, building it at most once. */
export function getMouthStateTimelineCached(
  alignment: AvatarSpeechAlignment,
): MouthStateInterval[] {
  const cached = timelineCache.get(alignment);
  if (cached) return cached;
  const built = buildMouthStateTimeline(alignment);
  timelineCache.set(alignment, built);
  return built;
}

export interface MouthTimelineCursor {
  resolve(playbackSeconds: number): AvatarMouthState;
}

/** First interval index whose end is >= the target time (binary search). */
function lowerBoundByEnd(timeline: MouthStateInterval[], seconds: number): number {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (timeline[mid].end < seconds) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Bounded playback-position lookup over an already-built timeline. Forward
 * playback advances a cursor in amortized O(1); a backward seek (replay,
 * scrub, position reset) re-anchors with an O(log n) binary search. The
 * timeline itself is never rebuilt here.
 */
export function createMouthTimelineCursor(
  timeline: MouthStateInterval[],
): MouthTimelineCursor {
  let index = 0;
  return {
    resolve(playbackSeconds: number): AvatarMouthState {
      if (
        timeline.length === 0 ||
        !Number.isFinite(playbackSeconds) ||
        playbackSeconds < 0
      ) {
        return 'closed';
      }
      if (index > timeline.length - 1) index = timeline.length - 1;
      if (playbackSeconds < timeline[index].start) {
        // Backward seek: re-anchor instead of scanning linearly.
        index = Math.min(lowerBoundByEnd(timeline, playbackSeconds), timeline.length - 1);
      }
      while (index < timeline.length - 1 && playbackSeconds > timeline[index].end) {
        index += 1;
      }
      const interval = timeline[index];
      if (playbackSeconds >= interval.start && playbackSeconds <= interval.end) {
        return interval.state;
      }
      return 'closed';
    },
  };
}

const cursorCache = new WeakMap<MouthStateInterval[], MouthTimelineCursor>();

/**
 * Resolve the mouth state for an alignment at a playback position using the
 * cached timeline and a cached advancing cursor. The cursor is keyed by the
 * built timeline, so a new generation (new alignment object) starts with a
 * fresh cursor automatically.
 */
export function resolveMouthStateAtPlayback(
  alignment: AvatarSpeechAlignment,
  playbackSeconds: number,
): AvatarMouthState {
  const timeline = getMouthStateTimelineCached(alignment);
  let cursor = cursorCache.get(timeline);
  if (!cursor) {
    cursor = createMouthTimelineCursor(timeline);
    cursorCache.set(timeline, cursor);
  }
  return cursor.resolve(playbackSeconds);
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

  // Missing or structurally unusable alignment falls back to the
  // deterministic cycle: real audio is playing, so a permanently closed
  // mouth would be a worse failure than approximate movement.
  if (!input.alignment || !isValidSpeechAlignment(input.alignment)) {
    return resolveFallbackMouthState(input.playbackSeconds);
  }

  // Cached construction + advancing cursor: the timeline for an alignment is
  // built at most once per generation and each tick costs amortized O(1).
  const timeline = getMouthStateTimelineCached(input.alignment);
  if (timeline.length === 0 && input.alignment.characters.length > 0) {
    // Every interval was corrupt. Treat it as alignment-free rather than
    // holding the mouth closed through an entire utterance.
    return resolveFallbackMouthState(input.playbackSeconds);
  }
  return resolveMouthStateAtPlayback(input.alignment, input.playbackSeconds);
}
