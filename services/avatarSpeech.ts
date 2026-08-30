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
import {
  ensureSpeechAppStateListener,
  registerSpeechInterruptionHandler,
} from './avatars/speechAppState';

/**
 * `auto` is StyleChat speaking a newly persisted message on its own and must
 * never repeat a message that already spoke. `retry` is an explicit user action
 * on a failed message, so it is allowed past the success record while still
 * obeying in-flight suppression, generation isolation, and scope matching.
 */
export type AvatarSpeechTrigger = 'auto' | 'retry';

export interface SpeakAvatarMessagePayload {
  actorId: string;
  sessionId: string;
  messageId: string;
  stylistId: string;
  avatarId: string;
  source: AvatarSpeechSource;
  trigger?: AvatarSpeechTrigger;
}

export interface AvatarSpeechScope {
  actorId?: string;
  sessionId?: string;
  avatarId?: string;
}

const MAX_SPOKEN_MESSAGE_KEYS = 200;

let generation = 0;
let pendingController: AbortController | null = null;
let activePlayer: StylistAudioPlaybackHandle | null = null;
let activeFileUri: string | null = null;
let currentScope: SpeakAvatarMessagePayload | null = null;
// The operation currently being generated or played. Exactly one speech
// operation is active at a time, so a single key suppresses a duplicate
// concurrent attempt without also making a failure permanent.
let inFlightKey: string | null = null;
// Operations that reached confirmed native playback. Only a successful start
// retires a message from automatic speech.
const spokenKeys = new Set<string>();
const spokenOrder: string[] = [];

// Bound lazily on the first speech request rather than at import time, so a
// module load in a non-native context (tests, tooling) never touches AppState.
let speechLifecycleBound = false;

function ensureSpeechLifecycleBound(): void {
  if (!speechLifecycleBound) {
    speechLifecycleBound = true;
    // Delegates to this module's own authoritative teardown; the interruption
    // path adds no second cleanup system.
    registerSpeechInterruptionHandler(() => {
      void stopAvatarSpeechPlayback();
    });
  }
  ensureSpeechAppStateListener();
}

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

function rememberSpoken(key: string): void {
  if (spokenKeys.has(key)) return;
  spokenKeys.add(key);
  spokenOrder.push(key);
  while (spokenOrder.length > MAX_SPOKEN_MESSAGE_KEYS) {
    const oldest = spokenOrder.shift();
    if (oldest) spokenKeys.delete(oldest);
  }
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
  inFlightKey = null;
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
  setAvatarSpeechError(value, 'Speech is temporarily unavailable.');
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

  ensureSpeechLifecycleBound();
  const key = operationKey(payload);
  // A duplicate concurrent attempt is suppressed for both triggers so a retry
  // tap cannot start a second player alongside an in-flight attempt.
  if (inFlightKey === key) return;
  // Only automatic speech is retired by a previous success; an explicit retry
  // is the user asking for this message again.
  if ((payload.trigger ?? 'auto') === 'auto' && spokenKeys.has(key)) return;

  const requestGeneration = nextGeneration();
  await releaseResources();
  if (!isCurrent(requestGeneration)) return;

  inFlightKey = key;
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
        if (!isCurrent(requestGeneration)) return;
        // Confirmed native playback — not merely a play() call — is what retires
        // this message from automatic speech.
        rememberSpoken(key);
        markAvatarSpeechPlaying(requestGeneration);
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

export function resetAvatarSpeechAttemptsForTests(): void {
  spokenKeys.clear();
  spokenOrder.length = 0;
  inFlightKey = null;
}
