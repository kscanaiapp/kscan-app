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
  avatarId: string | null;
  utteranceKey: string | null;
  source: AvatarSpeechSource | null;
  error: string | null;
}

type Listener = () => void;

export const DEFAULT_AVATAR_SPEECH_STATE: AvatarSpeechState = Object.freeze({
  status: 'idle',
  actorKey: null,
  avatarId: null,
  utteranceKey: null,
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
    status: next.status ?? state.status,
    actorKey: next.actorKey ?? state.actorKey,
    avatarId: next.avatarId ?? state.avatarId,
    utteranceKey: next.utteranceKey ?? state.utteranceKey,
    source: next.source ?? state.source,
    error: next.error ?? state.error,
  };

  if (
    nextState.status === state.status &&
    nextState.actorKey === state.actorKey &&
    nextState.avatarId === state.avatarId &&
    nextState.utteranceKey === state.utteranceKey &&
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
  avatarId: string;
  utteranceKey: string;
  source: AvatarSpeechSource;
}): void {
  setState({
    status: 'starting',
    actorKey: payload.actorKey,
    avatarId: payload.avatarId,
    utteranceKey: payload.utteranceKey,
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
    avatarId: null,
    utteranceKey: null,
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
