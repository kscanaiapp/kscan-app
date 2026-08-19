import type { AvatarSpeechState } from '../../stores/avatarSpeechStore';
import type { AvatarMouthState as LegacyAvatarMouthState } from '../avatarSpeechMotion';
import type {
  AvatarSemanticMode,
  AvatarGazeTarget,
} from './engine/types';
import type {
  AvatarSpeechRuntimeSnapshot,
  AvatarVisualFrame,
} from './engine/contract';
import { isFrameApplicable } from './engine/contract';
import { AvatarRuntime } from './engine/runtime/AvatarRuntime';
import {
  AvatarEngineMetricsCollector,
  type AvatarEngineMetricsSnapshot,
} from './engine/instrumentation/metrics';
import { resolveAvatarPackage } from './avatarEnginePackages';

/**
 * K Scan host adapter for Avatar Engine V10.
 *
 * This is the whole integration surface. It reads the host's authoritative
 * state, normalizes it into one immutable engine snapshot, invokes the engine,
 * rejects any frame that no longer matches what the host expects, and
 * translates the surviving frame into something the current renderer can draw.
 *
 * It deliberately does NOT request speech, start or stop audio, touch Supabase
 * or ElevenLabs, own AppState, read StyleChat messages, own navigation, or
 * decide whether a message is eligible to be spoken. Those authorities stay
 * exactly where they are, and the adapter only observes them — which is what
 * keeps the engine off the audio critical path entirely.
 */

/** The speech fields the adapter reads. Deliberately narrower than the store. */
export type AvatarEngineSpeechInput = Pick<
  AvatarSpeechState,
  'avatarId' | 'generation' | 'phase' | 'playbackSeconds' | 'alignment'
>;

export interface AvatarEngineHostInput {
  /** The avatar currently on screen, owned by stylist identity. */
  avatarId: string | null;

  speech: AvatarEngineSpeechInput;

  /**
   * Host-owned speech eligibility: whether the store's active utterance belongs
   * to the actor, session and stylist this surface is showing. The engine is
   * never given the identifiers needed to decide this for itself.
   */
  scopeMatches: boolean;

  reduceMotion: boolean;
  foreground: boolean;

  /** Visual invalidation counter owned by the host surface. */
  motionEpoch: number;

  /** Host wall clock. Decorative idle channels only — never lip sync. */
  hostNowMs: number;

  motionEnabled?: boolean;
  lipSyncEnabled?: boolean;
  semanticMode?: AvatarSemanticMode;
  gazeTarget?: AvatarGazeTarget;
  emphasis?: boolean;
  uncertainty?: boolean;
}

export interface AvatarEngineFrameResult {
  frame: AvatarVisualFrame;
  /**
   * The engine's mouth answer expressed in the renderer's current vocabulary.
   * `closed` whenever the frame was rejected as stale, so a dropped frame can
   * never leave an open mouth on screen.
   */
  mouthState: LegacyAvatarMouthState;
  /** False when the frame failed the identity check and was not applied. */
  applied: boolean;
}

export interface AvatarEngineAdapterOptions {
  metrics?: AvatarEngineMetricsCollector;
  /**
   * Monotonic clock for instrumentation only. Defaults to `Date.now`, which is
   * a host decision: the engine itself has no clock and produces identical
   * frames whether or not this is supplied.
   */
  now?: () => number;
}

/** 'wide' is an engine state no shipped K Scan package can draw yet. */
function toRendererMouthState(frame: AvatarVisualFrame): LegacyAvatarMouthState {
  switch (frame.mouthState) {
    case 'halfOpen':
      return 'halfOpen';
    case 'open':
      return 'open';
    case 'round':
      return 'round';
    case 'wide':
      return 'open';
    case 'closed':
    default:
      return 'closed';
  }
}

export class AvatarEngineHostAdapter {
  private readonly metrics: AvatarEngineMetricsCollector;
  private readonly now: () => number;
  private readonly runtime: AvatarRuntime;
  private loadedAvatarId: string | null = null;
  private previousPhase: AvatarEngineSpeechInput['phase'] = 'idle';
  private previousGeneration = -1;

  constructor(options: AvatarEngineAdapterOptions = {}) {
    this.metrics = options.metrics ?? new AvatarEngineMetricsCollector();
    this.now = options.now ?? (() => Date.now());
    this.runtime = new AvatarRuntime({ metrics: this.metrics, now: this.now });
  }

  /**
   * Calculates one frame from host state.
   *
   * Synchronous, allocation-light and never throwing: the engine's own
   * fail-closed guard turns any internal defect into a neutral frame, and the
   * identity check below turns any late or mismatched frame into a closed
   * mouth. There is no path from here back into the speech lifecycle.
   */
  computeFrame(input: AvatarEngineHostInput): AvatarEngineFrameResult {
    const avatarId = input.avatarId ?? '';
    this.ensureAvatarLoaded(avatarId);

    const snapshot = this.toSnapshot(input, avatarId);
    this.reconcileSpeechEnd(input.speech, snapshot);
    const frame = this.runtime.update(snapshot);

    const applied = isFrameApplicable(frame, {
      avatarId,
      speechGeneration: snapshot.speechGeneration,
      motionEpoch: snapshot.motionEpoch,
    });
    if (!applied) this.metrics.countEvent('STALE_FRAME_REJECTIONS', 1);

    return {
      frame,
      mouthState: applied ? toRendererMouthState(frame) : 'closed',
      applied,
    };
  }

  acknowledgeTap(hostNowMs: number, semanticMode: AvatarSemanticMode = 'idle'): boolean {
    return this.runtime.acknowledgeTap(hostNowMs, semanticMode);
  }

  metricsSnapshot(): AvatarEngineMetricsSnapshot {
    return this.metrics.snapshot();
  }

  resetMetrics(): void {
    this.metrics.reset();
  }

  dispose(): void {
    this.runtime.dispose();
    this.loadedAvatarId = null;
  }

  /** Test seam; the debug state carries no PII. */
  debugState(): ReturnType<AvatarRuntime['getDebugState']> {
    return this.runtime.getDebugState();
  }

  // -- internals --------------------------------------------------------------

  /**
   * Capabilities come from validated package metadata, never from a hard-coded
   * avatar list. There is no `if (avatarId === 'sarah')` anywhere in this
   * integration: an avatar animates exactly as far as its approved assets and
   * calibrated regions allow, and no further.
   */
  /**
   * Tells the engine an utterance ended, and why.
   *
   * The engine can render correctly without this — a non-playing phase already
   * yields a closed mouth — but without it `endSpeech` is never called, the
   * compiled timeline lingers until the next utterance replaces it, and the
   * RESET_COMPLETION / RESET_INTERRUPTION counters stay at zero forever. That
   * last part actively misleads: the shadow report compares legacy resets
   * against engine resets, and a permanent zero reads as V10 failing to reset
   * when in fact nothing ever asked it to.
   */
  private reconcileSpeechEnd(
    speech: AvatarEngineSpeechInput,
    snapshot: AvatarSpeechRuntimeSnapshot,
  ): void {
    const phase = snapshot.phase;
    const wasPlaying = this.previousPhase === 'playing';
    const generation = this.previousGeneration;
    this.previousPhase = phase;
    this.previousGeneration = snapshot.speechGeneration;

    if (!wasPlaying || phase === 'playing') return;
    if (generation < 0) return;
    // A generation change at the same moment means the next utterance already
    // superseded this one; that is a new-utterance reset, not a completion.
    if (snapshot.speechGeneration !== generation) return;

    const interrupted = speech.phase === 'stopping' || speech.phase === 'error';
    this.runtime.endSpeech(generation, interrupted ? 'interruption' : 'completion');
  }

  private ensureAvatarLoaded(avatarId: string): void {
    if (avatarId === this.loadedAvatarId) return;
    this.loadedAvatarId = avatarId;
    const resolution = resolveAvatarPackage(avatarId);
    this.runtime.loadAvatar({
      avatarId,
      capabilities: resolution.validation.assetCapabilities,
    });
  }

  private toSnapshot(input: AvatarEngineHostInput, avatarId: string): AvatarSpeechRuntimeSnapshot {
    const speech = input.speech;

    // The store's utterance only counts for this surface when the host says the
    // actor/session/stylist scope matches AND the store agrees on the avatar.
    // Otherwise this surface is not the one speaking, and the engine is handed
    // an idle observation rather than someone else's utterance.
    const owns = input.scopeMatches && speech.avatarId === avatarId;
    const phase = owns ? speech.phase : 'idle';
    const playing = phase === 'playing';

    return {
      avatarId,
      speechGeneration: owns && Number.isInteger(speech.generation) && speech.generation >= 0
        ? speech.generation
        : 0,
      phase,
      playing,
      playbackPositionSeconds: playing && Number.isFinite(speech.playbackSeconds)
        ? Math.max(0, speech.playbackSeconds)
        : 0,
      // A position is trustworthy only once native playback has actually
      // started. Before that the store's zero is an initial value, not a seek,
      // and the engine holds rather than re-anchors on it.
      playbackAvailable: playing,
      alignment: owns ? speech.alignment : null,
      hostNowMs: Number.isFinite(input.hostNowMs) ? input.hostNowMs : 0,
      foreground: input.foreground !== false,
      reduceMotion: input.reduceMotion === true,
      motionEpoch: Number.isInteger(input.motionEpoch) && input.motionEpoch >= 0 ? input.motionEpoch : 0,
      motionEnabled: input.motionEnabled !== false,
      lipSyncEnabled: input.lipSyncEnabled !== false,
      interrupted: owns && (speech.phase === 'stopping' || speech.phase === 'error'),
      ...(input.semanticMode ? { semanticMode: input.semanticMode } : {}),
      ...(input.gazeTarget ? { gazeTarget: input.gazeTarget } : {}),
      ...(input.emphasis !== undefined ? { emphasis: input.emphasis } : {}),
      ...(input.uncertainty !== undefined ? { uncertainty: input.uncertainty } : {}),
    };
  }
}

/**
 * Process-wide adapter.
 *
 * One avatar is visible at a time, and the speech store it observes is itself a
 * module singleton, so a single adapter keeps engine state — cursor position,
 * anti-pop history, blink phase — coherent across remounts instead of resetting
 * every time a header re-renders.
 */
let sharedAdapter: AvatarEngineHostAdapter | null = null;

export function getAvatarEngineAdapter(): AvatarEngineHostAdapter {
  if (!sharedAdapter) sharedAdapter = new AvatarEngineHostAdapter();
  return sharedAdapter;
}

export function resetAvatarEngineAdapterForTests(): void {
  sharedAdapter?.dispose();
  sharedAdapter = null;
}
