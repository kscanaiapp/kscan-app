/**
 * Pure Voice Scan UI state machine. No React, no native module, no timers --
 * `useVoiceScan` is a thin hook that dispatches events here and reacts to
 * the resulting state. Kept pure and separate so the transition rules
 * (review is mandatory; nothing reaches Commerce from `listening`) are
 * unit-testable without a React Native runtime.
 */
import type { VoiceRecognitionState, VoiceUnavailableReason } from './voiceTypes';

export type VoiceStateMachineEvent =
  | { type: 'MIC_TAPPED' }
  | { type: 'NOT_KPLUS' }
  | { type: 'FLAG_DISABLED' }
  | { type: 'PERMISSION_GRANTED' }
  | { type: 'PERMISSION_DENIED'; permanent: boolean }
  | { type: 'ON_DEVICE_UNAVAILABLE' }
  | { type: 'LISTENING_STARTED' }
  | { type: 'USER_STOP' }
  | { type: 'USER_CANCEL' }
  | { type: 'SESSION_ENDED_BY_NATIVE' }
  | { type: 'FINALIZED_WITH_TRANSCRIPT' }
  | { type: 'FINALIZED_EMPTY' }
  | { type: 'RECOGNIZER_ERROR' }
  | { type: 'ACCEPT_DRAFT' }
  | { type: 'DISMISS' };

export interface VoiceStateMachineResult {
  state: VoiceRecognitionState;
  unavailableReason: VoiceUnavailableReason | null;
}

const UNCHANGED = (
  current: VoiceRecognitionState,
): VoiceStateMachineResult => ({ state: current, unavailableReason: null });

/**
 * A single, exhaustive transition table. `default` for any (state, event)
 * pair not explicitly handled is "ignore the event" -- an unexpected event
 * (e.g. a stray native callback after cancel) must never move the machine
 * sideways into an inconsistent state.
 */
export function reduceVoiceState(
  current: VoiceRecognitionState,
  event: VoiceStateMachineEvent,
): VoiceStateMachineResult {
  switch (event.type) {
    case 'MIC_TAPPED':
      if (current === 'idle' || current === 'error' || current === 'cancelled' || current === 'unavailable') {
        return { state: 'requesting_permission', unavailableReason: null };
      }
      return UNCHANGED(current);

    case 'NOT_KPLUS':
      return { state: 'unavailable', unavailableReason: 'not_kplus' };

    case 'FLAG_DISABLED':
      return { state: 'unavailable', unavailableReason: 'flag_disabled' };

    case 'PERMISSION_GRANTED':
      if (current !== 'requesting_permission') return UNCHANGED(current);
      return { state: 'listening', unavailableReason: null };

    case 'PERMISSION_DENIED':
      if (current !== 'requesting_permission') return UNCHANGED(current);
      return {
        state: 'unavailable',
        unavailableReason: event.permanent ? 'permission_denied_permanently' : 'permission_denied',
      };

    case 'ON_DEVICE_UNAVAILABLE':
      if (current !== 'requesting_permission' && current !== 'listening') return UNCHANGED(current);
      return { state: 'unavailable', unavailableReason: 'on_device_recognition_unavailable' };

    case 'LISTENING_STARTED':
      if (current !== 'requesting_permission') return UNCHANGED(current);
      return { state: 'listening', unavailableReason: null };

    case 'USER_STOP':
      if (current !== 'listening') return UNCHANGED(current);
      return { state: 'finalizing', unavailableReason: null };

    case 'USER_CANCEL':
      // Cancel is always accepted, from any state -- it is the universal
      // escape hatch and must never be refused mid-session.
      return { state: 'cancelled', unavailableReason: null };

    case 'SESSION_ENDED_BY_NATIVE':
      // The OS finalized on its own (15s cap, natural end-of-speech). This
      // NEVER auto-submits -- it only moves to 'finalizing', same as an
      // explicit user stop, and still requires FINALIZED_WITH_TRANSCRIPT to
      // reach 'reviewing'.
      if (current !== 'listening') return UNCHANGED(current);
      return { state: 'finalizing', unavailableReason: null };

    case 'FINALIZED_WITH_TRANSCRIPT':
      // The only door into 'reviewing'. Reachable only from 'finalizing' --
      // there is no path from 'listening' straight to 'reviewing', and no
      // state in this machine represents "submitted"/Commerce: submission
      // happens outside this machine, via the existing TextScan submit
      // button, only once the user is looking at 'reviewing'.
      if (current !== 'finalizing') return UNCHANGED(current);
      return { state: 'reviewing', unavailableReason: null };

    case 'FINALIZED_EMPTY':
      if (current !== 'finalizing') return UNCHANGED(current);
      return { state: 'error', unavailableReason: null };

    case 'RECOGNIZER_ERROR':
      return { state: 'error', unavailableReason: 'recognizer_error' };

    case 'ACCEPT_DRAFT':
      // The caller has copied the draft into the existing TextScan input --
      // this is NOT submission (that is a separate, later, explicit tap on
      // the existing Search/Submit button, entirely outside this machine).
      // Only reachable from 'reviewing'.
      if (current !== 'reviewing') return UNCHANGED(current);
      return { state: 'idle', unavailableReason: null };

    case 'DISMISS':
      if (current !== 'error' && current !== 'unavailable' && current !== 'cancelled') return UNCHANGED(current);
      return { state: 'idle', unavailableReason: null };

    default:
      return UNCHANGED(current);
  }
}

/** States in which no draft transcript may be retained by the caller. */
export const VOICE_STATES_REQUIRING_DRAFT_CLEAR: readonly VoiceRecognitionState[] = [
  'idle',
  'cancelled',
  'error',
  'unavailable',
];
