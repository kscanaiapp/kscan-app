import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useSyncExternalStore } from 'react';

const VOICE_PREFERENCE_KEY_PREFIX = '@kscan/stylist-voice/v1/';

export interface StylistVoicePreferenceState {
  actorId: string | null;
  enabled: boolean;
  loading: boolean;
}

type Listener = () => void;

const DEFAULT_STATE: StylistVoicePreferenceState = Object.freeze({
  actorId: null,
  enabled: false,
  loading: false,
});

let state = DEFAULT_STATE;
let hydrationGeneration = 0;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Preference listeners are isolated from persistence state.
    }
  }
}

function replaceState(next: StylistVoicePreferenceState) {
  if (
    next.actorId === state.actorId &&
    next.enabled === state.enabled &&
    next.loading === state.loading
  ) return;
  state = Object.freeze(next);
  emit();
}

async function storageKey(actorId: string): Promise<string> {
  const actorHash = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    actorId,
  );
  return `${VOICE_PREFERENCE_KEY_PREFIX}${actorHash}`;
}

export function getStylistVoicePreferenceState(): StylistVoicePreferenceState {
  return state;
}

export function subscribeToStylistVoicePreference(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function hydrateStylistVoicePreference(actorId: string | null): Promise<void> {
  const generation = hydrationGeneration + 1;
  hydrationGeneration = generation;

  if (!actorId) {
    replaceState(DEFAULT_STATE);
    return;
  }
  if (state.actorId === actorId && !state.loading) return;

  // Fail closed while switching actors so one actor never observes another's
  // enabled preference, even briefly.
  replaceState({ actorId, enabled: false, loading: true });
  try {
    const value = await AsyncStorage.getItem(await storageKey(actorId));
    if (hydrationGeneration !== generation || state.actorId !== actorId) return;
    // Default on: a device with no recorded choice enables speech. Only an
    // explicit 'off' write opts out — never inferred from absence.
    replaceState({ actorId, enabled: value !== 'off', loading: false });
  } catch {
    if (hydrationGeneration !== generation || state.actorId !== actorId) return;
    replaceState({ actorId, enabled: false, loading: false });
  }
}

export async function setStylistVoicePreference(
  actorId: string,
  enabled: boolean,
): Promise<void> {
  if (state.actorId !== actorId || state.loading) {
    await hydrateStylistVoicePreference(actorId);
  }
  if (state.actorId !== actorId) return;

  const previous = state.enabled;
  replaceState({ actorId, enabled, loading: false });
  try {
    await AsyncStorage.setItem(await storageKey(actorId), enabled ? 'on' : 'off');
  } catch (error) {
    if (state.actorId === actorId && state.enabled === enabled) {
      replaceState({ actorId, enabled: previous, loading: false });
    }
    throw error;
  }
}

export function resetStylistVoicePreferenceState(): void {
  hydrationGeneration += 1;
  replaceState(DEFAULT_STATE);
}

export function useStylistVoicePreferenceState(): StylistVoicePreferenceState {
  return useSyncExternalStore(
    subscribeToStylistVoicePreference,
    getStylistVoicePreferenceState,
    getStylistVoicePreferenceState,
  );
}
