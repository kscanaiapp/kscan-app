import * as Speech from 'expo-speech';
import type { StylistVoiceProfile } from '../constants/stylistIdentity';
import {
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

  startAvatarSpeech({
    actorKey: payload.actorKey,
    avatarId: payload.avatarId,
    utteranceKey: payload.utteranceKey,
    source: payload.source,
  });

  markAvatarSpeechStopping();
  const stopToAwait = pendingStop;
  if (stopToAwait) {
    await stopToAwait;
  }
  if (!isCurrent(generation)) return;

  const voiceResult = await resolveAvatarSpeechVoice(payload.voiceProfile);
  if (!voiceResult.voice) {
    setAvatarSpeechError(`Voice unavailable: ${voiceResult.reason}`);
    return;
  }

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
      stopAvatarSpeech();
    },
    onStopped: () => {
      if (!isCurrent(generation)) return;
      stopAvatarSpeech();
    },
    onError: (error) => {
      if (!isCurrent(generation)) return;
      setAvatarSpeechError(error.message || 'Speech playback error');
    },
  });
}

/**
 * Stop any active speech and invalidate the current generation token.
 */
export async function stopAvatarSpeechPlayback(): Promise<void> {
  const generation = invalidateGeneration();
  markAvatarSpeechStopping();
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
    stopAvatarSpeech();
  }
}
