/**
 * K Scan Avatar Engine V10 — versioned public contract.
 *
 * This file is the whole agreement between K Scan and the engine. Everything
 * the host supplies enters through `AvatarSpeechRuntimeSnapshot`; everything
 * the engine answers leaves through `AvatarVisualFrame`. No K Scan store, hook,
 * component or service type may appear here, so the speech implementation,
 * audio implementation, renderer and even the target device can all change
 * without the engine changing.
 *
 * The contract is versioned because the frame is expected to grow. Facial
 * channels ship now; `body` is reserved so a later upper-body / gesture / pose
 * capability can be added as an OPTIONAL channel without another negotiation
 * with the Speech Manager. Consumers must treat unknown optional channels as
 * absent rather than as an error.
 */

import type {
  AlignmentDisposition,
  AvatarBrowState,
  AvatarExpression,
  AvatarEyeState,
  AvatarGazeTarget,
  AvatarMouthState,
  AvatarSemanticMode,
  AvatarSpeechAlignment,
  AvatarSpeechPhase,
} from './types';

/**
 * Incremented only for a breaking change to the shapes below. Additive optional
 * fields do not bump it; a renamed, removed or retyped field does.
 */
export const AVATAR_ENGINE_CONTRACT_VERSION = 2 as const;
export type AvatarEngineContractVersion = typeof AVATAR_ENGINE_CONTRACT_VERSION;

// ── Host → engine ────────────────────────────────────────────────────────────

/**
 * One immutable observation of the host's authoritative runtime.
 *
 * Every field is a plain value. Stores, React state objects, players and
 * subscriptions are deliberately not representable here: the engine consumes
 * K Scan's authorities, it never holds them.
 */
export interface AvatarSpeechRuntimeSnapshot {
  avatarId: string;

  /**
   * The host's speech-generation counter. Owned by `services/avatarSpeech.ts`;
   * the engine only compares it. Distinct from `motionEpoch` — see below.
   */
  speechGeneration: number;

  phase: AvatarSpeechPhase;
  playing: boolean;

  /**
   * Native playback position. This is the ONLY time source for speech-driven
   * facial state. The engine never starts a clock to approximate it.
   */
  playbackPositionSeconds: number;

  /**
   * False when the host currently has no trustworthy position — before the
   * first progress callback, or across a native stall. The engine then holds
   * its last known position instead of treating the gap as a seek to zero,
   * which would visibly replay the utterance from the beginning.
   */
  playbackAvailable: boolean;

  /** Optional; the current expo-audio progress callback does not carry it. */
  durationSeconds?: number;

  alignment?: AvatarSpeechAlignment | null;

  /**
   * Host wall-clock milliseconds, monotonic within a session.
   *
   * Used ONLY for decorative idle channels — breathing, head drift, blink
   * cadence, tap cooldown — which must keep running when nothing is being
   * spoken. Speech-driven state never reads it. Keeping the two time sources
   * separate is what prevents lip sync from drifting against the audio when the
   * host ticks irregularly or playback stalls.
   */
  hostNowMs: number;

  foreground: boolean;
  reduceMotion: boolean;

  /**
   * Visual invalidation counter, incremented by the host on avatar switch,
   * session switch, route change or teardown. Bumping it must never disturb
   * `speechGeneration`, and a repeated bump must never lock out the next
   * legitimate utterance.
   */
  motionEpoch: number;

  /** Host-owned visual gates. The engine never reads a feature flag itself. */
  motionEnabled: boolean;
  lipSyncEnabled: boolean;

  /** Optional conversational state, supplied explicitly rather than inferred. */
  semanticMode?: AvatarSemanticMode;
  gazeTarget?: AvatarGazeTarget;
  emphasis?: boolean;
  uncertainty?: boolean;
  interrupted?: boolean;
}

// ── Engine → host ────────────────────────────────────────────────────────────

export interface AvatarMouthTransition {
  from: AvatarMouthState;
  to: AvatarMouthState;
  progress: number;
  durationMs: number;
}

export interface AvatarGazeVector {
  x: number;
  y: number;
  target: AvatarGazeTarget;
}

export interface AvatarHeadMotion {
  rotateDeg: number;
  translateX: number;
  translateY: number;
}

export interface AvatarBreathingState {
  scale: number;
  phase: number;
}

/**
 * Reserved extension channel. Nothing populates this today and no renderer is
 * required to consume it; it exists so adding upper-body, pose, gesture, hand
 * or shoulder output later is an additive change to an optional field rather
 * than a new contract version negotiated through the Speech Manager again.
 */
export interface AvatarBodyChannels {
  pose?: string;
  gesture?: string;
  shoulderOffset?: number;
}

export type AvatarFrameReason =
  | 'disposed'
  | 'background'
  | 'reduced-motion'
  | 'interrupted'
  | 'stale-generation'
  | 'stale-epoch'
  | 'avatar-mismatch'
  | 'calculation-error'
  | 'static'
  | 'speaking-alignment'
  | 'speaking-fallback'
  | 'speaking-empty-alignment'
  | 'idle-motion'
  | 'semantic-motion';

export interface AvatarFrameDiagnostics {
  reason: AvatarFrameReason;
  generationAccepted: boolean;
  timelineDisposition: AlignmentDisposition;
  droppedAlignmentIntervals: number;
  fallbackUsed: boolean;
  /** True when the frame is the neutral fail-closed output. */
  neutral: boolean;
}

/**
 * The engine's answer for one moment. It is pure description — no JSX, no view
 * handles, no asset references — so the same frame can drive React Native
 * images today and Skia, a native animator, a 3D rig or a smart-glasses
 * renderer later without changing the engine.
 */
export interface AvatarVisualFrame {
  contractVersion: AvatarEngineContractVersion;

  /**
   * Frame identity. A renderer must drop any frame whose triple does not match
   * what it currently expects, which is what keeps a late callback from an
   * abandoned utterance or a previous avatar off the screen.
   */
  avatarId: string;
  speechGeneration: number;
  motionEpoch: number;

  mouthState: AvatarMouthState;
  mouthTransition: AvatarMouthTransition | null;
  eyeState: AvatarEyeState;
  browState: AvatarBrowState;

  expressionState?: AvatarExpression;
  gazeState?: AvatarGazeVector;

  headMotion: AvatarHeadMotion;
  breathing: AvatarBreathingState;

  /** Reserved; always absent in V10. */
  body?: AvatarBodyChannels;

  isSpeaking: boolean;
  shouldRenderMouth: boolean;
  shouldRenderEyes: boolean;
  shouldRenderBrows: boolean;
  tapAcknowledgementActive: boolean;

  diagnostics: AvatarFrameDiagnostics;
}

/** What a renderer must currently expect for a frame to be applicable. */
export interface AvatarFrameExpectation {
  avatarId: string;
  speechGeneration: number;
  motionEpoch: number;
}

/**
 * Frame admission test. Kept in the contract rather than in the renderer so
 * every present and future surface applies exactly the same staleness rule.
 */
export function isFrameApplicable(
  frame: AvatarVisualFrame | null | undefined,
  expected: AvatarFrameExpectation,
): boolean {
  if (!frame) return false;
  return (
    frame.avatarId === expected.avatarId &&
    frame.speechGeneration === expected.speechGeneration &&
    frame.motionEpoch === expected.motionEpoch
  );
}
