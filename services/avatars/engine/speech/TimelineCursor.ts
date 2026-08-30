import type { AvatarMouthState, CompiledSpeechTimeline } from '../types';

/**
 * Bounded lookup over a compiled timeline.
 *
 * Normal playback advances the cursor by a step or two per frame, so the common
 * case is effectively O(1) with no allocation and no rescan from the start —
 * the defect in the legacy `resolveMouthStateFromTimeline`, which scanned every
 * interval from index 0 on every frame.
 *
 * Discontinuities are re-anchored by binary search instead of by walking:
 *  - a backward seek or repeat re-anchors (position moved backwards),
 *  - a large forward jump re-anchors (a skip past `FORWARD_RESCAN_LIMIT`
 *    intervals, e.g. a resumed player reporting a much later position).
 * Both keep worst-case lookup logarithmic in the number of intervals.
 */
const FORWARD_RESCAN_LIMIT = 8;

export class TimelineCursor {
  private index = 0;
  private lastSeconds = -1;

  reset(): void {
    this.index = 0;
    this.lastSeconds = -1;
  }

  resolve(timeline: CompiledSpeechTimeline | null, seconds: number): AvatarMouthState {
    if (!timeline || timeline.intervals.length === 0) return 'closed';
    if (!Number.isFinite(seconds) || seconds < 0) return 'closed';
    const intervals = timeline.intervals;

    if (seconds < this.lastSeconds) {
      this.index = binaryAnchor(intervals, seconds);
    }
    this.lastSeconds = seconds;

    let steps = 0;
    while (this.index < intervals.length && seconds >= intervals[this.index]!.endSeconds) {
      this.index += 1;
      steps += 1;
      if (steps > FORWARD_RESCAN_LIMIT) {
        this.index = binaryAnchor(intervals, seconds);
        break;
      }
    }

    if (this.index >= intervals.length) return 'closed';
    const current = intervals[this.index]!;
    return seconds >= current.startSeconds && seconds < current.endSeconds ? current.mouthState : 'closed';
  }
}

/** First interval whose end is strictly after `seconds`. */
function binaryAnchor(intervals: CompiledSpeechTimeline['intervals'], seconds: number): number {
  let lo = 0;
  let hi = intervals.length - 1;
  let answer = intervals.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid]!.endSeconds <= seconds) {
      lo = mid + 1;
    } else {
      answer = mid;
      hi = mid - 1;
    }
  }
  return answer;
}
