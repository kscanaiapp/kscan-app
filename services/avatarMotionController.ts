import type { AvatarMouthState } from './avatarSpeechMotion';
import {
  MOTION_MODE_PRIORITY,
  NEUTRAL_AVATAR_MOTION_STATE,
  NO_MOTION_CAPABILITIES,
  avatarMotionStatesEqual,
  normalizeAvatarMotionState,
  type AvatarExpressionMode,
  type AvatarMotionCapabilities,
  type AvatarMotionMode,
  type AvatarMotionState,
} from './avatarMotionState';

// Deterministic facial-motion controller.
//
// The controller is the only owner of motion arbitration. It never creates a
// timer: every decision is computed from an injected clock at event time, so
// behavior is fully reproducible in tests and no timer can leak. Renderers
// subscribe to snapshots; they never decide priority or derive speech timing.

/**
 * Transition and timing policy. Tuning values, not release guarantees; every
 * duration lives here so nothing is hardcoded at call sites.
 */
export const MOTION_TRANSITION_POLICY = {
  /** Visual attack for the start-of-speech anti-pop half-open frame. */
  speechAttackMs: 50,
  /** General state-change attack envelope. */
  stateAttackMs: 160,
  /** General state-change release envelope. */
  stateReleaseMs: 240,
  /** How long a brief reaction (tap acknowledgement, emphasis nod) holds. */
  reactionDurationMs: 700,
  /**
   * Anti-flicker hysteresis before entering listening from typing input.
   * Chosen well under one perceptual beat (~400 ms) so Elise feels attentive,
   * while absorbing single accidental keystrokes; typing itself never waits.
   */
  listeningHysteresisMs: 250,
} as const;

export interface AvatarMotionTransitionEnvelope {
  durationMs: number;
  easing: 'easeInOut' | 'linear';
}

/** Envelope for a mode change. Speech entry uses the short anti-pop attack. */
export function getMotionTransitionEnvelope(
  from: AvatarMotionMode,
  to: AvatarMotionMode,
): AvatarMotionTransitionEnvelope {
  if (to === 'speaking') {
    return { durationMs: MOTION_TRANSITION_POLICY.speechAttackMs, easing: 'easeInOut' };
  }
  if (to === 'idle') {
    return { durationMs: MOTION_TRANSITION_POLICY.stateReleaseMs, easing: 'easeInOut' };
  }
  if (from === 'idle' || MOTION_MODE_PRIORITY[to] > MOTION_MODE_PRIORITY[from]) {
    return { durationMs: MOTION_TRANSITION_POLICY.stateAttackMs, easing: 'easeInOut' };
  }
  return { durationMs: MOTION_TRANSITION_POLICY.stateReleaseMs, easing: 'easeInOut' };
}

/**
 * Start-of-speech anti-pop. A pure function of the first target viseme and
 * time since speaking began: an immediate open/round first frame is softened
 * through one half-open attack frame. Provider timestamps and audio are never
 * altered; this is a visual envelope only.
 */
export function resolveSpeechEntryMouth(
  targetMouth: AvatarMouthState,
  elapsedSinceSpeakingStartMs: number,
  reducedMotion: boolean,
): AvatarMouthState {
  if (reducedMotion) return 'closed';
  if (targetMouth === 'closed' || targetMouth === 'halfOpen') return targetMouth;
  if (elapsedSinceSpeakingStartMs < MOTION_TRANSITION_POLICY.speechAttackMs) return 'halfOpen';
  return targetMouth;
}

export interface AvatarMotionControllerOptions {
  /** Monotonic-enough millisecond clock. Injected for determinism in tests. */
  clock?: () => number;
  /** Uniform [0,1) source. Injected for determinism in tests. */
  random?: () => number;
  capabilities?: AvatarMotionCapabilities;
  /** Reduce Motion provider, read at event time so changes apply mid-speech. */
  isReducedMotion?: () => boolean;
}

export interface IdleMicroMotionPlan {
  /** Delay before the tilt begins. */
  delayMs: number;
  /** Restrained roll target in degrees. */
  rollDeg: number;
  /** How long the tilt holds before easing back. */
  holdMs: number;
}

export interface AvatarMotionController {
  getSnapshot(): AvatarMotionState;
  /**
   * The mode as it is RIGHT NOW, with a finished reaction already expired.
   *
   * KSB29-M01. `reacting` self-expires against the injected clock rather than
   * against a scheduled timer, so `getSnapshot().mode` keeps reporting
   * `reacting` long after the reaction is over — nothing writes the state back
   * to idle. The controller already computed this internally; it was simply
   * never exposed, so every caller that asked "is Elise busy?" got a stale yes.
   * That is what made a second tap do nothing.
   *
   * Callers deciding whether an interaction may run must use this, not
   * `getSnapshot().mode`.
   */
  getEffectiveMode(): AvatarMotionMode;
  subscribe(listener: () => void): () => void;
  /** Request a schedulable mode. Returns true when the transition applied. */
  requestMode(mode: 'idle' | 'listening' | 'thinking' | 'reacting', generation?: number): boolean;
  /** Native playback reported active. The only entry into speaking. */
  reportPlaybackActive(generation: number): boolean;
  /** Playback-authoritative mouth update while speaking. */
  reportPlaybackMouth(generation: number, mouth: AvatarMouthState): boolean;
  /** Playback finished or was stopped; releases speaking to idle. */
  reportPlaybackEnded(generation: number): boolean;
  /** Speech failed; releases to neutral idle with no error expression. */
  reportSpeechFailed(generation: number): boolean;
  /** Deterministic local expression update (never entered during reset). */
  setExpression(expression: AvatarExpressionMode, generation?: number): boolean;
  /** Hard interruption (background, route change, user typing stop). */
  interrupt(): void;
  /** Safety reset: outranks every state, returns to neutral idle. */
  reset(): void;
  /** Deterministic plan for an occasional idle head tilt. */
  planIdleMicroMotion(): IdleMicroMotionPlan;
  /** Stop emitting, drop listeners, return to neutral. */
  dispose(): void;
  /** Test hook: number of active subscriptions. */
  getListenerCountForTests(): number;
}

const REQUESTABLE_MODES: ReadonlySet<AvatarMotionMode> = new Set([
  'idle',
  'listening',
  'thinking',
  'reacting',
]);

/**
 * Generation authority accepts only finite, non-negative integers.
 *
 * A corrupt value (NaN, ±Infinity, negative, fractional) must be rejected
 * *before* any stale comparison or adoption: NaN comparisons are always
 * false, so an unguarded NaN would read as "not stale" and pass every guard,
 * and adopting Infinity would permanently invalidate every future real
 * generation. Rejection leaves the internal counter untouched so a later
 * valid generation still succeeds.
 */
export function isValidMotionGeneration(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function createAvatarMotionController(
  options: AvatarMotionControllerOptions = {},
): AvatarMotionController {
  const clock = options.clock ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const capabilities = options.capabilities ?? NO_MOTION_CAPABILITIES;
  const isReducedMotion = options.isReducedMotion ?? (() => false);

  let disposed = false;
  let state: AvatarMotionState = NEUTRAL_AVATAR_MOTION_STATE;
  // Two independent counters, deliberately kept apart:
  //
  // `epoch` is the controller's own invalidation clock. It advances on every
  // reset/interrupt and identifies the snapshot, but it is never compared
  // against externally supplied speech generations.
  //
  // `acceptedSpeechGeneration` / `invalidatedSpeechGeneration` track the
  // caller's monotonically increasing speech generations. Folding these into
  // one counter is what made repeated resets dangerous: each reset used to
  // push the shared counter past the speech sequence, so after two teardowns
  // (say unmount plus background) the next real utterance looked stale and
  // speaking could never start again.
  let epoch = 0;
  let acceptedSpeechGeneration = -1;
  let invalidatedSpeechGeneration = -1;
  let speakingStartedAtMs = 0;
  let reactionStartedAtMs = 0;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One subscriber cannot corrupt arbitration for the others.
      }
    }
  }

  function commit(next: AvatarMotionState): void {
    const normalized = normalizeAvatarMotionState(next, {
      reducedMotion: isReducedMotion(),
      capabilities,
    });
    if (avatarMotionStatesEqual(state, normalized)) {
      state = normalized;
      return;
    }
    state = Object.freeze(normalized);
    emit();
  }

  /** Reactions self-expire against the injected clock; no timer is scheduled. */
  function effectiveMode(): AvatarMotionMode {
    if (
      state.mode === 'reacting' &&
      clock() - reactionStartedAtMs >= MOTION_TRANSITION_POLICY.reactionDurationMs
    ) {
      return 'idle';
    }
    return state.mode;
  }

  /**
   * A speech generation is stale when it was explicitly invalidated by a
   * reset/interrupt, or when a newer generation has already been accepted.
   * Because callers allocate generations from a single increasing counter, a
   * genuinely new utterance always sorts above both watermarks.
   */
  function isStale(value: number): boolean {
    return value <= invalidatedSpeechGeneration || value < acceptedSpeechGeneration;
  }

  function adoptGeneration(value: number): void {
    if (value > acceptedSpeechGeneration) acceptedSpeechGeneration = value;
  }

  /** Invalidate the current utterance and everything older than it. */
  function invalidateSpeech(): void {
    if (acceptedSpeechGeneration > invalidatedSpeechGeneration) {
      invalidatedSpeechGeneration = acceptedSpeechGeneration;
    }
  }

  function neutral(mode: AvatarMotionMode): AvatarMotionState {
    return {
      ...NEUTRAL_AVATAR_MOTION_STATE,
      mode,
      generation: epoch,
      timestampMs: clock(),
    };
  }

  return {
    getSnapshot() {
      return state;
    },

    getEffectiveMode() {
      return effectiveMode();
    },

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    requestMode(mode, requestGeneration) {
      if (disposed) return false;
      if (!REQUESTABLE_MODES.has(mode)) return false;
      if (requestGeneration !== undefined) {
        if (!isValidMotionGeneration(requestGeneration)) return false;
        if (isStale(requestGeneration)) return false;
        adoptGeneration(requestGeneration);
      }
      const current = effectiveMode();
      if (current === mode && state.mode === mode) return true;

      // Speaking and interrupted are never preempted by a schedulable mode:
      // speech synchronization outranks decorative motion, and an interrupted
      // avatar only recovers through reset/idle release.
      if (state.mode === 'speaking' || state.mode === 'interrupted') {
        if (current !== 'idle') return false;
      }
      if (mode === 'idle') {
        // Release to idle is always legal from a schedulable state.
        commit({ ...neutral('idle'), expression: state.expression });
        return true;
      }
      if (current !== 'idle' && MOTION_MODE_PRIORITY[mode] <= MOTION_MODE_PRIORITY[current]) {
        return false;
      }
      if (mode === 'reacting') reactionStartedAtMs = clock();
      commit({ ...neutral(mode), expression: state.expression });
      return true;
    },

    reportPlaybackActive(playbackGeneration) {
      if (disposed || !isValidMotionGeneration(playbackGeneration)) return false;
      if (isStale(playbackGeneration)) return false;
      adoptGeneration(playbackGeneration);
      speakingStartedAtMs = clock();
      commit({
        ...neutral('speaking'),
        expression: state.expression,
        speaking: true,
        mouth: 'closed',
      });
      return true;
    },

    reportPlaybackMouth(playbackGeneration, mouth) {
      if (disposed || !isValidMotionGeneration(playbackGeneration)) return false;
      if (isStale(playbackGeneration)) return false;
      if (state.mode !== 'speaking' || playbackGeneration !== acceptedSpeechGeneration) {
        return false;
      }
      const softened = resolveSpeechEntryMouth(
        mouth,
        clock() - speakingStartedAtMs,
        isReducedMotion(),
      );
      commit({ ...state, mouth: softened, timestampMs: clock() });
      return true;
    },

    reportPlaybackEnded(playbackGeneration) {
      if (disposed || !isValidMotionGeneration(playbackGeneration)) return false;
      if (isStale(playbackGeneration)) return false;
      if (state.mode !== 'speaking') return false;
      commit({ ...neutral('idle'), expression: state.expression });
      return true;
    },

    reportSpeechFailed(playbackGeneration) {
      if (disposed || !isValidMotionGeneration(playbackGeneration)) return false;
      if (isStale(playbackGeneration)) return false;
      adoptGeneration(playbackGeneration);
      // Failure degrades to neutral idle: no disappointed expression, no
      // stuck mouth. The text response remains the product surface.
      commit(neutral('idle'));
      return true;
    },

    setExpression(expression, requestGeneration) {
      if (disposed) return false;
      if (requestGeneration !== undefined) {
        if (!isValidMotionGeneration(requestGeneration)) return false;
        if (isStale(requestGeneration)) return false;
      }
      if (state.mode === 'interrupted') return false;
      commit({ ...state, expression, timestampMs: clock() });
      return true;
    },

    interrupt() {
      if (disposed) return;
      epoch += 1;
      invalidateSpeech();
      speakingStartedAtMs = 0;
      reactionStartedAtMs = 0;
      commit({ ...neutral('interrupted') });
      // Interruption immediately settles to neutral idle: the interrupted
      // mode exists for arbitration ordering, not as a lingering visual.
      // Every channel — mouth, eyes, brows, gaze, expression, head,
      // breathing, shoulder — returns to its neutral value here because
      // `neutral()` is built from NEUTRAL_AVATAR_MOTION_STATE.
      commit(neutral('idle'));
    },

    reset() {
      if (disposed) return;
      epoch += 1;
      invalidateSpeech();
      speakingStartedAtMs = 0;
      reactionStartedAtMs = 0;
      commit(neutral('idle'));
    },

    planIdleMicroMotion() {
      // Deterministic given the injected random source: occasional, slow,
      // restrained. Roll stays within ±1° of the ±2° hard clamp.
      const direction = random() < 0.5 ? -1 : 1;
      return {
        delayMs: 6_000 + Math.floor(random() * 8_000),
        rollDeg: direction * (0.5 + random() * 0.5),
        holdMs: 1_800 + Math.floor(random() * 1_200),
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      invalidateSpeech();
      speakingStartedAtMs = 0;
      reactionStartedAtMs = 0;
      state = Object.freeze({
        ...NEUTRAL_AVATAR_MOTION_STATE,
        generation: epoch,
      });
      listeners.clear();
    },

    getListenerCountForTests() {
      return listeners.size;
    },
  };
}

// ── Shared instance ──────────────────────────────────────────────────────────
//
// Production uses exactly one controller. The factory stays exported for
// deterministic tests; the shared accessor guarantees no duplicate instance.

let sharedController: AvatarMotionController | null = null;
let sharedOptions: AvatarMotionControllerOptions | null = null;

export function getSharedAvatarMotionController(
  options?: AvatarMotionControllerOptions,
): AvatarMotionController {
  if (!sharedController) {
    sharedOptions = options ?? null;
    sharedController = createAvatarMotionController(options);
  }
  return sharedController;
}

/**
 * Return the shared controller to neutral idle if one exists, without
 * creating it. Used by every teardown path (unmount, navigation away,
 * backgrounding, avatar change) so no motion state survives the surface that
 * produced it. Safe to call repeatedly and safe to call when motion is
 * disabled — with no controller instantiated it is a no-op.
 */
export function resetSharedAvatarMotionController(): void {
  sharedController?.reset();
}

/** Test/hot-reload hook: dispose and clear the shared instance. */
export function resetSharedAvatarMotionControllerForTests(): void {
  sharedController?.dispose();
  sharedController = null;
  sharedOptions = null;
}

/** Test hook: options captured when the shared controller was created. */
export function getSharedAvatarMotionControllerOptionsForTests():
  AvatarMotionControllerOptions | null {
  return sharedOptions;
}
