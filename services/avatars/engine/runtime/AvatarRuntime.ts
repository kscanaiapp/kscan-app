import type {
  AvatarAssetCapabilities,
  AvatarEngineConfig,
  AvatarMouthState,
  AvatarSemanticMode,
  AvatarSpeechAlignment,
  CompiledSpeechTimeline,
} from '../types';
import { STATIC_CAPABILITIES } from '../types';
import type {
  AvatarFrameReason,
  AvatarMouthTransition,
  AvatarSpeechRuntimeSnapshot,
  AvatarVisualFrame,
} from '../contract';
import { AVATAR_ENGINE_CONTRACT_VERSION } from '../contract';
import { normalizeEngineConfig } from '../config';
import { isValidGeneration, isValidMotionEpoch } from '../validation/generation';
import { compileSpeechTimeline } from '../speech/compileTimeline';
import { TimelineCursor } from '../speech/TimelineCursor';
import { fallbackMouthState } from '../speech/fallback';
import { createBlinkState, deriveBlink, type BlinkRuntimeState } from '../motion/blink';
import { deriveBrows, deriveExpression } from '../motion/expression';
import { deriveGaze } from '../motion/gaze';
import { deriveCompositeMotion, neutralComposite } from '../motion/composite';
import type { AvatarEngineMetricsSink } from '../instrumentation/metrics';
import { NOOP_METRICS_SINK } from '../instrumentation/metrics';

export interface AvatarRuntimeOptions {
  config?: Partial<AvatarEngineConfig>;
  /** Where measurements go. Defaults to discarding them. */
  metrics?: AvatarEngineMetricsSink;
  /**
   * Optional host-supplied monotonic clock, used ONLY to measure how long the
   * engine's own work takes. The engine has no ambient clock: omitting this
   * yields identical visual output with durations reported as zero.
   */
  now?: () => number;
}

export interface LoadAvatarInput {
  avatarId: string;
  capabilities: AvatarAssetCapabilities;
}

export type SpeechEndKind = 'completion' | 'interruption';

/**
 * The V10 avatar runtime.
 *
 * What it owns: visual calculation. Alignment sanitization, viseme derivation,
 * capability-aware mouth mapping, timeline compilation, bounded frame lookup,
 * motion epoch, stale-frame data, idle/blink/brow/gaze/expression calculation
 * and the neutral fail-closed state.
 *
 * What it does not own, and cannot: audio, the speech request, the playback
 * clock, the speech-generation counter, application lifecycle, feature gates,
 * assets, or rendering. It consumes those authorities through one immutable
 * snapshot per frame and answers with one frame.
 *
 * It starts no timer, holds no subscription and never throws outward: a visual
 * failure stays a visual failure.
 */
export class AvatarRuntime {
  private readonly config: AvatarEngineConfig;
  private readonly metrics: AvatarEngineMetricsSink;
  private readonly now: (() => number) | undefined;

  private avatarId: string | null = null;
  private capabilities: AvatarAssetCapabilities = STATIC_CAPABILITIES;

  private speechGeneration = -1;
  private motionEpoch = 0;

  private timeline: CompiledSpeechTimeline | null = null;
  private timelineGeneration = -1;
  private readonly cursor = new TimelineCursor();

  private previousMouth: AvatarMouthState = 'closed';
  /** Playback position at which the current mouth state was entered. */
  private mouthChangedAtPlaybackSeconds: number | null = null;
  /** Host wall-clock at which the current mouth state was entered, for the transition curve. */
  private mouthChangedAtHostMs: number | null = null;

  /** Last trustworthy playback position, held across a native stall. */
  private heldPlaybackSeconds = 0;
  private firstMouthRecordedForGeneration = -1;

  private blink: BlinkRuntimeState = createBlinkState();
  private tapAcceptedAtMs = -Infinity;
  private tapActiveUntilMs = -Infinity;
  private disposed = false;

  constructor(options: AvatarRuntimeOptions = {}) {
    this.config = normalizeEngineConfig(options.config);
    this.metrics = options.metrics ?? NOOP_METRICS_SINK;
    this.now = options.now;
  }

  /**
   * Binds an avatar and its validated capabilities.
   *
   * Any capability change invalidates the compiled timeline, because a timeline
   * carries resolved mouth STATES, not visemes: reusing one across an avatar
   * switch would ask a package to draw a shape it may not own.
   */
  loadAvatar(input: LoadAvatarInput): boolean {
    if (this.disposed) return false;
    if (!input || typeof input.avatarId !== 'string' || input.avatarId.length === 0) return false;
    const changed = input.avatarId !== this.avatarId || !sameCapabilities(this.capabilities, input.capabilities);
    if (!changed) return false;
    if (this.avatarId !== null) this.metrics.countEvent('RESET_AVATAR_SWITCH', 1);
    this.avatarId = input.avatarId;
    this.capabilities = { ...input.capabilities };
    this.discardTimeline();
    // Clears visual state WITHOUT inventing an epoch. The motion epoch is a
    // host authority: an engine that bumped it here would report frames from an
    // epoch the host never asked for, and every one of them would then be
    // rejected as stale by the renderer's identity check.
    this.resetMotionState();
    return true;
  }

  /**
   * Accepts a new utterance. Older generations are refused so a late callback
   * from an abandoned utterance can never reinstate its timeline.
   */
  beginSpeech(input: { generation: number; alignment?: AvatarSpeechAlignment | null }): boolean {
    if (this.disposed) return false;
    if (!isValidGeneration(input.generation) || input.generation < this.speechGeneration) return false;
    if (input.generation !== this.speechGeneration) {
      this.metrics.countEvent('RESET_NEW_UTTERANCE', 1);
    }
    this.speechGeneration = input.generation;
    this.compileFor(input.generation, input.alignment ?? null);
    this.resetSpeechCursor();
    return true;
  }

  endSpeech(generation: number, kind: SpeechEndKind = 'completion'): boolean {
    if (!isValidGeneration(generation) || generation !== this.speechGeneration) return false;
    this.metrics.countEvent(kind === 'completion' ? 'RESET_COMPLETION' : 'RESET_INTERRUPTION', 1);
    this.discardTimeline();
    this.resetSpeechCursor();
    return true;
  }

  /**
   * Bumps the visual lifetime. Deliberately does not touch `speechGeneration`,
   * so repeated resets — a route change, a remount, a session switch — cannot
   * make the next legitimate utterance look stale.
   */
  resetMotion(epoch: number): boolean {
    if (!isValidMotionEpoch(epoch) || epoch < this.motionEpoch) return false;
    this.motionEpoch = epoch;
    this.resetMotionState();
    return true;
  }

  /** Clears visual state for the CURRENT epoch. Never changes the epoch itself. */
  private resetMotionState(): void {
    this.resetSpeechCursor();
    this.blink = createBlinkState(0, (0x4b534341 ^ this.motionEpoch) >>> 0);
    this.tapActiveUntilMs = -Infinity;
  }

  acknowledgeTap(nowMs: number, semanticMode: AvatarSemanticMode): boolean {
    if (this.disposed || !Number.isFinite(nowMs)) return false;
    if (semanticMode !== 'idle' && semanticMode !== 'listening') return false;
    if (nowMs - this.tapAcceptedAtMs < this.config.tapCooldownMs) return false;
    this.tapAcceptedAtMs = nowMs;
    this.tapActiveUntilMs = nowMs + this.config.tapReactionMs;
    return true;
  }

  /**
   * Calculates one frame.
   *
   * Every exit path returns a frame. Nothing here is awaited, nothing is
   * scheduled, and any unexpected throw is converted into the neutral frame, so
   * a calculation defect can never reach the speech lifecycle or StyleChat.
   */
  update(snapshot: AvatarSpeechRuntimeSnapshot): AvatarVisualFrame {
    const startedAt = this.now ? this.now() : 0;
    try {
      const frame = this.calculate(snapshot);
      if (this.now) this.metrics.recordDuration('FRAME_CALC_MS', Math.max(0, this.now() - startedAt));
      return frame;
    } catch {
      this.metrics.countEvent('CALCULATION_ERRORS', 1);
      if (this.now) this.metrics.recordDuration('FRAME_CALC_MS', Math.max(0, this.now() - startedAt));
      return this.neutralFrame('calculation-error', snapshot?.avatarId ?? this.avatarId ?? '', false);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.discardTimeline();
    this.resetSpeechCursor();
  }

  getDebugState(): Readonly<{
    avatarId: string | null;
    speechGeneration: number;
    motionEpoch: number;
    timelineDisposition: string;
    timelineIntervals: number;
    heldPlaybackSeconds: number;
    disposed: boolean;
  }> {
    return Object.freeze({
      avatarId: this.avatarId,
      speechGeneration: this.speechGeneration,
      motionEpoch: this.motionEpoch,
      timelineDisposition: this.timeline?.disposition ?? 'missing',
      timelineIntervals: this.timeline?.intervals.length ?? 0,
      heldPlaybackSeconds: this.heldPlaybackSeconds,
      disposed: this.disposed,
    });
  }

  // -- internals --------------------------------------------------------------

  private calculate(snapshot: AvatarSpeechRuntimeSnapshot): AvatarVisualFrame {
    if (this.disposed) return this.neutralFrame('disposed', snapshot?.avatarId ?? '', false);
    if (!snapshot || typeof snapshot !== 'object') {
      return this.neutralFrame('calculation-error', this.avatarId ?? '', false);
    }

    this.reconcileLifecycle(snapshot);

    const avatarMatches = this.avatarId !== null && snapshot.avatarId === this.avatarId;
    const generationAccepted =
      avatarMatches &&
      isValidGeneration(snapshot.speechGeneration) &&
      snapshot.speechGeneration === this.speechGeneration;

    if (!avatarMatches) {
      this.metrics.countEvent('STALE_FRAME_REJECTIONS', 1);
      return this.neutralFrame('avatar-mismatch', snapshot.avatarId, false);
    }
    if (!snapshot.foreground) return this.neutralFrame('background', snapshot.avatarId, generationAccepted);
    if (snapshot.reduceMotion) return this.neutralFrame('reduced-motion', snapshot.avatarId, generationAccepted);
    if (snapshot.interrupted === true || snapshot.semanticMode === 'interrupted') {
      return this.neutralFrame('interrupted', snapshot.avatarId, generationAccepted);
    }

    const hostNowMs = Number.isFinite(snapshot.hostNowMs) ? snapshot.hostNowMs : 0;
    const playbackSeconds = this.resolvePlaybackSeconds(snapshot);
    const semanticMode: AvatarSemanticMode =
      snapshot.phase === 'playing' && snapshot.playing
        ? 'speaking'
        : snapshot.semanticMode ?? 'idle';

    const motionEnabled = snapshot.motionEnabled && this.capabilities.compositeMotion;
    const tapActive =
      this.capabilities.tapAcknowledgement && snapshot.motionEnabled && hostNowMs < this.tapActiveUntilMs;

    const speaking = snapshot.phase === 'playing' && snapshot.playing && semanticMode === 'speaking';

    let mouthState: AvatarMouthState = 'closed';
    let fallbackUsed = false;
    let reason: AvatarFrameReason = motionEnabled && semanticMode !== 'speaking'
      ? (semanticMode === 'idle' ? 'idle-motion' : 'semantic-motion')
      : 'static';

    if (speaking && snapshot.lipSyncEnabled && this.capabilities.mouthClosed) {
      if (!generationAccepted) {
        this.metrics.countEvent('STALE_FRAME_REJECTIONS', 1);
        reason = 'stale-generation';
      } else if (this.timeline?.disposition === 'empty') {
        // The provider says this utterance has no spoken characters. Miming
        // would be worse than stillness, so the mouth stays closed.
        reason = 'speaking-empty-alignment';
      } else if (this.timeline && this.timeline.intervals.length > 0) {
        mouthState = this.cursor.resolve(this.timeline, playbackSeconds);
        reason = 'speaking-alignment';
      } else {
        mouthState = fallbackMouthState(playbackSeconds, this.config.fallbackCycleMs, this.capabilities);
        fallbackUsed = true;
        reason = 'speaking-fallback';
      }
    }

    mouthState = this.applyAttack(mouthState, playbackSeconds, speaking);
    this.recordFirstMouth(mouthState, playbackSeconds, generationAccepted);
    const mouthTransition = this.deriveTransition(mouthState, hostNowMs, snapshot.motionEnabled);

    // KNOWN DEFERRED ENGINE ISSUE — see `blinkDuringSpeech` in config.ts.
    const blinkEnabled =
      motionEnabled && this.capabilities.eyes && (this.config.blinkDuringSpeech || !speaking);
    const eyeState = deriveBlink(hostNowMs, this.blink, blinkEnabled, this.config);

    const expressionInput = {
      semanticMode,
      ...(snapshot.emphasis !== undefined ? { emphasis: snapshot.emphasis } : {}),
      ...(snapshot.uncertainty !== undefined ? { uncertainty: snapshot.uncertainty } : {}),
    };
    const browState = this.capabilities.brows && motionEnabled ? deriveBrows(expressionInput) : 'neutral';
    const gazeEnabled = this.capabilities.gaze && motionEnabled && !speaking;
    const gazeState = deriveGaze(gazeEnabled ? snapshot.gazeTarget : 'center', gazeEnabled, this.config);
    const expressionState = motionEnabled ? deriveExpression(expressionInput, tapActive) : 'neutral';
    const composite = deriveCompositeMotion(hostNowMs, motionEnabled, this.config, tapActive);

    return {
      contractVersion: AVATAR_ENGINE_CONTRACT_VERSION,
      avatarId: snapshot.avatarId,
      speechGeneration: this.speechGeneration,
      motionEpoch: this.motionEpoch,
      mouthState,
      mouthTransition,
      eyeState,
      browState,
      expressionState,
      gazeState,
      headMotion: composite.headMotion,
      breathing: composite.breathing,
      isSpeaking: speaking && generationAccepted,
      shouldRenderMouth:
        generationAccepted && snapshot.lipSyncEnabled && this.capabilities.mouthClosed && mouthState !== 'closed',
      shouldRenderEyes: this.capabilities.eyes && motionEnabled,
      shouldRenderBrows: this.capabilities.brows && motionEnabled,
      tapAcknowledgementActive: tapActive,
      diagnostics: {
        reason,
        generationAccepted,
        timelineDisposition: this.timeline?.disposition ?? 'missing',
        droppedAlignmentIntervals: this.timeline?.droppedIntervalCount ?? 0,
        fallbackUsed,
        neutral: false,
      },
    };
  }

  /**
   * Reconciles engine state with the host snapshot.
   *
   * Two transitions matter, and they are keyed on VALUES rather than object
   * identity so a host that re-creates its alignment object every render cannot
   * make the engine recompile a timeline — and reset anti-pop and transitions —
   * on every frame:
   *
   *  - the speech generation advanced: a new utterance,
   *  - alignment arrived for the generation already in flight, which is the
   *    normal K Scan order (`beginAvatarSpeech` starts with a null alignment and
   *    `markAvatarSpeechReady` supplies it a moment later).
   */
  private reconcileLifecycle(snapshot: AvatarSpeechRuntimeSnapshot): void {
    if (isValidMotionEpoch(snapshot.motionEpoch) && snapshot.motionEpoch !== this.motionEpoch) {
      this.resetMotion(snapshot.motionEpoch);
    }

    if (!isValidGeneration(snapshot.speechGeneration)) return;
    const alignment = snapshot.alignment ?? null;

    if (snapshot.speechGeneration > this.speechGeneration) {
      this.metrics.countEvent('RESET_NEW_UTTERANCE', 1);
      this.speechGeneration = snapshot.speechGeneration;
      this.compileFor(snapshot.speechGeneration, alignment);
      this.resetSpeechCursor();
      return;
    }

    if (
      snapshot.speechGeneration === this.speechGeneration &&
      alignment !== null &&
      this.timelineGeneration === this.speechGeneration &&
      this.timeline !== null &&
      this.timeline.source === 'none'
    ) {
      // Late alignment for the utterance already playing. The cursor is NOT
      // reset here: playback has advanced, and rewinding the mouth to zero
      // would visibly restart the utterance mid-sentence.
      this.compileFor(snapshot.speechGeneration, alignment);
    }
  }

  private compileFor(generation: number, alignment: AvatarSpeechAlignment | null): void {
    this.timeline = compileSpeechTimeline(alignment, this.capabilities, this.config, this.now);
    this.timelineGeneration = generation;
    this.metrics.countEvent('ALIGNMENT_INPUT_EVENTS', this.timeline.inputIntervalCount);
    this.metrics.countEvent('ALIGNMENT_RETAINED_EVENTS', this.timeline.retainedIntervalCount);
    this.metrics.countEvent('ALIGNMENT_DISCARDED_EVENTS', this.timeline.droppedIntervalCount);
    if (this.now) this.metrics.recordDuration('TIMELINE_COMPILE_MS', this.timeline.compileMs);
  }

  /**
   * Playback discontinuity policy.
   *
   * The engine never manufactures a position. When the host reports that it has
   * no trustworthy position — before the first progress callback, or across a
   * native stall — the last known position is HELD. Treating that gap as a seek
   * to zero would re-anchor the cursor at the start and visibly replay the
   * utterance, which is the failure this rule exists to prevent.
   */
  private resolvePlaybackSeconds(snapshot: AvatarSpeechRuntimeSnapshot): number {
    const reported = snapshot.playbackPositionSeconds;
    const usable = snapshot.playbackAvailable !== false && Number.isFinite(reported) && reported >= 0;
    if (!usable) {
      // Only a gap DURING playback is a stall. Before playback starts the host
      // legitimately has no position, and counting those frames would inflate
      // the stall metric on every ordinary utterance — which would make a real
      // stall indistinguishable from a normal run.
      if (snapshot.playing) this.metrics.countEvent('PLAYBACK_HOLD_EVENTS', 1);
      return this.heldPlaybackSeconds;
    }
    this.heldPlaybackSeconds = reported;
    return reported;
  }

  /**
   * Anti-pop attack, measured in PLAYBACK time.
   *
   * Opening straight from closed to a wide shape reads as a pop, so the first
   * moments of an opening pass through half-open when the package has it. This
   * deliberately uses playback position rather than wall-clock elapsed time: a
   * paused or stalled player must not let the attack expire while the audio is
   * standing still.
   */
  private applyAttack(target: AvatarMouthState, playbackSeconds: number, speaking: boolean): AvatarMouthState {
    if (!speaking || target === 'closed' || target === 'halfOpen') return target;
    if (this.previousMouth !== 'closed' || !this.capabilities.mouthHalfOpen) return target;
    if (this.mouthChangedAtPlaybackSeconds === null) this.mouthChangedAtPlaybackSeconds = playbackSeconds;
    const elapsedMs = (playbackSeconds - this.mouthChangedAtPlaybackSeconds) * 1000;
    return elapsedMs >= 0 && elapsedMs < this.config.speechAttackPlaybackMs ? 'halfOpen' : target;
  }

  private recordFirstMouth(mouth: AvatarMouthState, playbackSeconds: number, generationAccepted: boolean): void {
    if (!generationAccepted || mouth === 'closed') return;
    if (this.firstMouthRecordedForGeneration === this.speechGeneration) return;
    this.firstMouthRecordedForGeneration = this.speechGeneration;
    this.metrics.recordDuration('PLAYBACK_TO_FIRST_MOUTH_MS', Math.max(0, playbackSeconds * 1000));
  }

  private deriveTransition(
    target: AvatarMouthState,
    hostNowMs: number,
    motionEnabled: boolean,
  ): AvatarMouthTransition | null {
    if (!motionEnabled || this.config.transitionMs <= 0) {
      this.markMouth(target, hostNowMs);
      return null;
    }
    if (target !== this.previousMouth) {
      const from = this.previousMouth;
      this.markMouth(target, hostNowMs);
      return { from, to: target, progress: 0, durationMs: this.config.transitionMs };
    }
    if (this.mouthChangedAtHostMs === null) return null;
    const elapsed = Math.max(0, hostNowMs - this.mouthChangedAtHostMs);
    const raw = Math.min(1, elapsed / this.config.transitionMs);
    if (raw >= 1) return null;
    const progress = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
    return { from: target, to: target, progress, durationMs: this.config.transitionMs };
  }

  private markMouth(target: AvatarMouthState, hostNowMs: number): void {
    if (target !== this.previousMouth) this.mouthChangedAtPlaybackSeconds = null;
    this.previousMouth = target;
    this.mouthChangedAtHostMs = hostNowMs;
  }

  private resetSpeechCursor(): void {
    this.cursor.reset();
    this.previousMouth = 'closed';
    this.mouthChangedAtPlaybackSeconds = null;
    this.mouthChangedAtHostMs = null;
    this.heldPlaybackSeconds = 0;
    this.firstMouthRecordedForGeneration = -1;
  }

  private discardTimeline(): void {
    this.timeline = null;
    this.timelineGeneration = -1;
  }

  private neutralFrame(
    reason: AvatarFrameReason,
    avatarId: string,
    generationAccepted: boolean,
  ): AvatarVisualFrame {
    // Leaving the neutral state also clears the mouth history, so the next
    // legitimate frame starts from closed instead of transitioning out of
    // whatever shape was on screen when the interruption happened.
    this.previousMouth = 'closed';
    this.mouthChangedAtPlaybackSeconds = null;
    const composite = neutralComposite();
    return {
      contractVersion: AVATAR_ENGINE_CONTRACT_VERSION,
      avatarId,
      speechGeneration: this.speechGeneration,
      motionEpoch: this.motionEpoch,
      mouthState: 'closed',
      mouthTransition: null,
      eyeState: 'open',
      browState: 'neutral',
      expressionState: 'neutral',
      gazeState: { x: 0, y: 0, target: 'center' },
      headMotion: composite.headMotion,
      breathing: composite.breathing,
      isSpeaking: false,
      shouldRenderMouth: false,
      shouldRenderEyes: false,
      shouldRenderBrows: false,
      tapAcknowledgementActive: false,
      diagnostics: {
        reason,
        generationAccepted,
        timelineDisposition: this.timeline?.disposition ?? 'missing',
        droppedAlignmentIntervals: this.timeline?.droppedIntervalCount ?? 0,
        fallbackUsed: false,
        neutral: true,
      },
    };
  }
}

function sameCapabilities(a: AvatarAssetCapabilities, b: AvatarAssetCapabilities): boolean {
  if (!b) return false;
  return (
    a.base === b.base &&
    a.mouthClosed === b.mouthClosed &&
    a.mouthHalfOpen === b.mouthHalfOpen &&
    a.mouthOpen === b.mouthOpen &&
    a.mouthRound === b.mouthRound &&
    a.mouthWide === b.mouthWide &&
    a.eyes === b.eyes &&
    a.brows === b.brows &&
    a.gaze === b.gaze &&
    a.compositeMotion === b.compositeMotion &&
    a.tapAcknowledgement === b.tapAcknowledgement
  );
}
