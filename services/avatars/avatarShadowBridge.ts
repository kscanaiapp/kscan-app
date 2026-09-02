/**
 * STATUS: TEST INSTRUMENTATION ONLY — NOT A PRODUCTION MODULE.
 *
 * Nothing in the app imports this. StyleChat calls the engine adapter
 * unconditionally and draws its frame; there is no shadow phase and no visual
 * migration gate any more (`avatarVisualMode.ts` was deleted for saying
 * otherwise). What survives here is the measurement surface that the engine's
 * regression suite asserts against — the stall/hold/replay protections, the
 * motion-epoch authority and the reset accounting in
 * `__tests__/avatarShadowMode.test.js`.
 *
 * It is retained deliberately rather than deleted with the gate: removing it
 * is a migration of those tests onto `adapter.metricsSnapshot()`, not a
 * dead-code deletion, and doing it blind would drop live coverage.
 */
import type { AvatarSpeechState } from '../../stores/avatarSpeechStore';
import type { AvatarMouthState as LegacyAvatarMouthState } from '../avatarSpeechMotion';
import type { AvatarFrameReason } from './engine/contract';
import type { AvatarEngineMetricsSnapshot } from './engine/instrumentation/metrics';
import { getAvatarEngineAdapter } from './avatarEngineAdapter';

/**
 * Sarah shadow-mode observer.
 *
 * Shadow mode runs the legacy visual calculation and V10 against ONE runtime
 * snapshot and records both, so the two interpretations of the same real speech
 * clock can be compared without V10 touching a pixel:
 *
 *   one message, one speech request, one alignment, one audio player,
 *   one playback clock, one generation, one motion epoch
 *                                │
 *                    ┌───────────┴───────────┐
 *                    ↓                       ↓
 *              legacy result            V10 result
 *              (rendered)               (recorded, discarded)
 *
 * This module adds no subscription, holds no speech state of its own, and reads
 * only values the host already computed. It is the observer for the experiment;
 * it is not a second runtime.
 *
 * Everything recorded is a number or a fixed enum name. No speech text,
 * alignment character, audio, voice id, token or user identifier can reach it.
 */

/** The speech fields the observer reads, in the store's own shape. */
export type ShadowSpeechInput = Pick<
  AvatarSpeechState,
  'avatarId' | 'generation' | 'phase' | 'playbackSeconds' | 'alignment'
>;

export interface AvatarShadowObservation {
  avatarId: string | null;
  speech: ShadowSpeechInput;
  /** Host-owned eligibility, already decided by the surface. */
  scopeMatches: boolean;
  reduceMotion: boolean;
  foreground: boolean;
  motionEpoch: number;
  hostNowMs: number;
  /** What the legacy path decided for this same moment, and is rendering. */
  legacyMouthState: LegacyAvatarMouthState;
}

export interface ShadowUtteranceRecord {
  speechGeneration: number;
  /**
   * Host-observed audio startup latency: wall-clock ms from the store first
   * reporting `ready` to it first reporting `playing`.
   *
   * This is the number that must be UNCHANGED between a LEGACY run and a
   * V10_SHADOW run. The engine is structurally off the audio path, so any
   * movement here is the signal to reject the integration outright.
   */
  audioStartMs: number | null;
  /** Playback position, in ms, at which each path first left `closed`. */
  legacyFirstMouthMs: number | null;
  v10FirstMouthMs: number | null;
  legacyTransitions: number;
  v10Transitions: number;
  /** Observed playback span, used to derive transitions per second. */
  playbackSpanSeconds: number;
  legacyAnimated: boolean;
  v10Animated: boolean;
  /** Frames where both paths named the same mouth state. */
  agreements: number;
  comparisons: number;
  completed: boolean;
  interrupted: boolean;
}

export interface AvatarShadowReport {
  engine: AvatarEngineMetricsSnapshot;
  observations: number;
  utterances: ShadowUtteranceRecord[];
  legacy: {
    resets: { completion: number; interruption: number; newUtterance: number };
    transitionsPerSecond: number | null;
    playbackToFirstMouthMs: number | null;
  };
  v10: {
    transitionsPerSecond: number | null;
    playbackToFirstMouthMs: number | null;
    /** Fraction of compared frames where both paths agreed, 0..1. */
    agreementRate: number | null;
    /** Every frame reason seen, with counts. Enum names only. */
    frameReasons: Partial<Record<AvatarFrameReason, number>>;
    staleFrameRejections: number;
    calculationErrors: number;
    neutralFrames: number;
  };
  /**
   * True once a SECOND distinct utterance has animated. A repeat that never
   * animates is the classic symptom of a reset locking out the next generation.
   */
  repeatUtterancePasses: boolean;
}

/** A long StyleChat session must not grow this without bound. */
const MAX_UTTERANCE_RECORDS = 50;

let observations = 0;
let utterances: ShadowUtteranceRecord[] = [];
let current: ShadowUtteranceRecord | null = null;

let previousPhase: AvatarSpeechState['phase'] = 'idle';
let previousGeneration = -1;
let previousLegacyMouth: LegacyAvatarMouthState = 'closed';
let previousV10Mouth: string = 'closed';
let firstPlaybackSeconds: number | null = null;
let lastPlaybackSeconds = 0;
let readyAtMs: number | null = null;

const legacyResets = { completion: 0, interruption: 0, newUtterance: 0 };
const frameReasons: Partial<Record<AvatarFrameReason, number>> = {};
let neutralFrames = 0;

function startUtterance(generation: number): void {
  if (current) archiveCurrent();
  current = {
    speechGeneration: generation,
    audioStartMs: null,
    legacyFirstMouthMs: null,
    v10FirstMouthMs: null,
    legacyTransitions: 0,
    v10Transitions: 0,
    playbackSpanSeconds: 0,
    legacyAnimated: false,
    v10Animated: false,
    agreements: 0,
    comparisons: 0,
    completed: false,
    interrupted: false,
  };
  previousLegacyMouth = 'closed';
  previousV10Mouth = 'closed';
  firstPlaybackSeconds = null;
  lastPlaybackSeconds = 0;
  readyAtMs = null;
}

function archiveCurrent(): void {
  if (!current) return;
  utterances.push(current);
  if (utterances.length > MAX_UTTERANCE_RECORDS) utterances.shift();
  current = null;
}

/**
 * Records one moment.
 *
 * Called from a post-render effect, never from render itself: in shadow mode
 * the visible legacy path must not pay for V10's calculation, and nothing here
 * may sit between the host and what it draws.
 */
export function observeAvatarShadowFrame(input: AvatarShadowObservation): void {
  observations += 1;

  const speech = input.speech;
  const generation = speech.generation;
  const phase = speech.phase;

  // Legacy-side lifecycle, observed rather than owned. The store's own
  // transitions are the source of truth for both paths.
  if (generation !== previousGeneration && phase !== 'idle') {
    legacyResets.newUtterance += 1;
    startUtterance(generation);
  }
  // Audio startup latency, measured from the host's own lifecycle rather than
  // from anything the engine does.
  if (phase === 'ready' && readyAtMs === null) readyAtMs = input.hostNowMs;
  if (previousPhase !== 'playing' && phase === 'playing' && current && current.audioStartMs === null) {
    current.audioStartMs = readyAtMs === null ? null : Math.max(0, input.hostNowMs - readyAtMs);
  }

  if (previousPhase === 'playing' && phase === 'idle') {
    legacyResets.completion += 1;
    if (current) current.completed = true;
    archiveCurrent();
  }
  if (previousPhase === 'playing' && (phase === 'stopping' || phase === 'error')) {
    legacyResets.interruption += 1;
    if (current) current.interrupted = true;
    archiveCurrent();
  }
  previousPhase = phase;
  previousGeneration = generation;

  // One engine calculation from the same snapshot the legacy path just used.
  const result = getAvatarEngineAdapter().computeFrame({
    avatarId: input.avatarId,
    speech,
    scopeMatches: input.scopeMatches,
    reduceMotion: input.reduceMotion,
    foreground: input.foreground,
    motionEpoch: input.motionEpoch,
    hostNowMs: input.hostNowMs,
  });

  const reason = result.frame.diagnostics.reason;
  frameReasons[reason] = (frameReasons[reason] ?? 0) + 1;
  if (result.frame.diagnostics.neutral) neutralFrames += 1;

  if (!current) {
    previousLegacyMouth = input.legacyMouthState;
    previousV10Mouth = result.mouthState;
    return;
  }

  const playing = phase === 'playing';
  if (playing && Number.isFinite(speech.playbackSeconds)) {
    if (firstPlaybackSeconds === null) firstPlaybackSeconds = speech.playbackSeconds;
    lastPlaybackSeconds = Math.max(lastPlaybackSeconds, speech.playbackSeconds);
    current.playbackSpanSeconds = Math.max(0, lastPlaybackSeconds - firstPlaybackSeconds);
  }

  if (input.legacyMouthState !== previousLegacyMouth) {
    current.legacyTransitions += 1;
    previousLegacyMouth = input.legacyMouthState;
  }
  if (result.mouthState !== previousV10Mouth) {
    current.v10Transitions += 1;
    previousV10Mouth = result.mouthState;
  }

  if (playing) {
    const playbackMs = Math.max(0, speech.playbackSeconds * 1000);
    if (input.legacyMouthState !== 'closed') {
      current.legacyAnimated = true;
      if (current.legacyFirstMouthMs === null) current.legacyFirstMouthMs = playbackMs;
    }
    if (result.mouthState !== 'closed') {
      current.v10Animated = true;
      if (current.v10FirstMouthMs === null) current.v10FirstMouthMs = playbackMs;
    }
    current.comparisons += 1;
    if (result.mouthState === input.legacyMouthState) current.agreements += 1;
  }
}

export function getAvatarShadowReport(): AvatarShadowReport {
  const engine = getAvatarEngineAdapter().metricsSnapshot();
  const all = current ? [...utterances, current] : [...utterances];

  const totalSpan = all.reduce((sum, record) => sum + record.playbackSpanSeconds, 0);
  const legacyTransitions = all.reduce((sum, record) => sum + record.legacyTransitions, 0);
  const v10Transitions = all.reduce((sum, record) => sum + record.v10Transitions, 0);
  const comparisons = all.reduce((sum, record) => sum + record.comparisons, 0);
  const agreements = all.reduce((sum, record) => sum + record.agreements, 0);

  const legacyFirst = all.map((r) => r.legacyFirstMouthMs).filter((v): v is number => v !== null);
  const v10First = all.map((r) => r.v10FirstMouthMs).filter((v): v is number => v !== null);

  return {
    engine,
    observations,
    utterances: all.map((record) => ({ ...record })),
    legacy: {
      resets: { ...legacyResets },
      transitionsPerSecond: totalSpan > 0 ? legacyTransitions / totalSpan : null,
      playbackToFirstMouthMs: legacyFirst.length ? average(legacyFirst) : null,
    },
    v10: {
      transitionsPerSecond: totalSpan > 0 ? v10Transitions / totalSpan : null,
      playbackToFirstMouthMs: v10First.length ? average(v10First) : null,
      agreementRate: comparisons > 0 ? agreements / comparisons : null,
      frameReasons: { ...frameReasons },
      staleFrameRejections: engine.counters.STALE_FRAME_REJECTIONS,
      calculationErrors: engine.counters.CALCULATION_ERRORS,
      neutralFrames,
    },
    // Two distinct generations that each animated proves a completed utterance
    // did not lock the next one out.
    repeatUtterancePasses:
      new Set(all.filter((record) => record.v10Animated).map((record) => record.speechGeneration)).size >= 2,
  };
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function resetAvatarShadowBridgeForTests(): void {
  observations = 0;
  utterances = [];
  current = null;
  previousPhase = 'idle';
  previousGeneration = -1;
  previousLegacyMouth = 'closed';
  previousV10Mouth = 'closed';
  firstPlaybackSeconds = null;
  lastPlaybackSeconds = 0;
  readyAtMs = null;
  legacyResets.completion = 0;
  legacyResets.interruption = 0;
  legacyResets.newUtterance = 0;
  neutralFrames = 0;
  for (const key of Object.keys(frameReasons)) delete frameReasons[key as AvatarFrameReason];
  getAvatarEngineAdapter().resetMetrics();
}
