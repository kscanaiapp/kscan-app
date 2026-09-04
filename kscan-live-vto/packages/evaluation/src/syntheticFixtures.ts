/**
 * Synthetic BodyFrame sequence generator.
 *
 * Section 31: "Synthetic augmentation may support: lighting; noise;
 * compression; backgrounds. It does not replace real body diversity." And
 * Section 17: "Do not use customer images." No real camera, no
 * consenting human subject, and no device are available in this cloud
 * sandbox session (see docs/vto-phase1-status.md), so every sequence this
 * package can exercise today is synthetic BodyFrame data — deterministic,
 * seeded, and clearly marked `synthetic: true` on its
 * `GoldenSequenceManifest`. This is sufficient to build and correctness-test
 * the runner/metrics themselves; it is NOT evidence about real tracking
 * quality, real jitter, or real occlusion behavior, and must never be
 * cited as such in a Section 18 human review package.
 */

import type { BodyFrame, Landmark, Point2D } from '@kscan-live-vto/contract';
import { emptyBodyFrame } from '@kscan-live-vto/contract';

// Deterministic PRNG (mulberry32) so a "golden" sequence is byte-identical
// across runs — required for it to function as a regression fixture at all.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function present(point: Point2D, confidence: number): Landmark {
  return { present: true, point, confidence };
}

export interface CenteredStandingOptions {
  frameCount: number;
  frameRateHz: number;
  seed?: number;
  /** Standard deviation of per-frame Gaussian-ish jitter added to each landmark, in normalized [0,1] units. */
  jitterAmplitude?: number;
  /** [startFrame, endFrame) window, inclusive-exclusive, where tracking confidence drops and landmarks go absent, then recover — exercises Section 17's tracking-loss / tracking-reacquisition cases. */
  trackingLossWindow?: readonly [number, number];
}

/**
 * A centered, roughly-still standing pose with configurable jitter and an
 * optional tracking-loss window. Base landmark positions are a plausible
 * front-camera framing, not derived from any real capture.
 */
export function generateCenteredStandingSequence(options: CenteredStandingOptions): BodyFrame[] {
  const { frameCount, frameRateHz, seed = 1, jitterAmplitude = 0.003, trackingLossWindow } = options;
  const rand = mulberry32(seed);
  const noise = () => (rand() - 0.5) * 2 * jitterAmplitude;
  const intervalMs = 1000 / frameRateHz;

  const base = {
    headCenter: { u: 0.5, v: 0.15 },
    neckCenter: { u: 0.5, v: 0.22 },
    leftShoulder: { u: 0.38, v: 0.28 },
    rightShoulder: { u: 0.62, v: 0.28 },
    leftElbow: { u: 0.32, v: 0.45 },
    rightElbow: { u: 0.68, v: 0.45 },
    leftWrist: { u: 0.3, v: 0.6 },
    rightWrist: { u: 0.7, v: 0.6 },
    leftHip: { u: 0.4, v: 0.6 },
    rightHip: { u: 0.6, v: 0.6 },
  };

  const frames: BodyFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const timestamp = i * intervalMs;
    const inLossWindow = trackingLossWindow && i >= trackingLossWindow[0] && i < trackingLossWindow[1];

    if (inLossWindow) {
      frames.push({ ...emptyBodyFrame(timestamp), trackingConfidence: 0.05 });
      continue;
    }

    const jittered = (p: Point2D): Point2D => ({ u: p.u + noise(), v: p.v + noise() });

    frames.push({
      timestamp,
      headCenter: present(jittered(base.headCenter), 0.95),
      noseOrHeadDirection: present(jittered(base.headCenter), 0.9),
      neckCenter: present(jittered(base.neckCenter), 0.9),
      leftShoulder: present(jittered(base.leftShoulder), 0.95),
      rightShoulder: present(jittered(base.rightShoulder), 0.95),
      leftElbow: present(jittered(base.leftElbow), 0.9),
      rightElbow: present(jittered(base.rightElbow), 0.9),
      leftWrist: present(jittered(base.leftWrist), 0.85),
      rightWrist: present(jittered(base.rightWrist), 0.85),
      chestCenter: present(jittered({ u: 0.5, v: 0.4 }), 0.85),
      waistCenter: present(jittered({ u: 0.5, v: 0.58 }), 0.8),
      leftHip: present(jittered(base.leftHip), 0.85),
      rightHip: present(jittered(base.rightHip), 0.85),
      torsoCenter: present(jittered({ u: 0.5, v: 0.44 }), 0.9),
      torsoWidth: 0.24,
      torsoHeight: 0.32,
      torsoRotation: 0,
      trackingConfidence: 0.92,
    });
  }

  return frames;
}
