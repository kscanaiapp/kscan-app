import { useSyncExternalStore } from 'react';

export type AvatarSpeechStatus =
  | 'idle'
  | 'starting'
  | 'speaking'
  | 'stopping'
  | 'error';

export type AvatarSpeechSource = 'greeting' | 'message';

export interface AvatarSpeechState {
  status: AvatarSpeechStatus;
  actorKey: string | null;
  sessionId: string | null;
  avatarId: string | null;
  utteranceKey: string | null;
  generation: number | null;
  source: AvatarSpeechSource | null;
  error: string | null;
}

type Listener = () => void;

export const DEFAULT_AVATAR_SPEECH_STATE: AvatarSpeechState = Object.freeze({
  status: 'idle',
  actorKey: null,
  sessionId: null,
  avatarId: null,
  utteranceKey: null,
  generation: null,
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
      // Store listeners must never corrupt the store.
    }
  }
}

function setState(next: Partial<AvatarSpeechState>) {
  const nextState: AvatarSpeechState = {
    status: 'status' in next ? next.status! : state.status,
    actorKey: 'actorKey' in next ? next.actorKey! : state.actorKey,
    sessionId: 'sessionId' in next ? next.sessionId! : state.sessionId,
    avatarId: 'avatarId' in next ? next.avatarId! : state.avatarId,
    utteranceKey: 'utteranceKey' in next ? next.utteranceKey! : state.utteranceKey,
    generation: 'generation' in next ? next.generation! : state.generation,
    source: 'source' in next ? next.source! : state.source,
    error: 'error' in next ? next.error! : state.error,
  };

  if (
    nextState.status === state.status &&
    nextState.actorKey === state.actorKey &&
    nextState.sessionId === state.sessionId &&
    nextState.avatarId === state.avatarId &&
    nextState.utteranceKey === state.utteranceKey &&
    nextState.generation === state.generation &&
    nextState.source === state.source &&
    nextState.error === state.error
  ) {
    return;
  }

  state = Object.freeze(nextState);
  emit();
}

export function getAvatarSpeechState(): AvatarSpeechState {
  return state;
}

export function getAvatarSpeechStatusSnapshot(): AvatarSpeechState {
  return state;
}

export function subscribeToAvatarSpeech(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetAvatarSpeechStore(): void {
  state = DEFAULT_AVATAR_SPEECH_STATE;
  emit();
}

export function startAvatarSpeech(payload: {
  actorKey: string;
  sessionId: string;
  avatarId: string;
  utteranceKey: string;
  generation: number;
  source: AvatarSpeechSource;
}): void {
  setState({
    status: 'starting',
    actorKey: payload.actorKey,
    sessionId: payload.sessionId,
    avatarId: payload.avatarId,
    utteranceKey: payload.utteranceKey,
    generation: payload.generation,
    source: payload.source,
    error: null,
  });
}

export function markAvatarSpeechStopping(): void {
  setState({ status: 'stopping', error: null });
}

export function markAvatarSpeechSpeaking(): void {
  setState({ status: 'speaking', error: null });
}

export function stopAvatarSpeech(): void {
  setState({
    status: 'idle',
    actorKey: null,
    sessionId: null,
    avatarId: null,
    utteranceKey: null,
    generation: null,
    source: null,
    error: null,
  });
}

export function setAvatarSpeechError(error: string): void {
  setState({ status: 'error', error });
}

export function resetAvatarSpeechForActor(actorKey: string): void {
  if (state.actorKey === actorKey) {
    stopAvatarSpeech();
  }
}

export function resetAvatarSpeechForAvatar(avatarId: string): void {
  if (state.avatarId === avatarId) {
    stopAvatarSpeech();
  }
}

export function resetAvatarSpeechForSession(sessionId: string): void {
  if (state.sessionId === sessionId) {
    stopAvatarSpeech();
  }
}

/**
 * React hook exposing the global avatar speech state.
 */
export function useAvatarSpeechState(): AvatarSpeechState {
  return useSyncExternalStore(
    subscribeToAvatarSpeech,
    getAvatarSpeechStatusSnapshot,
    getAvatarSpeechStatusSnapshot,
  );
}
