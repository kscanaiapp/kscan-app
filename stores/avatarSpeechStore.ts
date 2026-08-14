import { useSyncExternalStore } from 'react';

export type AvatarSpeechPhase =
  | 'idle'
  | 'requesting'
  | 'ready'
  | 'playing'
  | 'stopping'
  | 'error';

export type AvatarSpeechSource = 'greeting' | 'message' | 'cue';

export interface AvatarSpeechAlignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export interface AvatarSpeechState {
  actorId: string | null;
  sessionId: string | null;
  messageId: string | null;
  /** Set for a deterministic cue; null when speaking a persisted message. */
  cue: string | null;
  stylistId: string | null;
  avatarId: string | null;
  generation: number;
  phase: AvatarSpeechPhase;
  playbackSeconds: number;
  alignment: AvatarSpeechAlignment | null;
  source: AvatarSpeechSource | null;
  error: string | null;
}

type Listener = () => void;

export const DEFAULT_AVATAR_SPEECH_STATE: AvatarSpeechState = Object.freeze({
  actorId: null,
  sessionId: null,
  cue: null,
  messageId: null,
  stylistId: null,
  avatarId: null,
  generation: 0,
  phase: 'idle',
  playbackSeconds: 0,
  alignment: null,
  source: null,
  error: null,
});

let state: AvatarSpeechState = DEFAULT_AVATAR_SPEECH_STATE;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A subscriber cannot be allowed to corrupt the shared lifecycle state.
    }
  }
}

function replaceState(next: AvatarSpeechState) {
  if (
    next.actorId === state.actorId &&
    next.sessionId === state.sessionId &&
    next.messageId === state.messageId &&
    next.stylistId === state.stylistId &&
    next.avatarId === state.avatarId &&
    next.generation === state.generation &&
    next.phase === state.phase &&
    next.playbackSeconds === state.playbackSeconds &&
    next.alignment === state.alignment &&
    next.source === state.source &&
    next.error === state.error
  ) return;

  state = Object.freeze(next);
  emit();
}

/**
 * Speech generation authority accepts only finite, non-negative integers.
 *
 * Validation must happen BEFORE any comparison or adoption. A NaN generation
 * never equals itself, so an unguarded NaN could never be advanced or finished
 * again and would strand the avatar in a non-idle phase; adopting Infinity
 * would permanently invalidate every later real generation. Rejecting leaves
 * the current generation authority untouched, so a subsequent valid
 * generation still succeeds normally.
 *
 * Matches isValidMotionGeneration in services/avatarMotionController.ts — the
 * two authorities must agree on what a generation is.
 */
export function isValidSpeechGeneration(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function updateCurrentGeneration(
  generation: number,
  update: Partial<AvatarSpeechState>,
): boolean {
  if (!isValidSpeechGeneration(generation)) return false;
  if (state.generation !== generation || state.phase === 'idle') return false;
  replaceState({ ...state, ...update });
  return true;
}

export function getAvatarSpeechState(): AvatarSpeechState {
  return state;
}

export function subscribeToAvatarSpeech(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetAvatarSpeechStore(generation = state.generation): void {
  const safeGeneration = isValidSpeechGeneration(generation)
    ? generation
    : DEFAULT_AVATAR_SPEECH_STATE.generation;
  replaceState({ ...DEFAULT_AVATAR_SPEECH_STATE, generation: safeGeneration });
}

export function beginAvatarSpeech(payload: {
  actorId: string;
  /** Null for a cue raised outside a chat session, such as the Dressing Room. */
  sessionId: string | null;
  /** Null in cue mode: a cue has no persisted message behind it. */
  messageId: string | null;
  cue?: string | null;
  stylistId: string;
  avatarId: string;
  generation: number;
  source: AvatarSpeechSource;
}): void {
  // Reject before adoption: opening 'requesting' under a malformed generation
  // would strand the phase, since nothing could ever match it to close it.
  if (!isValidSpeechGeneration(payload.generation)) return;
  replaceState({
    actorId: payload.actorId,
    sessionId: payload.sessionId,
    messageId: payload.messageId,
    cue: payload.cue ?? null,
    stylistId: payload.stylistId,
    avatarId: payload.avatarId,
    generation: payload.generation,
    phase: 'requesting',
    playbackSeconds: 0,
    alignment: null,
    source: payload.source,
    error: null,
  });
}

export function markAvatarSpeechReady(
  generation: number,
  alignment: AvatarSpeechAlignment | null,
): boolean {
  return updateCurrentGeneration(generation, {
    phase: 'ready',
    playbackSeconds: 0,
    alignment,
    error: null,
  });
}

export function markAvatarSpeechPlaying(generation: number): boolean {
  return updateCurrentGeneration(generation, { phase: 'playing', error: null });
}

export function updateAvatarSpeechPlayback(
  generation: number,
  playbackSeconds: number,
): boolean {
  if (!isValidSpeechGeneration(generation)) return false;
  if (!Number.isFinite(playbackSeconds) || playbackSeconds < 0) return false;
  if (state.generation !== generation || state.phase !== 'playing') return false;
  const bounded = Math.round(playbackSeconds * 1000) / 1000;
  if (bounded === state.playbackSeconds) return false;
  replaceState({ ...state, playbackSeconds: bounded });
  return true;
}

export function markAvatarSpeechStopping(generation: number): boolean {
  return updateCurrentGeneration(generation, { phase: 'stopping', error: null });
}

export function setAvatarSpeechError(generation: number, error: string): boolean {
  return updateCurrentGeneration(generation, {
    phase: 'error',
    playbackSeconds: 0,
    alignment: null,
    error,
  });
}

export function finishAvatarSpeech(generation: number): boolean {
  if (!isValidSpeechGeneration(generation)) return false;
  if (state.generation !== generation) return false;
  resetAvatarSpeechStore(generation);
  return true;
}

export function isAvatarSpeechScopeActive(scope: {
  actorId: string;
  sessionId: string;
  avatarId: string;
}): boolean {
  return state.phase !== 'idle' &&
    state.actorId === scope.actorId &&
    state.sessionId === scope.sessionId &&
    state.avatarId === scope.avatarId;
}

export function useAvatarSpeechState(): AvatarSpeechState {
  return useSyncExternalStore(
    subscribeToAvatarSpeech,
    getAvatarSpeechState,
    getAvatarSpeechState,
  );
}

/**
 * Subscribes to one derived value instead of the whole state. Playback progress
 * replaces the state object several times a second, so a consumer that only
 * needs the phase — such as per-message recovery UI rendered once per assistant
 * reply — must not re-render on every tick.
 *
 * The selector must return a primitive or an otherwise reference-stable value,
 * because `useSyncExternalStore` compares snapshots with `Object.is`.
 */
export function useAvatarSpeechSelection<T>(select: (state: AvatarSpeechState) => T): T {
  const snapshot = () => select(getAvatarSpeechState());
  return useSyncExternalStore(subscribeToAvatarSpeech, snapshot, snapshot);
}
