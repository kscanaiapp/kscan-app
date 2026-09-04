/**
 * Metric collection — Section 17.
 *
 * "Collect where relevant: tracking confidence; landmark jitter; inference
 * latency; segmentation latency; frame time; dropped frames; anchor
 * error; mask stability; garment deformation; thermal state; memory
 * pressure; tracking reacquisition... Image similarity may be used as a
 * supplementary regression signal. It may NOT be the sole visual-quality
 * gate." Every function here produces one number or small struct that
 * feeds a human review package (Section 18) — none of them independently
 * decide PASS/FAIL.
 */

import { isLandmarkPresent, type BodyFrame, type BodyFrameLandmarkKey, type Point2D } from '@kscan-live-vto/contract';

export function anchorError(predicted: Point2D, expected: Point2D): number {
  return Math.hypot(predicted.u - expected.u, predicted.v - expected.v);
}

export interface JitterResult {
  /** Root-mean-square frame-to-frame displacement of the landmark, in normalized [0,1] image units. Present-frame pairs only. */
  rmsDisplacement: number;
  /** Frames where the landmark was present in both this frame and the previous one — the sample size rmsDisplacement is computed over. */
  comparablePairs: number;
}

/**
 * Frame-to-frame jitter for one landmark across a sequence. A landmark
 * that's absent in either frame of a pair contributes nothing to the
 * result rather than being treated as a (0,0) jump — see BodyFrame's
 * "missing values must be representable" rule; this metric respects that
 * all the way through.
 */
export function landmarkJitter(series: readonly BodyFrame[], key: BodyFrameLandmarkKey): JitterResult {
  let sumSquared = 0;
  let pairs = 0;

  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]![key];
    const curr = series[i]![key];
    if (!isLandmarkPresent(prev) || !isLandmarkPresent(curr)) continue;
    const d = Math.hypot(curr.point.u - prev.point.u, curr.point.v - prev.point.v);
    sumSquared += d * d;
    pairs += 1;
  }

  return {
    rmsDisplacement: pairs > 0 ? Math.sqrt(sumSquared / pairs) : 0,
    comparablePairs: pairs,
  };
}

export interface TrackingConfidenceStats {
  mean: number;
  min: number;
  max: number;
  sampleCount: number;
}

export function trackingConfidenceStats(series: readonly BodyFrame[]): TrackingConfidenceStats {
  if (series.length === 0) return { mean: 0, min: 0, max: 0, sampleCount: 0 };
  const values = series.map((f) => f.trackingConfidence);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    sampleCount: values.length,
  };
}

export interface DroppedFrameResult {
  expectedFrames: number;
  observedFrames: number;
  droppedFrameRatio: number;
}

/**
 * Estimates dropped frames from timestamp gaps against the sequence's
 * nominal frame interval. A gap more than 1.5x the nominal interval is
 * treated as having skipped `round(gap / nominalIntervalMs) - 1` frames.
 */
export function droppedFrames(timestampsMs: readonly number[], nominalFrameRateHz: number): DroppedFrameResult {
  if (timestampsMs.length < 2) {
    return { expectedFrames: timestampsMs.length, observedFrames: timestampsMs.length, droppedFrameRatio: 0 };
  }

  const nominalIntervalMs = 1000 / nominalFrameRateHz;
  let dropped = 0;

  for (let i = 1; i < timestampsMs.length; i++) {
    const gap = timestampsMs[i]! - timestampsMs[i - 1]!;
    if (gap > nominalIntervalMs * 1.5) {
      dropped += Math.round(gap / nominalIntervalMs) - 1;
    }
  }

  const observedFrames = timestampsMs.length;
  const expectedFrames = observedFrames + dropped;

  return {
    expectedFrames,
    observedFrames,
    droppedFrameRatio: expectedFrames > 0 ? dropped / expectedFrames : 0,
  };
}

export type TrackingEventKind = 'lost' | 'reacquired';

export interface TrackingEvent {
  kind: TrackingEventKind;
  timestamp: number;
  confidence: number;
}

/**
 * Hysteresis-based loss/reacquisition detection (Section 26 P2-D:
 * "reacquisition does not snap" — measuring this requires knowing exactly
 * when loss/reacquisition happened, which is what this produces). Uses
 * two thresholds rather than one so confidence hovering near a single
 * cutoff doesn't register as a chain of spurious loss/reacquire events.
 */
export function detectTrackingEvents(
  series: readonly BodyFrame[],
  lossThreshold = 0.3,
  reacquireThreshold = 0.6,
): TrackingEvent[] {
  const events: TrackingEvent[] = [];
  let tracking = series.length > 0 && series[0]!.trackingConfidence >= reacquireThreshold;

  for (const frame of series) {
    if (tracking && frame.trackingConfidence < lossThreshold) {
      events.push({ kind: 'lost', timestamp: frame.timestamp, confidence: frame.trackingConfidence });
      tracking = false;
    } else if (!tracking && frame.trackingConfidence >= reacquireThreshold) {
      events.push({ kind: 'reacquired', timestamp: frame.timestamp, confidence: frame.trackingConfidence });
      tracking = true;
    }
  }

  return events;
}
