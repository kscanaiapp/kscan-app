import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useReducedMotion } from './useReducedMotion';
import { useAvatarIdlePresence } from './useAvatarIdlePresence';
import { useAvatarSpeechState } from '../stores/avatarSpeechStore';
import { resolveStylistVisualAvatarId } from '../constants/stylistIdentity';
import { getAvatarEngineAdapter } from '../services/avatars/avatarEngineAdapter';
import { resolveAvatarMotionEpoch } from '../services/avatars/avatarMotionEpoch';

/** Shared V10 host for visible Home and Chat avatars; Speech remains the clock. */
export function useStylistAvatarVisual({ actorId, sessionId, messageId, avatarId, isThinking = false }: {
  actorId: string | null;
  sessionId?: string;
  messageId?: string;
  avatarId: string;
  isThinking?: boolean;
}) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => setForeground(status === 'active'));
    return () => subscription.remove();
  }, []);
  const reducedMotion = useReducedMotion();
  const speechState = useAvatarSpeechState();
  const visualAvatarId = resolveStylistVisualAvatarId(avatarId);
  const speechScopeMatches =
    Boolean(focused && foreground && actorId && sessionId) &&
    speechState.actorId === actorId &&
    speechState.sessionId === sessionId &&
    speechState.stylistId === avatarId &&
    speechState.avatarId === avatarId &&
    (!messageId || speechState.messageId === messageId);
  const isSpeaking = speechScopeMatches && speechState.phase === 'playing';

  // MOTION AUTHORITY, one owner per channel:
  //
  //   ambient scale   AnimatedStylistAvatar's own loop, always, never here.
  //   head rotation   the engine, sole owner.
  //   breathing       the engine, sole owner.
  //
  // The engine's two channels are a function of the clock it is handed, and
  // that clock has exactly one driver at a time. While SPEAKING, playback
  // progress re-renders this header ~12.5 times a second and drives it. While
  // IDLE, nothing re-renders, so the ticker below drives it — and is disabled
  // during speech precisely so the two never run at once.
  const idleTick = useAvatarIdlePresence({ enabled: focused && !reducedMotion && !isSpeaking });

  // One engine call per render answers the mouth AND the idle presence
  // channels. `headMotion` and `breathing` were already being calculated here
  // and thrown away, which is why the avatar froze completely while speaking.
  const visual = useMemo(() => {
    // A hidden stacked route must not reset the process engine or motion epoch.
    if (!focused || !foreground) return {
      mouthState: 'closed' as const, mouthTransition: null,
      motion: { headRotateDeg: 0, breathingScale: 1 },
    };
    const result = getAvatarEngineAdapter().computeFrame({
      avatarId: visualAvatarId,
      speech: speechState,
      scopeMatches: speechScopeMatches,
      reduceMotion: reducedMotion,
      // Hidden/background hosts return above without touching the engine.
      foreground,
      motionEpoch: resolveAvatarMotionEpoch({
        actorId,
        sessionId: sessionId ?? null,
        avatarId: visualAvatarId,
      }),
      hostNowMs: Date.now(),
      ...(isThinking ? { semanticMode: 'thinking' as const } : {}),
    });
    return {
      mouthState: result.mouthState,
      mouthTransition: result.applied && isSpeaking ? result.frame.mouthTransition : null,
      motion: {
        headRotateDeg: result.frame.headMotion.rotateDeg,
        breathingScale: result.frame.breathing.scale,
      },
    };
  }, [
    focused,
    foreground,
    visualAvatarId,
    speechState,
    speechScopeMatches,
    reducedMotion,
    actorId,
    sessionId,
    isThinking,
    isSpeaking,
    // The ticker's only job: make this memo recompute so `Date.now()` above
    // moves while idle. The value itself is never read.
    idleTick,
  ]);

  // Diagnostic only: correlate each visible mouth transition to the native
  // playback clock in a development device run. No actor/session identifiers,
  // transcript or provider payload ever enter this trace.
  const lastMotionTrace = useRef<string>('');
  useEffect(() => {
    if (typeof __DEV__ === 'undefined' || !__DEV__ || !focused) return;
    const key = [
      speechState.generation,
      speechState.phase,
      speechScopeMatches,
      reducedMotion,
      visual.mouthState,
    ].join(':');
    if (key === lastMotionTrace.current) return;
    lastMotionTrace.current = key;
    console.info('[EliseV10 frame]', {
      phase: speechState.phase,
      scopeMatches: speechScopeMatches,
      reduceMotion: reducedMotion,
      generation: speechState.generation,
      mouthState: visual.mouthState,
      playbackSeconds: speechState.playbackSeconds,
    });
  }, [
    focused,
    speechState.generation,
    speechState.phase,
    speechState.playbackSeconds,
    speechScopeMatches,
    reducedMotion,
    visual.mouthState,
  ]);

  return { visualAvatarId, reducedMotion, isSpeaking, visual };
}
