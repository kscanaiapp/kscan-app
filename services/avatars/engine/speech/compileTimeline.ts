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
    return freezeTimeline([], 0, normalized.source, normalized.disposition, normalized.dropped, elapsed());
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

  const total = out.length ? out[out.length - 1]!.endSeconds : 0;
  return freezeTimeline(out, total, normalized.source, normalized.disposition, normalized.dropped, elapsed());
}

function freezeTimeline(
  intervals: SpeechTimelineInterval[],
  totalDurationSeconds: number,
  source: CompiledSpeechTimeline['source'],
  disposition: CompiledSpeechTimeline['disposition'],
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
    droppedIntervalCount,
    compileMs,
  });
}
