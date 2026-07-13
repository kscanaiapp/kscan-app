import { useSyncExternalStore } from 'react';
import type { AvatarSpeechSource, AvatarSpeechState, AvatarSpeechStatus } from './types';

const DEFAULT_SNAPSHOT: AvatarSpeechState = {
  status: 'idle',
  actorKey: null,
  avatarId: null,
  utteranceKey: null,
  source: null,
  error: null,
};

let currentState: AvatarSpeechState = DEFAULT_SNAPSHOT;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

function updateState(partial: Partial<AvatarSpeechState>) {
  const next: AvatarSpeechState = { ...currentState, ...partial };
  // Preserve reference stability when nothing changes.
  if (
    next.status === currentState.status &&
    next.actorKey === currentState.actorKey &&
    next.avatarId === currentState.avatarId &&
    next.utteranceKey === currentState.utteranceKey &&
    next.source === currentState.source &&
    next.error === currentState.error
  ) {
    return;
  }
  currentState = next;
  emit();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): AvatarSpeechState {
  return currentState;
}

function getServerSnapshot(): AvatarSpeechState {
  return DEFAULT_SNAPSHOT;
}

/**
 * React hook exposing the global avatar speech state.
 *
 * Uses primitive dependencies so consumers re-render only on real changes.
 */
export function useAvatarSpeechState(): AvatarSpeechState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Begin a new utterance request.
 */
export function startUtterance(payload: {
  actorKey: string;
  avatarId: string;
  utteranceKey: string;
  source: AvatarSpeechSource;
}): void {
  updateState({
    status: 'starting',
    actorKey: payload.actorKey,
    avatarId: payload.avatarId,
    utteranceKey: payload.utteranceKey,
    source: payload.source,
    error: null,
  });
}

/**
 * Mark the current request as stopping.
 */
export function markStopping(): void {
  updateState({ status: 'stopping', error: null });
}

/**
 * Confirm the active request has started audio playback.
 */
export function markSpeaking(): void {
  updateState({ status: 'speaking', error: null });
}

/**
 * Mark the active request as stopped/idle.
 */
export function markStopped(): void {
  updateState({
    status: 'idle',
    actorKey: null,
    avatarId: null,
    utteranceKey: null,
    source: null,
    error: null,
  });
}

/**
 * Record an error for the active request and return to idle.
 */
export function markError(error: string): void {
  updateState({ status: 'error', error });
}

/**
 * Reset any utterance belonging to a specific actor (e.g., user signed out).
 */
export function resetActor(actorKey: string): void {
  if (currentState.actorKey === actorKey) {
    markStopped();
  }
}

/**
 * Reset any utterance using a specific avatar (e.g., avatar disabled).
 */
export function resetAvatar(avatarId: string): void {
  if (currentState.avatarId === avatarId) {
    markStopped();
  }
}

/**
 * Get the current status without subscribing.
 */
export function getAvatarSpeechStatus(): AvatarSpeechStatus {
  return currentState.status;
}

/**
 * Get the current actorKey without subscribing.
 */
export function getCurrentActorKey(): string | null {
  return currentState.actorKey;
}
