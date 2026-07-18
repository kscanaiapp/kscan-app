import {
  beginAvatarSpeech,
  finishAvatarSpeech,
  getAvatarSpeechState,
  isAvatarSpeechScopeActive,
  markAvatarSpeechPlaying,
  markAvatarSpeechReady,
  markAvatarSpeechStopping,
  setAvatarSpeechError,
  updateAvatarSpeechPlayback,
  type AvatarSpeechSource,
} from '../stores/avatarSpeechStore';
import {
  playStylistAudio,
  type StylistAudioPlaybackHandle,
} from './avatars/stylistAudioPlayback';
import {
  createTemporaryStylistSpeechFile,
  deleteTemporaryStylistSpeechFile,
} from './avatars/stylistSpeechFiles';
import { requestStylistSpeech } from './avatars/stylistSpeechClient';

export interface SpeakAvatarMessagePayload {
  actorId: string;
  sessionId: string;
  messageId: string;
  stylistId: string;
  avatarId: string;
  source: AvatarSpeechSource;
}

export interface AvatarSpeechScope {
  actorId?: string;
  sessionId?: string;
  avatarId?: string;
}

const MAX_ATTEMPTED_MESSAGE_KEYS = 200;

let generation = 0;
let pendingController: AbortController | null = null;
let activePlayer: StylistAudioPlaybackHandle | null = null;
let activeFileUri: string | null = null;
let currentScope: SpeakAvatarMessagePayload | null = null;
const attemptedKeys = new Set<string>();
const attemptedOrder: string[] = [];

function nextGeneration(): number {
  generation += 1;
  return generation;
}

function isCurrent(value: number): boolean {
  return generation === value;
}

function operationKey(payload: SpeakAvatarMessagePayload): string {
  return [
    payload.actorId,
    payload.sessionId,
    payload.messageId,
    payload.stylistId,
  ].join(':');
}

function rememberAttempt(key: string): boolean {
  if (attemptedKeys.has(key)) return false;
  attemptedKeys.add(key);
  attemptedOrder.push(key);
  while (attemptedOrder.length > MAX_ATTEMPTED_MESSAGE_KEYS) {
    const oldest = attemptedOrder.shift();
    if (oldest) attemptedKeys.delete(oldest);
  }
  return true;
}

function forgetAttempt(key: string): void {
  if (!attemptedKeys.delete(key)) return;
  const index = attemptedOrder.indexOf(key);
  if (index >= 0) attemptedOrder.splice(index, 1);
}

function matchesScope(payload: SpeakAvatarMessagePayload, scope?: AvatarSpeechScope): boolean {
  if (!scope) return true;
  if (scope.actorId && payload.actorId !== scope.actorId) return false;
  if (scope.sessionId && payload.sessionId !== scope.sessionId) return false;
  if (scope.avatarId && payload.avatarId !== scope.avatarId) return false;
  return true;
}

async function releaseResources(): Promise<void> {
  const controller = pendingController;
  const player = activePlayer;
  const fileUri = activeFileUri;
  pendingController = null;
  activePlayer = null;
  activeFileUri = null;
  controller?.abort();
  player?.stop();
  await deleteTemporaryStylistSpeechFile(fileUri);
}

async function finishCurrent(value: number): Promise<void> {
  if (!isCurrent(value)) return;
  await releaseResources();
  if (!isCurrent(value)) return;
  currentScope = null;
  finishAvatarSpeech(value);
}

async function failCurrent(value: number): Promise<void> {
  if (!isCurrent(value)) return;
  await releaseResources();
  if (!isCurrent(value)) return;
  currentScope = null;
  // Surface a terminal failure briefly, then return to idle so the avatar
  // cannot remain stuck in a non-playing speaking/error phase.
  setAvatarSpeechError(value, 'Speech is temporarily unavailable.');
  finishAvatarSpeech(value);
}

/**
 * Requests and plays one newly persisted assistant message. The service accepts
 * references only; the authenticated Edge Function owns text and voice lookup.
 */
export async function speakAvatarMessage(payload: SpeakAvatarMessagePayload): Promise<void> {
  if (
    !payload.actorId ||
    !payload.sessionId ||
    !payload.messageId ||
    !payload.stylistId ||
    !payload.avatarId ||
    payload.stylistId !== payload.avatarId
  ) return;
  const key = operationKey(payload);
  // Reserve the attempt immediately to prevent concurrent duplicate billing,
  // but release it when the provider request fails so a transient mismatch can
  // retry once eligibility recovers.
  if (!rememberAttempt(key)) return;

  const requestGeneration = nextGeneration();
  await releaseResources();
  if (!isCurrent(requestGeneration)) return;

  currentScope = payload;
  beginAvatarSpeech({ ...payload, generation: requestGeneration });
  const controller = new AbortController();
  pendingController = controller;

  try {
    const speech = await requestStylistSpeech({
      actorId: payload.actorId,
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      stylistId: payload.stylistId,
      signal: controller.signal,
    });
    if (!isCurrent(requestGeneration)) return;
    pendingController = null;

    const uri = await createTemporaryStylistSpeechFile({
      actorId: payload.actorId,
      sessionId: payload.sessionId,
      messageId: payload.messageId,
      stylistId: payload.stylistId,
      voiceProfile: speech.voiceProfile,
      audioBase64: speech.audioBase64,
    });
    if (!isCurrent(requestGeneration)) {
      await deleteTemporaryStylistSpeechFile(uri);
      return;
    }
    activeFileUri = uri;
    markAvatarSpeechReady(requestGeneration, speech.alignment);

    activePlayer = await playStylistAudio(uri, {
      onPlaybackStarted: () => {
        if (isCurrent(requestGeneration)) markAvatarSpeechPlaying(requestGeneration);
      },
      onPlaybackProgress: (seconds) => {
        if (isCurrent(requestGeneration)) {
          updateAvatarSpeechPlayback(requestGeneration, seconds);
        }
      },
      onPlaybackFinished: () => {
        void finishCurrent(requestGeneration);
      },
      onPlaybackError: () => {
        void failCurrent(requestGeneration);
      },
    });
    if (!isCurrent(requestGeneration)) {
      activePlayer.stop();
      activePlayer = null;
      await deleteTemporaryStylistSpeechFile(uri);
    }
  } catch {
    forgetAttempt(key);
    if (isCurrent(requestGeneration)) await failCurrent(requestGeneration);
  }
}

/** Stops pending generation or playback only when the optional scope matches. */
export async function stopAvatarSpeechPlayback(scope?: AvatarSpeechScope): Promise<void> {
  const store = getAvatarSpeechState();
  const pendingMatches = currentScope ? matchesScope(currentScope, scope) : false;
  const storeMatches = !scope || (
    store.phase !== 'idle' &&
    (!scope.actorId || store.actorId === scope.actorId) &&
    (!scope.sessionId || store.sessionId === scope.sessionId) &&
    (!scope.avatarId || store.avatarId === scope.avatarId)
  );
  if (scope && !pendingMatches && !storeMatches) return;

  const stoppedGeneration = nextGeneration();
  const priorGeneration = store.generation;
  if (storeMatches && isAvatarSpeechScopeActive({
    actorId: store.actorId ?? '',
    sessionId: store.sessionId ?? '',
    avatarId: store.avatarId ?? '',
  })) {
    markAvatarSpeechStopping(priorGeneration);
  }
  currentScope = null;
  await releaseResources();
  if (isCurrent(stoppedGeneration)) finishAvatarSpeech(priorGeneration);
}

/** Clear in-process speech attempt dedupe at an auth/actor boundary. */
export function resetAvatarSpeechAttempts(): void {
  attemptedKeys.clear();
  attemptedOrder.length = 0;
}

export const resetAvatarSpeechAttemptsForTests = resetAvatarSpeechAttempts;
