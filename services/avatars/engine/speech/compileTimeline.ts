import type {
  AvatarAssetCapabilities,
  AvatarEngineConfig,
  AvatarSpeechAlignment,
  CompiledSpeechTimeline,
  SpeechTimelineInterval,
} from '../types';
import { normalizeEngineConfig } from '../config';
import { normalizeAlignment } from '../validation/alignment';
import { characterToViseme, phonemeToViseme, visemeToMouthState } from './viseme';

/**
 * Compiles provider alignment into a frozen, monotonically ordered interval
 * list once per utterance. Frame lookup then never touches alignment again.
 *
 * `now` is an OPTIONAL host-supplied monotonic clock used solely to measure
 * TIMELINE_COMPILE_MS. The engine deliberately has no ambient clock of its own:
 * omitting it yields `compileMs: 0` and byte-identical timelines, so nothing
 * about the visual result depends on whether instrumentation is enabled.
 */
export function compileSpeechTimeline(
  alignment: AvatarSpeechAlignment | unknown,
  caps: AvatarAssetCapabilities,
  config?: Partial<AvatarEngineConfig>,
  now?: () => number,
): CompiledSpeechTimeline {
  const startedAt = now ? now() : 0;
  const cfg = normalizeEngineConfig(config);
  const normalized = normalizeAlignment(alignment);
  const elapsed = () => (now ? Math.max(0, now() - startedAt) : 0);

  if (normalized.source === 'none' || normalized.entries.length === 0) {
    return freezeTimeline(
      [],
      0,
      normalized.source,
      normalized.disposition,
      normalized.inputCount,
      normalized.entries.length,
      normalized.dropped,
      elapsed(),
    );
  }

  const raw: SpeechTimelineInterval[] = normalized.entries.map((entry) => {
    const viseme = normalized.source === 'character'
      ? characterToViseme((entry as { char: string }).char)
      : phonemeToViseme((entry as { phoneme: string }).phoneme);
    return {
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
      viseme,
      mouthState: visemeToMouthState(viseme, caps),
    };
  });

  // Provider timing stays authoritative. V10 applies no global minimum state
  // duration — the legacy 0.100s floor is deliberately not reintroduced here.
  // Only genuine local noise is removed: a very short interval sandwiched
  // between the SAME visual state on both sides, which can only flicker.
  const denoised: SpeechTimelineInterval[] = [];
  const noiseSeconds = cfg.noiseIntervalMs / 1000;
  for (let i = 0; i < raw.length; i += 1) {
    const current = raw[i]!;
    const prev = raw[i - 1];
    const next = raw[i + 1];
    const duration = current.endSeconds - current.startSeconds;
    const isFlicker =
      prev && next &&
      duration <= noiseSeconds &&
      prev.mouthState === next.mouthState &&
      current.mouthState !== prev.mouthState;
    if (isFlicker) continue;
    denoised.push(current);
  }

  const pauseThreshold = cfg.pauseThresholdMs / 1000;
  const microGap = cfg.microGapMergeMs / 1000;
  const out: SpeechTimelineInterval[] = [];
  for (const current of denoised) {
    const last = out[out.length - 1];
    if (last && current.startSeconds - last.endSeconds >= pauseThreshold) {
      out.push({
        startSeconds: last.endSeconds,
        endSeconds: current.startSeconds,
        viseme: 'rest',
        mouthState: 'closed',
      });
    }
    const mergeTarget = out[out.length - 1];
    if (
      mergeTarget &&
      mergeTarget.mouthState === current.mouthState &&
      current.startSeconds - mergeTarget.endSeconds <= microGap
    ) {
      mergeTarget.endSeconds = Math.max(mergeTarget.endSeconds, current.endSeconds);
    } else {
      out.push({ ...current });
    }
  }

  const held = applyMinimumHold(out, cfg.minVisibleHoldMs / 1000);

  const total = held.length ? held[held.length - 1]!.endSeconds : 0;
  return freezeTimeline(
    held,
    total,
    normalized.source,
    normalized.disposition,
    normalized.inputCount,
    normalized.entries.length,
    normalized.dropped,
    elapsed(),
  );
}

/**
 * Perceptual minimum hold.
 *
 * Runs last, over intervals whose timing is already the provider's. It answers
 * one question per transition: has the state currently on screen been visible
 * long enough to read as a mouth shape rather than a flicker? If not, the
 * transition is absorbed and the held state simply continues.
 *
 * Two properties this deliberately preserves:
 *
 *  - NO ONSET MOVES. A surviving interval keeps its provider start time, so
 *    the mouth stays anchored to the native playback clock. The pass only ever
 *    removes a boundary and extends the interval before it; it never invents
 *    a timing the provider did not supply, and never shifts one earlier or
 *    later. Audio/visual sync is therefore unchanged.
 *  - TOTAL DURATION IS PRESERVED. The final interval still ends where the
 *    provider's last interval ended, so the utterance finishes closed at the
 *    same instant it did before.
 *
 * Held duration is measured from the held interval's own START, not from the
 * absorbed interval, so a run of sub-perceptual changes cannot compound into
 * an unbounded stare: the state releases at the first real onset past the
 * floor.
 */
function applyMinimumHold(
  intervals: SpeechTimelineInterval[],
  minHoldSeconds: number,
): SpeechTimelineInterval[] {
  if (minHoldSeconds <= 0 || intervals.length < 2) return intervals;

  const held: SpeechTimelineInterval[] = [];
  let current: SpeechTimelineInterval = { ...intervals[0]! };
  let emittedFirstChange = false;

  for (let i = 1; i < intervals.length; i += 1) {
    const next = intervals[i]!;
    const visibleSoFar = next.startSeconds - current.startSeconds;
    const sameShape = next.mouthState === current.mouthState;

    // The FIRST shape change of an utterance is never absorbed. Applying the
    // floor here would delay the moment Elise's mouth starts moving — measured
    // at 320 ms instead of 80 ms on the governed long sample — which reads as
    // the avatar lagging the audio, the exact failure this repair exists to
    // avoid. Anti-flap is a mid-utterance concern; the opening beat is a
    // latency concern, and latency wins.
    const mustEmit = !emittedFirstChange && !sameShape;

    if (!mustEmit && (sameShape || visibleSoFar < minHoldSeconds)) {
      current.endSeconds = Math.max(current.endSeconds, next.endSeconds);
      continue;
    }

    held.push(current);
    current = { ...next };
    emittedFirstChange = true;
  }

  held.push(current);
  return held;
}

function freezeTimeline(
  intervals: SpeechTimelineInterval[],
  totalDurationSeconds: number,
  source: CompiledSpeechTimeline['source'],
  disposition: CompiledSpeechTimeline['disposition'],
  inputIntervalCount: number,
  retainedIntervalCount: number,
  droppedIntervalCount: number,
  compileMs: number,
): CompiledSpeechTimeline {
  for (const interval of intervals) Object.freeze(interval);
  Object.freeze(intervals);
  return Object.freeze({
    intervals,
    totalDurationSeconds,
    source,
    disposition,
    inputIntervalCount,
    retainedIntervalCount,
    droppedIntervalCount,
    compileMs,
  });
}
