import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICESCAN_ENABLED } from '../constants/featureFlags';
import {
  reduceVoiceState,
  VOICE_STATES_REQUIRING_DRAFT_CLEAR,
  type VoiceStateMachineEvent,
} from '../services/voice/voiceStateMachine';
import { buildVoiceTranscript, isVoiceRecognitionAvailable } from '../services/voice/voiceRecognition';
import { normalizeVoiceTranscript, validateVoiceTranscript } from '../services/voice/voiceTranscript';
import { emitVoiceEvent } from '../services/voice/voiceTelemetry';
import {
  abandonVoiceListening,
  beginVoiceListening,
  endVoiceListening,
  fetchVoiceCapabilities,
  getPlatform,
  requestVoiceRecordingPermission,
  subscribeToVoiceEvents,
} from '../services/voice/voiceNativeModule';
import type { VoiceNativeFinalResult } from '../services/voice/voiceRecognition';
import type { VoiceRecognitionState, VoiceSourceSurface, VoiceUnavailableReason } from '../services/voice/voiceTypes';

export interface UseVoiceScanOptions {
  /** Voice Scan is K+ only in V1 -- pass the caller's already-resolved entitlement. */
  isKPlusActive: boolean;
  sourceSurface?: VoiceSourceSurface;
}

export interface UseVoiceScanResult {
  state: VoiceRecognitionState;
  unavailableReason: VoiceUnavailableReason | null;
  /** Live text while listening, shown so the user sees what the recognizer is hearing. */
  partialTranscript: string;
  /** The finalized, not-yet-consumed transcript once state === 'reviewing'. */
  draftTranscript: string;
  isListening: boolean;
  isReviewing: boolean;
  /** Master kill switch -- callers should not render the mic affordance at all when false. */
  isFlagEnabled: boolean;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  cancelSession: () => void;
  /**
   * Returns the current draft transcript and resets the session to idle.
   * Callers must copy the return value into their own (existing) TextScan
   * query field -- this function does not submit anything.
   */
  acceptDraft: () => string;
  dismiss: () => void;
}

/**
 * Voice Scan session-lifecycle hook. Orchestrates the native module and the
 * pure voiceStateMachine reducer; contains no business logic of its own --
 * every decision (route invariants, review gating, on-device enforcement)
 * lives in services/voice/* and is unit-tested there.
 */
export function useVoiceScan({
  isKPlusActive,
  sourceSurface = 'text-scan',
}: UseVoiceScanOptions): UseVoiceScanResult {
  const [state, setState] = useState<VoiceRecognitionState>('idle');
  const [unavailableReason, setUnavailableReason] = useState<VoiceUnavailableReason | null>(null);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [draftTranscript, setDraftTranscript] = useState('');
  const draftRef = useRef('');
  const stateRef = useRef<VoiceRecognitionState>('idle');
  const isKPlusActiveRef = useRef(isKPlusActive);
  const sessionCounterRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);

  const dispatch = useCallback((event: VoiceStateMachineEvent) => {
    const result = reduceVoiceState(stateRef.current, event);
    stateRef.current = result.state;
    setUnavailableReason(result.unavailableReason);
    setState(result.state);
    return result;
  }, []);

  // Draft/partial transcript always clears on landing in a resting/terminal
  // state -- this is the "cancelled draft is not persisted" guarantee:
  // there is no in-memory copy of speech once the session is not actively
  // listening/finalizing/reviewing.
  useEffect(() => {
    if (VOICE_STATES_REQUIRING_DRAFT_CLEAR.includes(state)) {
      setDraftTranscript('');
      draftRef.current = '';
      setPartialTranscript('');
    }
  }, [state]);

  const applyFinalResult = useCallback(
    (raw: VoiceNativeFinalResult | null) => {
      const transcript = buildVoiceTranscript(
        raw ?? { transcript: '', locale: null, onDevice: false },
        getPlatform(),
        sourceSurface,
      );
      const normalized = normalizeVoiceTranscript(transcript.transcript);
      const validation = validateVoiceTranscript(normalized);

      if (!transcript.onDevice || validation.valid === false) {
        emitVoiceEvent('voice_transcription_failure', { source: sourceSurface, platform: getPlatform() });
        dispatch({ type: 'FINALIZED_EMPTY' });
        return;
      }

      emitVoiceEvent('voice_transcription_success', { source: sourceSurface, platform: getPlatform() });
      draftRef.current = normalized;
      setDraftTranscript(normalized);
      dispatch({ type: 'FINALIZED_WITH_TRANSCRIPT' });
    },
    [dispatch, sourceSurface],
  );

  useEffect(
    () =>
      subscribeToVoiceEvents({
        onPartialTranscript: (sessionId, transcript) => {
          if (sessionId !== activeSessionIdRef.current) return;
          setPartialTranscript(normalizeVoiceTranscript(transcript));
        },
        onSessionEndedByNative: (sessionId, result) => {
          if (sessionId !== activeSessionIdRef.current) return;
          // The state machine only accepts SESSION_ENDED_BY_NATIVE from
          // 'listening' (see reduceVoiceState); any other current state
          // means the transition would be rejected (UNCHANGED). Checking
          // that precondition here, before dispatching, guarantees
          // applyFinalResult can never run for a rejected transition -- e.g.
          // a late native callback that lands after a cancel already moved
          // the machine to 'cancelled' must not repopulate a draft.
          if (stateRef.current !== 'listening') return;
          // The 15s cap or natural end-of-speech fired without an explicit
          // stop() call. This NEVER auto-submits: it only ever reaches
          // 'finalizing' -> 'reviewing', same as a user-initiated stop.
          dispatch({ type: 'SESSION_ENDED_BY_NATIVE' });
          applyFinalResult(result);
          activeSessionIdRef.current = null;
        },
      }),
    [dispatch, applyFinalResult],
  );

  const startSession = useCallback(async () => {
    if (!VOICESCAN_ENABLED) {
      dispatch({ type: 'FLAG_DISABLED' });
      return;
    }
    if (!isKPlusActive) {
      dispatch({ type: 'NOT_KPLUS' });
      return;
    }
    if (!['idle', 'error', 'cancelled', 'unavailable'].includes(stateRef.current)) return;
    dispatch({ type: 'MIC_TAPPED' });
    const sessionId = `voice-${Date.now()}-${++sessionCounterRef.current}`;
    activeSessionIdRef.current = sessionId;

    const isCurrentEligibleAttempt = () =>
      activeSessionIdRef.current === sessionId && isKPlusActiveRef.current;

    // The entire startup sequence is one guarded block: the caller fires
    // this with `void voice.startSession();`, so any rejection anywhere in
    // here -- capability query, permission request, or begin-listening --
    // must resolve to a typed state transition, never escape as an
    // unhandled rejection.
    try {
      const capabilities = await fetchVoiceCapabilities();
      if (!isCurrentEligibleAttempt()) return;
      if (!isVoiceRecognitionAvailable(capabilities)) {
        emitVoiceEvent('voice_on_device_unavailable', { source: sourceSurface, platform: getPlatform() });
        activeSessionIdRef.current = null;
        dispatch({ type: 'ON_DEVICE_UNAVAILABLE' });
        return;
      }
      emitVoiceEvent('voice_on_device_available', { source: sourceSurface, platform: getPlatform() });

      const permission = await requestVoiceRecordingPermission();
      if (!isCurrentEligibleAttempt()) return;
      if (!permission.granted) {
        emitVoiceEvent('voice_permission_denied', { source: sourceSurface, platform: getPlatform() });
        activeSessionIdRef.current = null;
        dispatch({ type: 'PERMISSION_DENIED', permanent: !permission.canAskAgain });
        return;
      }
      emitVoiceEvent('voice_permission_granted', { source: sourceSurface, platform: getPlatform() });

      await beginVoiceListening(sessionId);
      if (!isCurrentEligibleAttempt()) {
        await abandonVoiceListening(sessionId);
        return;
      }
      dispatch({ type: 'LISTENING_STARTED' });
    } catch {
      // A rejection anywhere above only matters if this is still the
      // attempt the UI is showing. If it went stale in the meantime --
      // cancelled, unmounted, K+ lost, or superseded by a newer tap -- some
      // other path already owns (or already reset) the visible state, and
      // reporting this failure now would clobber it.
      if (isCurrentEligibleAttempt()) {
        activeSessionIdRef.current = null;
        dispatch({ type: 'RECOGNIZER_ERROR' });
      }
    }
  }, [dispatch, isKPlusActive, sourceSurface]);

  const stopSession = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId || stateRef.current !== 'listening') return;
    dispatch({ type: 'USER_STOP' });
    try {
      const result = await endVoiceListening(sessionId);
      if (sessionId !== activeSessionIdRef.current) return;
      applyFinalResult(result);
      activeSessionIdRef.current = null;
    } catch {
      dispatch({ type: 'RECOGNIZER_ERROR' });
    }
  }, [dispatch, applyFinalResult]);

  const cancelSession = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    dispatch({ type: 'USER_CANCEL' });
    emitVoiceEvent('voice_session_cancelled', { source: sourceSurface, platform: getPlatform() });
    if (sessionId) void abandonVoiceListening(sessionId);
  }, [dispatch, sourceSurface]);

  const acceptDraft = useCallback((): string => {
    const value = draftRef.current;
    dispatch({ type: 'ACCEPT_DRAFT' });
    return value;
  }, [dispatch, sourceSurface]);

  const dismiss = useCallback(() => {
    dispatch({ type: 'DISMISS' });
  }, [dispatch]);

  useEffect(() => {
    isKPlusActiveRef.current = isKPlusActive;
    if (isKPlusActive) return;
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    activeSessionIdRef.current = null;
    dispatch({ type: 'USER_CANCEL' });
    void abandonVoiceListening(sessionId);
  }, [dispatch, isKPlusActive]);

  useEffect(() => () => {
    const sessionId = activeSessionIdRef.current;
    activeSessionIdRef.current = null;
    if (sessionId) void abandonVoiceListening(sessionId);
  }, []);

  return {
    state,
    unavailableReason,
    partialTranscript,
    draftTranscript,
    isListening: state === 'listening',
    isReviewing: state === 'reviewing',
    isFlagEnabled: VOICESCAN_ENABLED,
    startSession,
    stopSession,
    cancelSession,
    acceptDraft,
    dismiss,
  };
}
