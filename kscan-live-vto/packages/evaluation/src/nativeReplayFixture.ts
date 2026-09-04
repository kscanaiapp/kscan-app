/**
 * Native replay fixture format — emulator-native validation lane, Section 3.
 *
 * The directive's frame-source rule: "The frame enters the native pipeline
 * directly. Do not route fixture frames through JS merely because the
 * environment lacks a physical camera." This file is NOT that native-side
 * consumption — it cannot be, from a Node sandbox with no native runtime.
 * It is the CONTRACT for the fixture a `NATIVE_REPLAY_FIXTURE` frame source
 * would read entirely on the native side, plus a validator, so:
 *
 * 1. the native Swift/Kotlin replay adapter (native/ios and native/android's
 *    LiveVTOReplaySource files) has an exact, versioned shape to parse, the
 *    same relationship this
 *    package's other reference modules already have to their native ports;
 * 2. this format's round-trip correctness (serialize → parse → identical
 *    BodyFrame series) can be proven in Node today, which is real evidence
 *    even though native consumption of it is not.
 *
 * `frameSource` is always `'NATIVE_REPLAY_FIXTURE'` in an instance of this
 * type — camera-sourced frames (`EMULATOR_CAMERA`, `SIMULATOR_CAMERA`) are
 * produced live by the native capture session and never round-trip through
 * this JSON shape, so a fixture built here can never be mistaken for a real
 * camera capture. See `docs/vto-native-device-handoff.md`'s emulator-lane
 * section for the three-value `FrameSource` enum this name is drawn from.
 */

import { isLandmarkPresent, type BodyFrame } from '@kscan-live-vto/contract';

export const NATIVE_REPLAY_FRAME_SOURCE = 'NATIVE_REPLAY_FIXTURE' as const;

export interface NativeReplayFixtureManifest {
  fixtureId: string;
  frameSource: typeof NATIVE_REPLAY_FRAME_SOURCE;
  /** What these frames stand in for, e.g. "synthetic centered-standing sequence, seed 7" — never a claim of real capture. */
  sourceDescription: string;
  nominalFrameRateHz: number;
  frameCount: number;
  /** True for procedurally-generated BodyFrame series; false once real device-captured landmarks back this fixture. */
  synthetic: boolean;
  formatVersion: 1;
}

export interface NativeReplayFixture {
  manifest: NativeReplayFixtureManifest;
  frames: readonly BodyFrame[];
}

export function buildNativeReplayFixture(
  frames: readonly BodyFrame[],
  meta: Omit<NativeReplayFixtureManifest, 'frameCount' | 'frameSource' | 'formatVersion'>,
): NativeReplayFixture {
  return {
    manifest: { ...meta, frameSource: NATIVE_REPLAY_FRAME_SOURCE, frameCount: frames.length, formatVersion: 1 },
    frames,
  };
}

export function serializeNativeReplayFixture(fixture: NativeReplayFixture): string {
  return JSON.stringify(fixture, null, 2);
}

export interface ReplayFixtureValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation only — the same discipline
 * `validateKsgarmentManifest` (garment-contract) applies to `.ksgarment`
 * bundles. Catches a fixture that would silently mislead a lifecycle-machine
 * run (wrong frame count, non-monotonic timestamps, a frame with no minimal
 * pose data at all) before it produces a misleadingly clean report.
 */
export function validateNativeReplayFixture(fixture: unknown): ReplayFixtureValidationResult {
  const errors: string[] = [];
  const f = fixture as Partial<NativeReplayFixture> | null;

  if (!f || typeof f !== 'object') {
    return { ok: false, errors: ['fixture is not an object'] };
  }
  if (!f.manifest || f.manifest.frameSource !== NATIVE_REPLAY_FRAME_SOURCE) {
    errors.push(`manifest.frameSource must be "${NATIVE_REPLAY_FRAME_SOURCE}"`);
  }
  if (!Array.isArray(f.frames)) {
    errors.push('frames must be an array');
    return { ok: false, errors };
  }
  if (f.manifest && f.frames.length !== f.manifest.frameCount) {
    errors.push(`manifest.frameCount (${f.manifest.frameCount}) does not match frames.length (${f.frames.length})`);
  }

  let previousTimestamp = -Infinity;
  f.frames.forEach((frame, i) => {
    if (typeof frame.timestamp !== 'number') {
      errors.push(`frame ${i}: missing numeric timestamp`);
      return;
    }
    if (frame.timestamp <= previousTimestamp) {
      errors.push(`frame ${i}: timestamp ${frame.timestamp} is not strictly increasing (previous ${previousTimestamp})`);
    }
    previousTimestamp = frame.timestamp;

    if (typeof frame.trackingConfidence !== 'number') {
      errors.push(`frame ${i}: missing numeric trackingConfidence`);
    }
    const hasAnyLandmark = isLandmarkPresent(frame.leftShoulder) || isLandmarkPresent(frame.rightShoulder);
    if (frame.trackingConfidence !== undefined && frame.trackingConfidence > 0.5 && !hasAnyLandmark) {
      errors.push(`frame ${i}: trackingConfidence ${frame.trackingConfidence} but no shoulder landmark is present`);
    }
  });

  return { ok: errors.length === 0, errors };
}

export function parseNativeReplayFixture(json: string): NativeReplayFixture {
  const parsed: unknown = JSON.parse(json);
  const result = validateNativeReplayFixture(parsed);
  if (!result.ok) {
    throw new Error(`invalid native replay fixture: ${result.errors.join('; ')}`);
  }
  return parsed as NativeReplayFixture;
}
