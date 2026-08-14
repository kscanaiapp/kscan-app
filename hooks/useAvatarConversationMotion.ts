import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AVATAR_MOTION_V1_ENABLED } from '../constants/featureFlags';
import {
  getSharedAvatarMotionController,
  resetSharedAvatarMotionController,
  MOTION_TRANSITION_POLICY,
} from '../services/avatarMotionController';
import {
  ensureAvatarSpeechLifecycleListener,
  registerAvatarInterruptionHandler,
} from '../services/avatarSpeechLifecycle';
import type { AvatarMotionMode } from '../services/avatarMotionState';
import {
  getAvatarMotionSnapshot,
  subscribeToAvatarMotion,
  type AvatarDiscreteMotionSnapshot,
} from '../stores/avatarMotionStore';

// StyleChat conversation → motion-controller wiring.
//
// Local UI signals that already exist (composer input which also stops
// active speech, the in-flight send flag, and the discrete speech
// projection) are translated into controller events. The controller stays
// the sole arbiter of priority; this hook never decides precedence itself.
//
// Fail-closed: with AVATAR_MOTION_V1 off the hook subscribes to nothing,
// starts no timer, and reports a constant idle mode.

const noopSubscribe = () => () => {};

function getIdleMode(): AvatarMotionMode {
  return 'idle';
}

/**
 * Constant neutral snapshot used while the motion flag is off, so the
 * disabled path creates no subscription and allocates nothing per render.
 */
const DISABLED_MOTION_SNAPSHOT: AvatarDiscreteMotionSnapshot = Object.freeze({
  actorId: null,
  sessionId: null,
  stylistId: null,
  avatarId: null,
  generation: 0,
  phase: 'idle',
  source: null,
  speaking: false,
  mouth: 'closed',
});

function getDisabledMotionSnapshot(): AvatarDiscreteMotionSnapshot {
  return DISABLED_MOTION_SNAPSHOT;
}

export interface AvatarConversationSignals {
  /** True while the composer holds meaningful (non-whitespace) input. */
  inputActive: boolean;
  /** True while a message send/generation is in flight. */
  isSending: boolean;
  /**
   * Currently selected avatar. Changing it is a teardown boundary: motion
   * belonging to the previous avatar must not carry over to the new one.
   */
  avatarId?: string | null;
  /**
   * Anti-flicker hysteresis before listening engages. Defaults to the
   * transition policy; injectable for deterministic tests only. Typing is
   * never delayed by this — it only schedules the avatar's reaction.
   */
  hysteresisMs?: number;
}

export function useAvatarConversationMotion({
  inputActive,
  isSending,
  avatarId = null,
  hysteresisMs = MOTION_TRANSITION_POLICY.listeningHysteresisMs,
}: AvatarConversationSignals): void {
  const enabled = AVATAR_MOTION_V1_ENABLED;
  const speech = useSyncExternalStore(
    enabled ? subscribeToAvatarMotion : noopSubscribe,
    enabled ? getAvatarMotionSnapshot : getDisabledMotionSnapshot,
    enabled ? getAvatarMotionSnapshot : getDisabledMotionSnapshot,
  );
  const lastPhaseRef = useRef<string>('idle');

  // Playback events: native playing is the only entry into speaking; leaving
  // playing releases it; a terminal error degrades to neutral idle.
  const phase = speech.phase;
  const generation = speech.generation;
  const mouth = speech.mouth;
  useEffect(() => {
    if (!enabled) return;
    const controller = getSharedAvatarMotionController();
    const previousPhase = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (phase === 'playing') {
      if (previousPhase !== 'playing') controller.reportPlaybackActive(generation);
      controller.reportPlaybackMouth(generation, mouth);
      return;
    }
    if (previousPhase === 'playing') controller.reportPlaybackEnded(generation);
    if (phase === 'error') controller.reportSpeechFailed(generation);
  }, [enabled, phase, generation, mouth]);

  // Conversation signals. Sending — and the window where a response is
  // persisted but audio is still being prepared — reads as thinking;
  // meaningful input engages listening after a short hysteresis; a cleared
  // composer releases to idle (the controller ignores the release while a
  // higher-priority state is active).
  const preparingToSpeak = phase === 'requesting' || phase === 'ready';
  useEffect(() => {
    if (!enabled) return;
    const controller = getSharedAvatarMotionController();
    if (isSending || preparingToSpeak) {
      controller.requestMode('thinking');
      return;
    }
    if (inputActive) {
      const timer = setTimeout(() => {
        controller.requestMode('listening');
      }, Math.max(0, hysteresisMs));
      // Cancelling the pending hysteresis is itself a teardown path: the
      // timer must never survive the render that scheduled it.
      return () => clearTimeout(timer);
    }
    controller.requestMode('idle');
  }, [enabled, inputActive, isSending, preparingToSpeak, hysteresisMs]);

  // KAVA-P2-002 — teardown boundaries.
  //
  // The controller is shared and outlives any single surface, so every path
  // that ends this surface's ownership of it must return it to neutral idle
  // and invalidate the current motion generation. Without this, a mode such
  // as thinking or speaking survived unmount and the next entry into
  // StyleChat inherited it.
  //
  // Covered here: unmount, navigation away (which unmounts the screen),
  // avatar change (keyed by avatarId), and app background/inactive via the
  // service-owned AppState listener. The listening timer is cancelled by the
  // effect above, which React runs before this cleanup.
  useEffect(() => {
    if (!enabled) return;
    // Touch the controller so a reset always has an instance to act on.
    getSharedAvatarMotionController();
    ensureAvatarSpeechLifecycleListener();
    const unregister = registerAvatarInterruptionHandler(() => {
      resetSharedAvatarMotionController();
      lastPhaseRef.current = 'idle';
    });
    return () => {
      unregister();
      resetSharedAvatarMotionController();
      lastPhaseRef.current = 'idle';
    };
  }, [enabled, avatarId]);
}

/**
 * Current semantic motion mode for display (header state, status text).
 * Constant idle when the motion flag is off — no controller subscription is
 * created in the fail-closed configuration.
 */
export function useAvatarMotionMode(): AvatarMotionMode {
  return useSyncExternalStore(
    AVATAR_MOTION_V1_ENABLED
      ? (listener: () => void) => getSharedAvatarMotionController().subscribe(listener)
      : noopSubscribe,
    AVATAR_MOTION_V1_ENABLED
      ? () => getSharedAvatarMotionController().getSnapshot().mode
      : getIdleMode,
    AVATAR_MOTION_V1_ENABLED
      ? () => getSharedAvatarMotionController().getSnapshot().mode
      : getIdleMode,
  );
}
