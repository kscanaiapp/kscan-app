/**
 * Golden-sequence runner — Section 17.
 *
 * "Every meaningful engine change should run applicable golden sequences."
 * This composes the individual metric functions in metrics.ts into one
 * report per sequence. It does not itself judge PASS/FAIL — Section 18
 * requires a human verdict for any hard visual gate, and this report is
 * exactly the "key metrics" attachment that protocol calls for, not a
 * replacement for it.
 */

import type { BodyFrame, BodyFrameLandmarkKey } from '@kscan-live-vto/contract';
import type { GoldenSequenceManifest } from './fixtureManifest';
import {
  detectTrackingEvents,
  droppedFrames,
  landmarkJitter,
  trackingConfidenceStats,
  type DroppedFrameResult,
  type JitterResult,
  type TrackingConfidenceStats,
  type TrackingEvent,
} from './metrics';

const DEFAULT_JITTER_LANDMARKS: readonly BodyFrameLandmarkKey[] = [
  'leftShoulder',
  'rightShoulder',
  'leftHip',
  'rightHip',
  'leftWrist',
  'rightWrist',
];

export interface GoldenSequenceReport {
  sequenceId: string;
  category: GoldenSequenceManifest['category'];
  synthetic: boolean;
  frameCount: number;
  trackingConfidence: TrackingConfidenceStats;
  droppedFrames: DroppedFrameResult;
  trackingEvents: TrackingEvent[];
  landmarkJitter: Partial<Record<BodyFrameLandmarkKey, JitterResult>>;
}

export function runGoldenSequence(
  manifest: GoldenSequenceManifest,
  frames: readonly BodyFrame[],
  options: { jitterLandmarks?: readonly BodyFrameLandmarkKey[] } = {},
): GoldenSequenceReport {
  const jitterLandmarks = options.jitterLandmarks ?? DEFAULT_JITTER_LANDMARKS;
  const jitter: Partial<Record<BodyFrameLandmarkKey, JitterResult>> = {};
  for (const key of jitterLandmarks) {
    jitter[key] = landmarkJitter(frames, key);
  }

  return {
    sequenceId: manifest.sequenceId,
    category: manifest.category,
    synthetic: manifest.synthetic,
    frameCount: frames.length,
    trackingConfidence: trackingConfidenceStats(frames),
    droppedFrames: droppedFrames(
      frames.map((f) => f.timestamp),
      manifest.nominalFrameRateHz,
    ),
    trackingEvents: detectTrackingEvents(frames),
    landmarkJitter: jitter,
  };
}

export function runGoldenSequences(
  sequences: readonly { manifest: GoldenSequenceManifest; frames: readonly BodyFrame[] }[],
  options?: { jitterLandmarks?: readonly BodyFrameLandmarkKey[] },
): GoldenSequenceReport[] {
  return sequences.map((s) => runGoldenSequence(s.manifest, s.frames, options));
}
