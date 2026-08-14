import { AVATAR_SPEECH_FIXTURE_ENABLED } from '../../constants/featureFlags';
import {
  beginAvatarSpeech,
  finishAvatarSpeech,
  getAvatarSpeechState,
  markAvatarSpeechPlaying,
  markAvatarSpeechReady,
  setAvatarSpeechError,
  updateAvatarSpeechPlayback,
  type AvatarSpeechAlignment,
} from '../../stores/avatarSpeechStore';
import {
  ensureAvatarSpeechLifecycleListener,
  registerAvatarInterruptionHandler,
} from '../avatarSpeechLifecycle';
import { stopAvatarSpeechPlayback } from '../avatarSpeech';
import {
  playStylistAudio,
  type StylistAudioPlaybackHandle,
} from './stylistAudioPlayback';
import {
  createTemporaryStylistSpeechFile,
  deleteTemporaryStylistSpeechFile,
} from './stylistSpeechFiles';
import { LOCAL_SPEECH_FIXTURE_AUDIO_BASE64 } from './localSpeechFixtureAudio';

// Deterministic, provider-free local speech fixture.
//
// Drives the PRODUCTION pipeline — temporary speech file, native audio
// player, speech store, discrete motion projection, renderer — from bundled
// audio and a fixed alignment. No Supabase request, no ElevenLabs request, no
// provider quota, no environment secret. The module is double-gated
// (__DEV__ plus an explicit env flag) and is not imported by any production
// UI surface; it exists so lip sync and motion QA never require the provider.

declare const __DEV__: boolean;

export const LOCAL_SPEECH_FIXTURE_TRANSCRIPT = 'Hi Elise';

/**
 * Fixed normalized alignment for the transcript. Intervals are 120 ms per
 * character — comfortably above the 100 ms minimum state duration, so the
 * resulting timeline is exactly one interval per character with no merging
 * and no inserted pauses. Linear timing is intentional here: this is the one
 * deterministic timing fixture the motion rules allow.
 */
export const LOCAL_SPEECH_FIXTURE_ALIGNMENT: AvatarSpeechAlignment = Object.freeze({
  characters: ['H', 'i', ' ', 'E', 'l', 'i', 's', 'e'],
  characterStartTimesSeconds: [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84],
  characterEndTimesSeconds: [0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.96],
});

/** Scope used when a caller does not provide one. Never a real actor. */
export const LOCAL_SPEECH_FIXTURE_SCOPE = Object.freeze({
  actorId: 'local-fixture-actor',
  sessionId: 'local-fixture-session',
  messageId: 'local-fixture-message',
  stylistId: 'stylist_portrait_01',
  avatarId: 'stylist_portrait_01',
});

export function isLocalSpeechFixtureEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ && AVATAR_SPEECH_FIXTURE_ENABLED;
}

let activeHandle: StylistAudioPlaybackHandle | null = null;
let activeFileUri: string | null = null;
let activeGeneration = 0;
let interruptionRegistered = false;

async function releaseFixtureResources(): Promise<void> {
  const handle = activeHandle;
  const fileUri = activeFileUri;
  activeHandle = null;
  activeFileUri = null;
  handle?.stop();
  await deleteTemporaryStylistSpeechFile(fileUri);
}

/** Stop fixture playback and return the store to neutral idle. */
export async function stopLocalSpeechFixture(): Promise<void> {
  const generation = activeGeneration;
  activeGeneration = 0;
  await releaseFixtureResources();
  if (generation > 0 && getAvatarSpeechState().generation === generation) {
    finishAvatarSpeech(generation);
  }
}

function isCurrentFixtureSpeech(generation: number): boolean {
  const state = getAvatarSpeechState();
  return (
    generation === activeGeneration &&
    state.generation === generation &&
    state.phase !== 'idle'
  );
}

export interface PlayLocalSpeechFixtureInput {
  /** Overrides the bundled fixture audio; tests only. */
  audioBase64?: string;
  scope?: typeof LOCAL_SPEECH_FIXTURE_SCOPE;
}

/**
 * Play the fixture through the production chain. Returns true when playback
 * was started. Always a no-op outside the __DEV__ + flag gate.
 */
export async function playLocalSpeechFixture(
  input: PlayLocalSpeechFixtureInput = {},
): Promise<boolean> {
  if (!isLocalSpeechFixtureEnabled()) return false;
  const audioBase64 = input.audioBase64 ?? LOCAL_SPEECH_FIXTURE_AUDIO_BASE64;
  if (!audioBase64) return false;
  const scope = input.scope ?? LOCAL_SPEECH_FIXTURE_SCOPE;

  ensureAvatarSpeechLifecycleListener();
  if (!interruptionRegistered) {
    interruptionRegistered = true;
    registerAvatarInterruptionHandler(() => {
      void stopLocalSpeechFixture();
    });
  }

  // Interrupt any real speech first, then any prior fixture run.
  await stopAvatarSpeechPlayback();
  await stopLocalSpeechFixture();

  const generation = getAvatarSpeechState().generation + 1;
  activeGeneration = generation;
  beginAvatarSpeech({
    actorId: scope.actorId,
    sessionId: scope.sessionId,
    messageId: scope.messageId,
    stylistId: scope.stylistId,
    avatarId: scope.avatarId,
    generation,
    source: 'message',
  });

  try {
    const uri = await createTemporaryStylistSpeechFile({
      actorId: scope.actorId,
      sessionId: scope.sessionId,
      messageId: scope.messageId,
      stylistId: scope.stylistId,
      voiceProfile: 'feminine',
      audioBase64,
    });
    if (generation !== activeGeneration) {
      await deleteTemporaryStylistSpeechFile(uri);
      return false;
    }
    activeFileUri = uri;

    // Audio ready is not speaking: the store enters `ready` here and only the
    // native onPlaybackStarted callback below can move it to `playing`.
    markAvatarSpeechReady(generation, LOCAL_SPEECH_FIXTURE_ALIGNMENT);

    activeHandle = await playStylistAudio(uri, {
      onPlaybackStarted: () => {
        if (isCurrentFixtureSpeech(generation)) markAvatarSpeechPlaying(generation);
      },
      onPlaybackProgress: (seconds) => {
        if (isCurrentFixtureSpeech(generation)) {
          updateAvatarSpeechPlayback(generation, seconds);
        }
      },
      onPlaybackFinished: () => {
        if (generation !== activeGeneration) return;
        activeGeneration = 0;
        void releaseFixtureResources();
        finishAvatarSpeech(generation);
      },
      onPlaybackError: () => {
        if (generation !== activeGeneration) return;
        activeGeneration = 0;
        void releaseFixtureResources();
        setAvatarSpeechError(generation, 'Speech is temporarily unavailable.');
        finishAvatarSpeech(generation);
      },
    });
    return true;
  } catch {
    activeGeneration = 0;
    await releaseFixtureResources();
    if (getAvatarSpeechState().generation === generation) {
      finishAvatarSpeech(generation);
    }
    return false;
  }
}
