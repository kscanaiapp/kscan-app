/**
 * K Scan Avatar Engine V10 — core value types.
 *
 * The engine core is host-neutral and platform-neutral: no React, React Native,
 * Expo, Supabase, ElevenLabs, environment variables, timers, clocks, asset
 * loaders, or rendering APIs. It calculates what the avatar should look like at
 * a host-supplied moment; it never decides when to speak, never plays audio,
 * and never owns application lifecycle.
 */

export type AvatarMouthState = 'closed' | 'halfOpen' | 'open' | 'round' | 'wide';
export type AvatarViseme = 'rest' | 'labial' | 'consonant' | 'open' | 'round' | 'wide';
export type AvatarSpeechPhase = 'idle' | 'requesting' | 'ready' | 'playing' | 'stopping' | 'error';
export type AvatarSemanticMode = 'idle' | 'listening' | 'thinking' | 'reacting' | 'speaking' | 'interrupted';
export type AvatarExpression = 'neutral' | 'warm' | 'confident' | 'thinking' | 'uncertain';
export type AvatarEyeState = 'open' | 'half' | 'closed';
export type AvatarBrowState = 'neutral' | 'raised' | 'focused';
export type AvatarGazeTarget = 'center' | 'composer' | 'message' | 'closet' | 'scanResult' | 'system';

// ── Alignment inputs ─────────────────────────────────────────────────────────
//
// Both shapes are accepted so the engine survives a provider change without a
// contract change. The current K Scan speech backend returns the character
// shape; the phoneme shape is accepted for forward compatibility only and is
// not produced anywhere in the app today.

export interface CharacterAlignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export interface PhonemeAlignmentEntry {
  phoneme: string;
  startSeconds: number;
  endSeconds: number;
}

export interface PhonemeAlignment {
  phonemes: PhonemeAlignmentEntry[];
}

export type AvatarSpeechAlignment = CharacterAlignment | PhonemeAlignment;

export type AlignmentDisposition =
  | 'missing'
  | 'empty'
  | 'usable'
  | 'partially-sanitized'
  | 'unusable';

export interface SpeechTimelineInterval {
  startSeconds: number;
  endSeconds: number;
  viseme: AvatarViseme;
  mouthState: AvatarMouthState;
}

export interface CompiledSpeechTimeline {
  intervals: readonly SpeechTimelineInterval[];
  totalDurationSeconds: number;
  source: 'character' | 'phoneme' | 'none';
  disposition: AlignmentDisposition;
  /** Provider intervals examined by the single alignment interpreter. */
  inputIntervalCount: number;
  /** Valid provider intervals retained before visual-state coalescing. */
  retainedIntervalCount: number;
  droppedIntervalCount: number;
  /** Wall-clock cost of compiling this timeline, for TIMELINE_COMPILE_MS. */
  compileMs: number;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export interface AvatarAssetCapabilities {
  base: boolean;
  mouthClosed: boolean;
  mouthHalfOpen: boolean;
  mouthOpen: boolean;
  mouthRound: boolean;
  mouthWide: boolean;
  eyes: boolean;
  brows: boolean;
  gaze: boolean;
  compositeMotion: boolean;
  tapAcknowledgement: boolean;
}

/**
 * The fail-closed capability set. Every derivation starts here and turns
 * individual channels on only against approved package evidence, so a missing,
 * malformed or partially-approved package can never enable a channel.
 */
export const STATIC_CAPABILITIES: AvatarAssetCapabilities = Object.freeze({
  base: true,
  mouthClosed: false,
  mouthHalfOpen: false,
  mouthOpen: false,
  mouthRound: false,
  mouthWide: false,
  eyes: false,
  brows: false,
  gaze: false,
  compositeMotion: false,
  tapAcknowledgement: false,
});

// ── Engine configuration ─────────────────────────────────────────────────────

export interface AvatarEngineConfig {
  /**
   * Anti-pop attack, expressed in playback milliseconds rather than wall-clock
   * milliseconds. Speech-driven state must never derive from engine elapsed
   * time, because a paused or stalled player would let it run on.
   */
  speechAttackPlaybackMs: number;
  transitionMs: number;
  pauseThresholdMs: number;
  microGapMergeMs: number;
  noiseIntervalMs: number;
  fallbackCycleMs: number;
  breathingCycleMs: number;
  breathingScaleAmplitude: number;
  headCycleMs: number;
  headTiltDegrees: number;
  blinkMinIntervalMs: number;
  blinkMaxIntervalMs: number;
  blinkClosedMs: number;
  blinkDoubleChance: number;
  blinkDoubleGapMs: number;
  tapCooldownMs: number;
  tapReactionMs: number;
  gazeMaxX: number;
  gazeMaxY: number;
  /**
   * KNOWN DEFERRED ENGINE ISSUE — blink during speech.
   *
   * V9 hard-coded `blinkEnabled = motion && caps.eyes && !speaking`, so the
   * avatar stopped blinking for the whole utterance. That is undesirable but is
   * deliberately NOT changed here: the first integration is mouth-only shadow
   * mode, and turning eyes on at the same time would mean debugging lip sync
   * and eye behaviour simultaneously. V10 keeps the identical behaviour but
   * makes it an explicit, testable policy flag instead of an inline condition,
   * so enabling it later is a one-line change with its own commit and tests.
   */
  blinkDuringSpeech: boolean;
}
