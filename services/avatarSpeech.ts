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
  ensureAvatarSpeechLifecycleListener,
  registerAvatarInterruptionHandler,
} from './avatarSpeechLifecycle';

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

/**
 * One deterministic cue at a confirmed state transition.
 *
 * `occurrenceId` must identify the TRANSITION, not the render: a committed
 * Closet item id, an accepted handoff id, a hydrated Look id. That is what lets
 * the same cue speak again for a genuinely different item while a rerender,
 * refocus, or foreground return replays nothing.
 */
export interface SpeakAvatarCuePayload {
  actorId: string;
  cue: string;
  occurrenceId: string;
  stylistId: string;
  avatarId: string;
  /** Present when the cue is raised inside a chat session; absent elsewhere. */
  sessionId?: string | null;
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
let currentScope: NormalizedSpeech | null = null;
// The operation currently being generated or played. Exactly one speech
// operation is active at a time, so a single key is enough to suppress a
// duplicate concurrent attempt without also making a failure permanent.
let inFlightKey: string | null = null;
// Operations that reached confirmed native playback. Only a successful start
// retires a message from automatic speech.
const spokenKeys = new Set<string>();
const spokenOrder: string[] = [];

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

function matchesScope(payload: NormalizedSpeech, scope?: AvatarSpeechScope): boolean {
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

/**
 * User-safe failure copy, chosen by classification.
 *
 * Both strings are deliberately non-technical: the user is told Elise's voice is
 * unavailable, never why the backend disagreed with the client. The DISTINCTION
 * exists so the state carries whether a retry could ever help — an older
 * deployment will not start understanding a newer request, so offering an
 * endless retry there would be a lie.
 */
function describeSpeechFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'unsupported_contract'
    ? 'Elise’s voice is unavailable right now.'
    : 'Speech is temporarily unavailable.';
}

async function failCurrent(
  value: number,
  message = 'Speech is temporarily unavailable.',
): Promise<void> {
  if (!isCurrent(value)) return;
  await releaseResources();
  if (!isCurrent(value)) return;
  currentScope = null;
  setAvatarSpeechError(value, message);
}

/**
 * The single shape the speech runner works in. Message mode and cue mode differ
 * only in where the words come from and what identifies the operation; the
 * generation guard, in-flight suppression, success dedupe, temp-file handling and
 * playback lifecycle are deliberately shared so the two modes cannot drift into
 * two different sets of bugs.
 */
interface NormalizedSpeech {
  key: string;
  actorId: string;
  sessionId: string | null;
  messageId: string | null;
  cue: string | null;
  stylistId: string;
  avatarId: string;
  source: AvatarSpeechSource;
  trigger: AvatarSpeechTrigger;
}

// Avatar AppState interruption, bound lazily on the first speech request.
//
// Ownership sits in the service layer, never in a UI component, so a mounted
// avatar cannot install a second AppState listener and a background event
// cannot be missed while no avatar happens to be mounted. The handler delegates
// to stopAvatarSpeechPlayback() rather than reimplementing teardown, so the
// authoritative generation bump, player stop, temp-file cleanup and store reset
// stay in exactly one place: a late native callback from the interrupted
// generation is inert, and returning to the foreground never resumes.
let speechLifecycleBound = false;

function ensureSpeechLifecycleBound(): void {
  if (!speechLifecycleBound) {
    speechLifecycleBound = true;
    registerAvatarInterruptionHandler(() => {
      void stopAvatarSpeechPlayback();
    });
  }
  ensureAvatarSpeechLifecycleListener();
}

async function runSpeechOperation(payload: NormalizedSpeech): Promise<void> {
  const key = payload.key;
  ensureSpeechLifecycleBound();
  // A duplicate concurrent attempt is suppressed for both triggers so a retry
  // tap cannot start a second player alongside an in-flight attempt.
  if (inFlightKey === key) return;
  // Only automatic speech is retired by a previous success; an explicit retry
  // is the user asking for this again.
  if (payload.trigger === 'auto' && spokenKeys.has(key)) return;

  const requestGeneration = nextGeneration();
  await releaseResources();
  if (!isCurrent(requestGeneration)) return;

  inFlightKey = key;
  currentScope = payload;
  beginAvatarSpeech({
    actorId: payload.actorId,
    sessionId: payload.sessionId,
    messageId: payload.messageId,
    cue: payload.cue,
    stylistId: payload.stylistId,
    avatarId: payload.avatarId,
    source: payload.source,
    generation: requestGeneration,
  });
  const controller = new AbortController();
  pendingController = controller;

  try {
    const speech = await requestStylistSpeech(
      payload.cue
        ? {
          mode: 'cue',
          actorId: payload.actorId,
          cue: payload.cue,
          stylistId: payload.stylistId,
          signal: controller.signal,
        }
        : {
          actorId: payload.actorId,
          sessionId: payload.sessionId ?? '',
          messageId: payload.messageId ?? '',
          stylistId: payload.stylistId,
          signal: controller.signal,
        },
    );
    if (!isCurrent(requestGeneration)) return;
    pendingController = null;

    const uri = await createTemporaryStylistSpeechFile({
      actorId: payload.actorId,
      sessionId: payload.sessionId ?? 'cue',
      messageId: payload.messageId ?? `cue-${payload.cue}`,
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
        // this operation from automatic speech.
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
  } catch (error) {
    // KSB29-022. This was a bare `catch {}`, so a COMPLETE cue-service outage
    // -- every cue rejected because the deployed backend predates cue mode --
    // looked exactly like one flaky network call and left no trace of which had
    // happened. Speech is an enhancement and must still never block a product
    // action, so the failure is still swallowed; it is now swallowed
    // OBSERVABLY.
    if (isCurrent(requestGeneration)) {
      await failCurrent(requestGeneration, describeSpeechFailure(error));
    }
  }
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

  await runSpeechOperation({
    key: operationKey(payload),
    actorId: payload.actorId,
    sessionId: payload.sessionId,
    messageId: payload.messageId,
    cue: null,
    stylistId: payload.stylistId,
    avatarId: payload.avatarId,
    source: payload.source,
    trigger: payload.trigger ?? 'auto',
  });
}

/**
 * Speaks one allowlisted deterministic cue for a confirmed state transition.
 *
 * The client names a cue key; the Edge Function owns the words. Speech is an
 * enhancement here — callers fire this without awaiting and never gate a product
 * action on it, so a provider failure can never roll back a save or a handoff.
 */
export async function speakAvatarCue(payload: SpeakAvatarCuePayload): Promise<void> {
  if (
    !payload.actorId ||
    !payload.cue ||
    !payload.occurrenceId ||
    !payload.stylistId ||
    !payload.avatarId ||
    payload.stylistId !== payload.avatarId
  ) return;

  await runSpeechOperation({
    key: [payload.actorId, 'cue', payload.cue, payload.occurrenceId, payload.stylistId].join(':'),
    actorId: payload.actorId,
    sessionId: payload.sessionId ?? null,
    messageId: null,
    cue: payload.cue,
    stylistId: payload.stylistId,
    avatarId: payload.avatarId,
    source: 'cue',
    trigger: payload.trigger ?? 'auto',
  });
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
