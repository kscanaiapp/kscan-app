import * as Speech from 'expo-speech';
import type { AvatarSpeechProfile, AvatarSpeechSource } from './types';
import {
  markError,
  markSpeaking,
  markStopped,
  markStopping,
  resetActor,
  resetAvatar,
  startUtterance,
} from './avatarSpeechStore';
import { resolveVoice } from './voiceResolver';

/**
 * Global speech mutex.
 *
 * - Each utterance receives a unique generation token.
 * - The newest authorized request wins; stale callbacks are ignored.
 * - All speech operations are serialized through Speech.stop().
 * - No unbounded queue is created.
 */

let currentGeneration = 0;
let pendingStop: Promise<void> | null = null;

function invalidateGeneration() {
  currentGeneration += 1;
  return currentGeneration;
}

function isCurrent(generation: number): boolean {
  return generation === currentGeneration;
}

export interface SpeakUtterancePayload {
  text: string;
  actorKey: string;
  avatarId: string;
  utteranceKey: string;
  source: AvatarSpeechSource;
  voiceProfile: AvatarSpeechProfile;
}

/**
 * Speak a single utterance with serialized lifecycle management.
 *
 * Rapid navigation and rapid Play taps cannot create overlapping utterances
 * because each new call invalidates the previous generation token.
 */
export async function speakUtterance(payload: SpeakUtterancePayload): Promise<void> {
  const generation = invalidateGeneration();

  startUtterance({
    actorKey: payload.actorKey,
    avatarId: payload.avatarId,
    utteranceKey: payload.utteranceKey,
    source: payload.source,
  });

  // Serialize with any in-flight speech/stop.
  markStopping();
  const stopToAwait = pendingStop;
  if (stopToAwait) {
    await stopToAwait;
  }
  if (!isCurrent(generation)) return;

  const voiceResult = await resolveVoice(payload.voiceProfile);
  if (!voiceResult.voice) {
    markError(`Voice unavailable: ${voiceResult.reason}`);
    return;
  }

  Speech.speak(payload.text, {
    voice: voiceResult.voice.identifier,
    rate: 0.95,
    pitch: 1.0,
    onStart: () => {
      if (!isCurrent(generation)) return;
      markSpeaking();
    },
    onDone: () => {
      if (!isCurrent(generation)) return;
      markStopped();
    },
    onStopped: () => {
      if (!isCurrent(generation)) return;
      markStopped();
    },
    onError: (error) => {
      if (!isCurrent(generation)) return;
      markError(error.message || 'Speech playback error');
    },
  });
}

/**
 * Stop any active speech and invalidate the current generation token.
 */
export async function stopSpeech(): Promise<void> {
  const generation = invalidateGeneration();
  markStopping();
  const stopPromise = Speech.stop();
  pendingStop = stopPromise;
  try {
    await stopPromise;
  } finally {
    if (pendingStop === stopPromise) {
      pendingStop = null;
    }
  }
  if (isCurrent(generation)) {
    markStopped();
  }
}

/**
 * Cancel speech for a specific actor without affecting a newer request.
 */
export function stopActorSpeech(actorKey: string): void {
  resetActor(actorKey);
  void Speech.stop();
}

/**
 * Cancel speech for a specific avatar without affecting a newer request.
 */
export function stopAvatarSpeech(avatarId: string): void {
  resetAvatar(avatarId);
  void Speech.stop();
}
