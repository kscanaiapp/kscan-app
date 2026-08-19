import type { AvatarSpeechPhase, AvatarSpeechState } from '../../stores/avatarSpeechStore';

export interface VoiceRetryScope {
  actorId: string | null;
  sessionId: string;
  messageId: string;
  avatarId: string;
}

export interface VoiceRetryPhaseInput {
  ownsSpeechState: boolean;
  phase: AvatarSpeechPhase;
}

/**
 * The shared speech store holds one operation at a time, so a message may only
 * present recovery UI while every scope field belongs to it. This is what keeps
 * a failure from a previous session, a different account, or a superseded
 * avatar from surfacing on an unrelated reply.
 */
export function ownsAvatarSpeechScope(
  speech: AvatarSpeechState,
  scope: VoiceRetryScope,
): boolean {
  return Boolean(scope.actorId) &&
    speech.actorId === scope.actorId &&
    speech.sessionId === scope.sessionId &&
    speech.messageId === scope.messageId &&
    speech.avatarId === scope.avatarId &&
    speech.stylistId === scope.avatarId;
}

const IN_FLIGHT_PHASES: readonly AvatarSpeechPhase[] = ['requesting', 'ready', 'stopping'];

/**
 * A failure is remembered locally because the store moves on as soon as a retry
 * begins. Losing scope ownership means a newer attempt superseded this message,
 * and confirmed playback means the reply was finally spoken; both retire the
 * control.
 */
export function nextVoiceRetryFailedState(
  previousFailed: boolean,
  input: VoiceRetryPhaseInput,
): boolean {
  if (!input.ownsSpeechState) return false;
  if (input.phase === 'error') return true;
  if (input.phase === 'playing') return false;
  return previousFailed;
}

/** Retry is unavailable while this message already has speech in progress. */
export function isVoiceRetryInFlight(input: VoiceRetryPhaseInput): boolean {
  return input.ownsSpeechState && IN_FLIGHT_PHASES.includes(input.phase);
}
