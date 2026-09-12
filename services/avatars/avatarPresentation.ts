import type { AvatarSemanticMode } from './engine/types';

/**
 * The one avatar-state projection.
 *
 * Avatar V10 is presentation only. It owns no conversation state, no speech
 * generation, no playback, no microphone and no entitlement. This module is the
 * single place where already-authoritative host state is turned into the
 * presentation the renderer and the engine are told about:
 *
 *   authoritative Elise processing state   (hooks/useStyleChat -> isSending)
 * + authoritative playback lifecycle        (stores/avatarSpeechStore)
 * + authoritative listening state           (see LISTENING below)
 * + accessibility state                     (hooks/useReducedMotion)
 * + available approved assets               (services/avatars/avatarAssetCoverage)
 *           |
 *           v
 *   AvatarPresentation  ->  renderer prop + engine semanticMode
 *
 * It is a pure function of its inputs: no store read, no clock, no React, no
 * timer, no network. That is what makes the priority contract reviewable in one
 * place and testable without a device.
 *
 * DERIVED, NOT A SECOND STATE MACHINE. Nothing here decides when Elise speaks,
 * thinks or stops; it only reads what the existing authorities already decided.
 */

/** The phase vocabulary of the authoritative playback store. */
export type AvatarPlaybackPhase =
  | 'idle'
  | 'requesting'
  | 'ready'
  | 'playing'
  | 'stopping'
  | 'error';

export type AvatarPresentationState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'fallback';

/** Renderer vocabulary of `components/stylist/AnimatedStylistAvatar`. */
export type AvatarRendererState = 'idle' | 'thinking' | 'speaking' | 'static';

/**
 * Why the projection resolved the way it did. Surfaced by the development-only
 * inspector and asserted by tests, so a wrong state is diagnosable rather than
 * merely visible.
 */
export type AvatarPresentationReason =
  | 'assets-unavailable'
  | 'playback-interrupted'
  | 'playback-active'
  | 'listening-active'
  | 'elise-processing'
  | 'no-activity';

export interface AvatarPresentationInput {
  /**
   * Authoritative playback phase, exactly as the store reports it. An unknown
   * or absent value is treated as no playback activity.
   */
  playbackPhase: AvatarPlaybackPhase | string | null | undefined;

  /**
   * Host-owned eligibility: whether the store's active utterance belongs to the
   * actor, session and stylist this surface is showing. The projection is never
   * given the identifiers needed to decide this for itself.
   */
  playbackScopeMatches: boolean;

  /**
   * The host's own read of "native playback is running", taken from the same
   * authoritative store. Both this and `playbackPhase` must agree before
   * SPEAKING is projected, so a malformed observation fails closed.
   */
  playbackActive: boolean;

  /**
   * Authoritative utterance identity (the speech generation counter owned by
   * `services/avatarSpeech.ts`). Carried through for diagnosis only — the
   * projection never keys presentation on message text, so two identical
   * replies are two utterances.
   */
  utteranceGeneration: number | null | undefined;

  /**
   * Authoritative Elise processing state: a turn has been sent and no reply has
   * arrived yet. Today that is `useStyleChat().isSending`.
   */
  eliseProcessing: boolean;

  /**
   * Authoritative listening state.
   *
   * MICROPHONE PERMISSION IS NEVER THIS, and neither is audio amplitude, a
   * mounted composer, or any other heuristic. Only a real capture-session
   * authority may set it. The Elise surface has no voice input today
   * (`VOICE_UI_ENABLED === false` in `components/style-chat/StyleChatInput.tsx`),
   * so its host passes `false`; the app's one live listening authority
   * (`hooks/useVoiceScan` -> `isListening`) governs the Voice Scan surface,
   * which renders no avatar.
   */
  listening: boolean;

  /** Accessibility: iOS Reduce Motion / Android Remove animations. */
  reduceMotion: boolean;

  /**
   * Whether this avatar's approved assets can draw a distinct speaking mouth.
   * False is a degradation, never a failure.
   */
  mouthCapable: boolean;

  /** False only when the avatar has no drawable approved base at all. */
  assetsAvailable: boolean;
}

export interface AvatarPresentation {
  state: AvatarPresentationState;

  /** What the renderer is asked to draw. */
  rendererState: AvatarRendererState;

  /**
   * What the engine is told. `undefined` leaves the engine to derive the mode
   * from the playback fields it already receives, which is what it does for
   * speaking and idle.
   */
  semanticMode: AvatarSemanticMode | undefined;

  /** True only while authoritative playback is running for this surface. */
  speaking: boolean;

  /** True when authoritative playback was cancelled or failed. */
  interrupted: boolean;

  /**
   * True when the state is SPEAKING but the face cannot show it — no approved
   * speaking frames, or Reduce Motion. The status channel then carries the
   * distinction instead.
   */
  speakingDegraded: boolean;

  /** Status-channel outputs, so IDLE is never indistinguishable from SPEAKING. */
  statusSpeaking: boolean;
  statusThinking: boolean;

  reason: AvatarPresentationReason;

  /** Echoed for the development-only inspector; never used for a decision. */
  utteranceGeneration: number | null;
}

const PLAYBACK_PHASES: ReadonlySet<string> = new Set<AvatarPlaybackPhase>([
  'idle',
  'requesting',
  'ready',
  'playing',
  'stopping',
  'error',
]);

/** An unrecognized phase is not an error and is never treated as activity. */
function normalizePhase(value: unknown): AvatarPlaybackPhase | 'unknown' {
  return typeof value === 'string' && PLAYBACK_PHASES.has(value)
    ? (value as AvatarPlaybackPhase)
    : 'unknown';
}

function normalizeGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Projects one presentation from authoritative host state.
 *
 * PRIORITY, highest first. Every rule below is a read of an authority, never an
 * inference:
 *
 *   1. FALLBACK      no drawable approved base asset.
 *   2. INTERRUPTED   playback was cancelled or failed for this surface.
 *   3. SPEAKING      playback is running for this surface.
 *   4. LISTENING     an authoritative capture session is live.
 *   5. THINKING      Elise is preparing a reply and playback is inactive.
 *   6. IDLE          none of the above.
 *
 * LISTENING outranks THINKING because a live capture session is a present user
 * action, while processing is work happening behind it; the pair cannot both be
 * true on any shipped surface today, and the order is fixed here rather than
 * left to whichever host reads them first.
 *
 * Reduce Motion never changes the state — a Reduce Motion user is still told
 * Elise is speaking — it only makes the renderer static and hands the
 * distinction to the status channel.
 */
export function deriveAvatarPresentation(input: AvatarPresentationInput): AvatarPresentation {
  const phase = normalizePhase(input?.playbackPhase);
  const scopeMatches = input?.playbackScopeMatches === true;
  const reduceMotion = input?.reduceMotion === true;
  const utteranceGeneration = normalizeGeneration(input?.utteranceGeneration);

  const assetsAvailable = input?.assetsAvailable !== false;
  const mouthCapable = input?.mouthCapable === true;

  // Both the host's boolean and the store's own phase must agree.
  const playing = input?.playbackActive === true && phase === 'playing' && scopeMatches;
  const interrupted = scopeMatches && (phase === 'stopping' || phase === 'error');
  const listening = input?.listening === true;
  const processing = input?.eliseProcessing === true;

  let state: AvatarPresentationState;
  let reason: AvatarPresentationReason;

  if (!assetsAvailable) {
    state = 'fallback';
    reason = 'assets-unavailable';
  } else if (interrupted) {
    state = 'interrupted';
    reason = 'playback-interrupted';
  } else if (playing) {
    state = 'speaking';
    reason = 'playback-active';
  } else if (listening) {
    state = 'listening';
    reason = 'listening-active';
  } else if (processing) {
    state = 'thinking';
    reason = 'elise-processing';
  } else {
    state = 'idle';
    reason = 'no-activity';
  }

  return {
    state,
    rendererState: resolveRendererState(state, reduceMotion),
    semanticMode: resolveSemanticMode(state),
    speaking: state === 'speaking',
    interrupted: state === 'interrupted',
    speakingDegraded: state === 'speaking' && (reduceMotion || !mouthCapable),
    statusSpeaking: state === 'speaking',
    statusThinking: state === 'thinking',
    reason,
    utteranceGeneration,
  };
}

/**
 * LISTENING and INTERRUPTED draw the approved base pose. No listening or
 * interrupted artwork exists, and inventing one is out of scope: the engine is
 * still told the real mode, so a future approved pose is a renderer change
 * alone.
 */
function resolveRendererState(
  state: AvatarPresentationState,
  reduceMotion: boolean,
): AvatarRendererState {
  if (reduceMotion) return 'static';
  if (state === 'fallback') return 'static';
  if (state === 'speaking') return 'speaking';
  if (state === 'thinking') return 'thinking';
  return 'idle';
}

/**
 * SPEAKING and IDLE are left undefined: the engine derives those from the
 * playback fields in the same snapshot, and asserting them here would give the
 * same decision two owners.
 */
function resolveSemanticMode(state: AvatarPresentationState): AvatarSemanticMode | undefined {
  if (state === 'thinking') return 'thinking';
  if (state === 'listening') return 'listening';
  if (state === 'interrupted') return 'interrupted';
  return undefined;
}
