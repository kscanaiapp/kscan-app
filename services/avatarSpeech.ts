import * as Speech from 'expo-speech';
import type { StylistVoiceProfile } from '../constants/stylistIdentity';
import {
  getAvatarSpeechState,
  markAvatarSpeechSpeaking,
  markAvatarSpeechStopping,
  setAvatarSpeechError,
  startAvatarSpeech,
  stopAvatarSpeech,
} from '../stores/avatarSpeechStore';
import { resolveAvatarSpeechVoice } from './avatarSpeechVoice';

export type AvatarSpeechSource = 'greeting' | 'message';

export interface SpeakAvatarTextPayload {
  text: string;
  actorKey: string;
  sessionId: string;
  avatarId: string;
  utteranceKey: string;
  source: AvatarSpeechSource;
  voiceProfile: StylistVoiceProfile;
}

/**
 * Global speech mutex.
 *
 * - Each utterance gets a unique generation token.
 * - The newest authorized request wins; stale callbacks are ignored.
 * - Speech operations are serialized through `Speech.stop()`.
 * - No unbounded queue is created.
 */

let currentGeneration = 0;
let pendingStop: Promise<void> | null = null;
let currentScope: Pick<SpeakAvatarTextPayload, 'actorKey' | 'sessionId' | 'avatarId'> | null = null;

function invalidateGeneration(): number {
  currentGeneration += 1;
  return currentGeneration;
}

function isCurrent(generation: number): boolean {
  return generation === currentGeneration;
}

/**
 * Speak a single utterance with serialized lifecycle management.
 */
export async function speakAvatarText(payload: SpeakAvatarTextPayload): Promise<void> {
  const generation = invalidateGeneration();
  currentScope = {
    actorKey: payload.actorKey,
    sessionId: payload.sessionId,
    avatarId: payload.avatarId,
  };

  const voiceResult = await resolveAvatarSpeechVoice(payload.voiceProfile);
  if (!isCurrent(generation)) return;
  if (!voiceResult.voice) {
    currentScope = null;
    return;
  }

  const stopPromise = Speech.stop();
  pendingStop = stopPromise;
  try {
    await stopPromise;
  } catch {
    if (isCurrent(generation)) currentScope = null;
    return;
  } finally {
    if (pendingStop === stopPromise) pendingStop = null;
  }
  if (!isCurrent(generation)) return;

  startAvatarSpeech({
    actorKey: payload.actorKey,
    sessionId: payload.sessionId,
    avatarId: payload.avatarId,
    utteranceKey: payload.utteranceKey,
    generation,
    source: payload.source,
  });

  try {
    Speech.speak(payload.text, {
      voice: voiceResult.voice.identifier,
      rate: 0.95,
      pitch: 1.0,
      onStart: () => {
        if (!isCurrent(generation)) return;
        markAvatarSpeechSpeaking();
      },
      onDone: () => {
        if (!isCurrent(generation)) return;
        currentScope = null;
        stopAvatarSpeech();
      },
      onStopped: () => {
        if (!isCurrent(generation)) return;
        currentScope = null;
        stopAvatarSpeech();
      },
      onError: (error) => {
        if (!isCurrent(generation)) return;
        currentScope = null;
        setAvatarSpeechError(error.message || 'Speech playback error');
      },
    });
  } catch (error: unknown) {
    if (!isCurrent(generation)) return;
    currentScope = null;
    setAvatarSpeechError(
      error instanceof Error ? error.message : 'Speech playback error',
    );
  }
}

/**
 * Stop any active speech and invalidate the current generation token.
 */
export async function stopAvatarSpeechPlayback(
  scope?: Pick<SpeakAvatarTextPayload, 'actorKey' | 'sessionId' | 'avatarId'>,
): Promise<void> {
  const speechState = getAvatarSpeechState();
  const pendingScopeMatches = !scope || Boolean(
    currentScope &&
    currentScope.actorKey === scope.actorKey &&
    currentScope.sessionId === scope.sessionId &&
    currentScope.avatarId === scope.avatarId
  );
  const stateScopeMatches = !scope || (
    speechState.actorKey === scope.actorKey &&
    speechState.sessionId === scope.sessionId &&
    speechState.avatarId === scope.avatarId
  );
  if (
    scope &&
    !pendingScopeMatches &&
    !stateScopeMatches
  ) {
    return;
  }

  const generation = invalidateGeneration();
  currentScope = null;
  const activeStateMatches = stateScopeMatches;
  if (activeStateMatches) markAvatarSpeechStopping();
  const stopPromise = Speech.stop();
  pendingStop = stopPromise;
  try {
    await stopPromise;
  } catch {
    // Device stop failures are non-fatal; the scoped store still clears below.
  } finally {
    if (pendingStop === stopPromise) {
      pendingStop = null;
    }
  }
  if (isCurrent(generation) && activeStateMatches) {
    stopAvatarSpeech();
  }
}
