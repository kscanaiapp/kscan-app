// Renderer-independent avatar motion contract.
//
// This module defines the single vocabulary shared by the motion controller,
// the discrete motion store, and any renderer adapter. It has no React,
// react-native, or renderer dependency, so it can be exercised directly under
// node:test and reused by a future renderer (round mouth, blink, brows, gaze)
// without changes to the controller.

import type { AvatarMouthState } from './avatarSpeechMotion';

export type AvatarMotionMode =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reacting'
  | 'interrupted';

export type AvatarEyeState = 'open' | 'halfOpen' | 'closed';

export type AvatarBrowState = 'neutral' | 'raised' | 'focused';

export type AvatarExpressionMode =
  | 'neutral'
  | 'warm'
  | 'confident'
  | 'thinking'
  | 'uncertain';

/** Normalized gaze target; {0,0} is straight ahead. Range [-1, 1] each axis. */
export interface AvatarGazeTarget {
  x: number;
  y: number;
}

/** Head pose in degrees. Restrained by MOTION_LIMITS; never theatrical. */
export interface AvatarHeadPose {
  pitchDeg: number;
  rollDeg: number;
  yawDeg: number;
}

export interface AvatarMotionState {
  mode: AvatarMotionMode;
  mouth: AvatarMouthState;
  eyes: AvatarEyeState;
  brows: AvatarBrowState;
  expression: AvatarExpressionMode;
  gaze: AvatarGazeTarget;
  head: AvatarHeadPose;
  /** Multiplicative breathing scale around 1.0 (e.g. 1.006 at inhale peak). */
  breathingScale: number;
  /** Vertical shoulder offset in logical pixels; positive is downward. */
  shoulderOffsetPx: number;
  /** Overall motion intensity multiplier in [0, 1]. */
  intensity: number;
  /** True only while native playback is actively reported as playing. */
  speaking: boolean;
  /** Speech/motion generation the state belongs to; stale values are inert. */
  generation: number;
  /** Controller-clock timestamp (ms) at which the state was produced. */
  timestampMs: number;
}

/**
 * Per-avatar animation capabilities. The authoritative per-preset values live
 * beside the avatar configuration; this contract only defines the shape and
 * the conservative default used when configuration is missing.
 */
export interface AvatarMotionCapabilities {
  threeStateMouth: boolean;
  roundMouth: boolean;
  blink: boolean;
  brows: boolean;
  gaze: boolean;
  headMotion: boolean;
  upperBodyMotion: boolean;
}

/** Fail-closed capability default: static portrait only. */
export const NO_MOTION_CAPABILITIES: AvatarMotionCapabilities = Object.freeze({
  threeStateMouth: false,
  roundMouth: false,
  blink: false,
  brows: false,
  gaze: false,
  headMotion: false,
  upperBodyMotion: false,
});

/** Restrained transform ceilings. Values outside these are clamped, never rendered. */
export const MOTION_LIMITS = {
  headPitchDeg: 2,
  headRollDeg: 2,
  headYawDeg: 2,
  breathingScaleMin: 0.995,
  breathingScaleMax: 1.01,
  shoulderOffsetPx: 2,
  gazeRange: 1,
} as const;

/**
 * Motion arbitration priority; higher wins. Reset/error handling sits above
 * every mode and is expressed as a controller action rather than a mode, so
 * `interrupted` is the highest schedulable mode.
 */
export const MOTION_MODE_PRIORITY: Readonly<Record<AvatarMotionMode, number>> = Object.freeze({
  interrupted: 60,
  speaking: 50,
  reacting: 40,
  thinking: 30,
  listening: 20,
  idle: 10,
});

export function compareMotionModePriority(a: AvatarMotionMode, b: AvatarMotionMode): number {
  return MOTION_MODE_PRIORITY[a] - MOTION_MODE_PRIORITY[b];
}

export const NEUTRAL_AVATAR_MOTION_STATE: AvatarMotionState = Object.freeze({
  mode: 'idle',
  mouth: 'closed',
  eyes: 'open',
  brows: 'neutral',
  expression: 'neutral',
  gaze: Object.freeze({ x: 0, y: 0 }),
  head: Object.freeze({ pitchDeg: 0, rollDeg: 0, yawDeg: 0 }),
  breathingScale: 1,
  shoulderOffsetPx: 0,
  intensity: 1,
  speaking: false,
  generation: 0,
  timestampMs: 0,
}) as AvatarMotionState;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min <= 0 && max >= 0 ? 0 : min;
  return Math.min(max, Math.max(min, value));
}

function clampBreathingScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return clamp(value, MOTION_LIMITS.breathingScaleMin, MOTION_LIMITS.breathingScaleMax);
}

/**
 * Clamp every numeric channel into the restrained approved range. Returns a
 * new object; the input is never mutated.
 */
export function clampAvatarMotionState(state: AvatarMotionState): AvatarMotionState {
  return {
    ...state,
    gaze: {
      x: clamp(state.gaze.x, -MOTION_LIMITS.gazeRange, MOTION_LIMITS.gazeRange),
      y: clamp(state.gaze.y, -MOTION_LIMITS.gazeRange, MOTION_LIMITS.gazeRange),
    },
    head: {
      pitchDeg: clamp(state.head.pitchDeg, -MOTION_LIMITS.headPitchDeg, MOTION_LIMITS.headPitchDeg),
      rollDeg: clamp(state.head.rollDeg, -MOTION_LIMITS.headRollDeg, MOTION_LIMITS.headRollDeg),
      yawDeg: clamp(state.head.yawDeg, -MOTION_LIMITS.headYawDeg, MOTION_LIMITS.headYawDeg),
    },
    breathingScale: clampBreathingScale(state.breathingScale),
    shoulderOffsetPx: clamp(
      state.shoulderOffsetPx,
      -MOTION_LIMITS.shoulderOffsetPx,
      MOTION_LIMITS.shoulderOffsetPx,
    ),
    intensity: clamp(state.intensity, 0, 1),
    generation: Number.isFinite(state.generation) ? Math.max(0, Math.floor(state.generation)) : 0,
    timestampMs: Number.isFinite(state.timestampMs) ? Math.max(0, state.timestampMs) : 0,
  };
}

export interface NormalizeAvatarMotionOptions {
  reducedMotion: boolean;
  capabilities: AvatarMotionCapabilities;
}

/**
 * Produce the renderable state for a target environment:
 *
 * - all numeric channels are clamped to the restrained range;
 * - capabilities the avatar does not support degrade to their neutral value
 *   (round mouth falls back to open, then the highest supported state);
 * - Reduce Motion zeroes every decorative channel and closes the mouth while
 *   preserving the semantic mode and speaking flag for textual status.
 *
 * The input state is never mutated.
 */
export function normalizeAvatarMotionState(
  state: AvatarMotionState,
  options: NormalizeAvatarMotionOptions,
): AvatarMotionState {
  const clamped = clampAvatarMotionState(state);
  const { capabilities, reducedMotion } = options;

  let mouth: AvatarMouthState = clamped.mouth;
  if (mouth === 'round' && !capabilities.roundMouth) mouth = 'open';
  if (!capabilities.threeStateMouth) mouth = 'closed';

  const normalized: AvatarMotionState = {
    ...clamped,
    mouth,
    eyes: capabilities.blink ? clamped.eyes : 'open',
    brows: capabilities.brows ? clamped.brows : 'neutral',
    gaze: capabilities.gaze ? clamped.gaze : { x: 0, y: 0 },
    head: capabilities.headMotion ? clamped.head : { pitchDeg: 0, rollDeg: 0, yawDeg: 0 },
    breathingScale: capabilities.upperBodyMotion ? clamped.breathingScale : 1,
    shoulderOffsetPx: capabilities.upperBodyMotion ? clamped.shoulderOffsetPx : 0,
  };

  if (!reducedMotion) return normalized;

  // Reduce Motion: no decorative motion of any kind. The mouth follows the
  // approved minimum policy (closed); mode and speaking survive so status
  // text and announcements remain correct.
  return {
    ...normalized,
    mouth: 'closed',
    eyes: 'open',
    brows: 'neutral',
    gaze: { x: 0, y: 0 },
    head: { pitchDeg: 0, rollDeg: 0, yawDeg: 0 },
    breathingScale: 1,
    shoulderOffsetPx: 0,
    intensity: 0,
  };
}

/** Structural equality over the discrete channels a renderer cares about. */
export function avatarMotionStatesEqual(a: AvatarMotionState, b: AvatarMotionState): boolean {
  return (
    a.mode === b.mode &&
    a.mouth === b.mouth &&
    a.eyes === b.eyes &&
    a.brows === b.brows &&
    a.expression === b.expression &&
    a.gaze.x === b.gaze.x &&
    a.gaze.y === b.gaze.y &&
    a.head.pitchDeg === b.head.pitchDeg &&
    a.head.rollDeg === b.head.rollDeg &&
    a.head.yawDeg === b.head.yawDeg &&
    a.breathingScale === b.breathingScale &&
    a.shoulderOffsetPx === b.shoulderOffsetPx &&
    a.intensity === b.intensity &&
    a.speaking === b.speaking &&
    a.generation === b.generation
  );
}
