import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEDIAPIPE_POSE_LANDMARK_INDEX,
  mapMediaPipeLandmarksToBodyFrame,
  type MediaPipePoseLandmark,
} from '../bodyFrameMapping';

/** Builds a 33-slot landmark array with the given indices populated;
 *  everything else left undefined (absent). */
function landmarks(entries: Record<number, MediaPipePoseLandmark>): (MediaPipePoseLandmark | undefined)[] {
  const arr: (MediaPipePoseLandmark | undefined)[] = new Array(33).fill(undefined);
  for (const [index, value] of Object.entries(entries)) arr[Number(index)] = value;
  return arr;
}

const HIGH_CONF: Pick<MediaPipePoseLandmark, 'visibility' | 'presence'> = { visibility: 0.95, presence: 0.95 };

test('a fully-populated landmark set produces present landmarks for every field BodyFrame needs', () => {
  const input = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.nose]: { x: 0.5, y: 0.15, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.62, y: 0.28, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightShoulder]: { x: 0.38, y: 0.28, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftElbow]: { x: 0.68, y: 0.45, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightElbow]: { x: 0.32, y: 0.45, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftWrist]: { x: 0.7, y: 0.6, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightWrist]: { x: 0.3, y: 0.6, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftHip]: { x: 0.6, y: 0.6, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightHip]: { x: 0.4, y: 0.6, z: 0, ...HIGH_CONF },
  });

  const frame = mapMediaPipeLandmarksToBodyFrame(input, 1234, { cameraBufferConvention: 'raw' });

  assert.equal(frame.timestamp, 1234);
  assert.ok(frame.leftShoulder.present && frame.rightShoulder.present);
  assert.ok(frame.chestCenter.present);
  assert.ok(frame.waistCenter.present);
  assert.ok(frame.torsoCenter.present);
  assert.ok(typeof frame.torsoWidth === 'number' && frame.torsoWidth > 0);
  assert.ok(typeof frame.torsoHeight === 'number' && frame.torsoHeight > 0);
  assert.ok(frame.trackingConfidence > 0);
});

test('a landmark below the presence threshold is reported absent, not a low-confidence present value', () => {
  const input = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.62, y: 0.28, z: 0, visibility: 0.1, presence: 0.1 },
  });
  const frame = mapMediaPipeLandmarksToBodyFrame(input, 0, { cameraBufferConvention: 'raw' });
  assert.equal(frame.leftShoulder.present, false);
});

test('a landmark absent from the input array is reported absent, not defaulted to a guessed point', () => {
  const frame = mapMediaPipeLandmarksToBodyFrame(landmarks({}), 0, { cameraBufferConvention: 'raw' });
  assert.equal(frame.leftShoulder.present, false);
  assert.equal(frame.rightShoulder.present, false);
});

test('confidence is the MINIMUM of visibility and presence, not their average or max', () => {
  const input = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.6, y: 0.28, z: 0, visibility: 0.9, presence: 0.6 },
  });
  const frame = mapMediaPipeLandmarksToBodyFrame(input, 0, { cameraBufferConvention: 'raw' });
  assert.ok(frame.leftShoulder.present);
  if (frame.leftShoulder.present) assert.equal(frame.leftShoulder.confidence, 0.6);
});

test('raw-buffer convention mirrors the U coordinate; already-mirrored convention passes it through unchanged', () => {
  const input = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.7, y: 0.28, z: 0, ...HIGH_CONF },
  });
  const rawFrame = mapMediaPipeLandmarksToBodyFrame(input, 0, { cameraBufferConvention: 'raw' });
  const mirroredFrame = mapMediaPipeLandmarksToBodyFrame(input, 0, { cameraBufferConvention: 'already-mirrored' });
  assert.ok(rawFrame.leftShoulder.present && mirroredFrame.leftShoulder.present);
  if (rawFrame.leftShoulder.present && mirroredFrame.leftShoulder.present) {
    assert.ok(Math.abs(rawFrame.leftShoulder.point.u - (1 - 0.7)) < 1e-9);
    assert.ok(Math.abs(mirroredFrame.leftShoulder.point.u - 0.7) < 1e-9);
  }
});

test('the mirroring convention matches @kscan-live-vto/static-renderer\'s own selfie convention: '
  + 'the wearer\'s anatomical left shoulder ends up at lower u than the right, under the raw-buffer assumption', () => {
  // Facing the raw (unmirrored) sensor: the subject's anatomical LEFT
  // shoulder appears at the HIGHER x side of the raw frame (see
  // bodyFrameMapping.ts's CameraBufferConvention doc) -- x=0.62 here.
  // After mirroring for 'raw' convention, it must land at LOWER u than the
  // anatomical right shoulder (x=0.38 raw -> higher u after mirroring).
  const input = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.62, y: 0.28, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightShoulder]: { x: 0.38, y: 0.28, z: 0, ...HIGH_CONF },
  });
  const frame = mapMediaPipeLandmarksToBodyFrame(input, 0, { cameraBufferConvention: 'raw' });
  assert.ok(frame.leftShoulder.present && frame.rightShoulder.present);
  if (frame.leftShoulder.present && frame.rightShoulder.present) {
    assert.ok(
      frame.leftShoulder.point.u < frame.rightShoulder.point.u,
      `expected leftShoulder.u (${frame.leftShoulder.point.u}) < rightShoulder.u (${frame.rightShoulder.point.u})`,
    );
  }
});

test('torsoRotation is 0 for level shoulders and nonzero for tilted ones', () => {
  const level = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.62, y: 0.28, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightShoulder]: { x: 0.38, y: 0.28, z: 0, ...HIGH_CONF },
  });
  const levelFrame = mapMediaPipeLandmarksToBodyFrame(level, 0, { cameraBufferConvention: 'raw' });
  assert.equal(levelFrame.torsoRotation, 0);

  const tilted = landmarks({
    [MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder]: { x: 0.62, y: 0.32, z: 0, ...HIGH_CONF },
    [MEDIAPIPE_POSE_LANDMARK_INDEX.rightShoulder]: { x: 0.38, y: 0.24, z: 0, ...HIGH_CONF },
  });
  const tiltedFrame = mapMediaPipeLandmarksToBodyFrame(tilted, 0, { cameraBufferConvention: 'raw' });
  assert.notEqual(tiltedFrame.torsoRotation, 0);
});
