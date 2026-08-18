// Stable module-level store for the Fix #5 gender styling context.
//
// Mirrors stores/stylistIdentityStore.ts's actor-race discipline: a hydrate
// or save response that lands after the actor switched, or after a newer
// hydrate/save superseded it, is discarded rather than applied.

import {
  isValidGenderStylingContext,
  type GenderStylingContext,
} from '../constants/genderStylingContext';
import {
  fetchGenderStylingContext,
  saveGenderStylingContext,
} from '../services/genderStylingContextService';

type StoreState = {
  /** null = not yet hydrated OR hydrated-and-unanswered. See `hasHydrated`. */
  value: GenderStylingContext | null;
  hasHydrated: boolean;
  isLoading: boolean;
  error: string | null;
};

type Listener = () => void;

export const DEFAULT_GENDER_STYLING_CONTEXT_STATE: StoreState = Object.freeze({
  value: null,
  hasHydrated: false,
  isLoading: false,
  error: null,
});

let state: StoreState = DEFAULT_GENDER_STYLING_CONTEXT_STATE;
const listeners = new Set<Listener>();
let hydratePromise: Promise<void> | null = null;
let lastHydratedUserId: string | null = null;
let activeUserId: string | null = null;
let hydrateRequestVersion = 0;
let saveRequestVersion = 0;

export function getGenderStylingContextState(): StoreState {
  return state;
}

export function getGenderStylingContextSnapshot(): GenderStylingContext | null {
  return state.value;
}

export function getGenderStylingContextHasHydratedSnapshot(): boolean {
  return state.hasHydrated;
}

export function getGenderStylingContextLoadingSnapshot(): boolean {
  return state.isLoading;
}

export function getGenderStylingContextErrorSnapshot(): string | null {
  return state.error;
}

export function subscribeToGenderStylingContext(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Store listeners must never corrupt the store.
    }
  }
}

function setState(next: Partial<StoreState>) {
  const nextValue = 'value' in next ? next.value! : state.value;
  const nextHasHydrated = next.hasHydrated ?? state.hasHydrated;
  const nextIsLoading = next.isLoading ?? state.isLoading;
  const nextError = next.error ?? state.error;

  if (
    nextValue === state.value &&
    nextHasHydrated === state.hasHydrated &&
    nextIsLoading === state.isLoading &&
    nextError === state.error
  ) {
    return;
  }

  state = Object.freeze({
    value: nextValue,
    hasHydrated: nextHasHydrated,
    isLoading: nextIsLoading,
    error: nextError,
  });
  emit();
}

export function resetGenderStylingContextStore() {
  state = DEFAULT_GENDER_STYLING_CONTEXT_STATE;
  hydratePromise = null;
  lastHydratedUserId = null;
  activeUserId = null;
  hydrateRequestVersion += 1;
  saveRequestVersion += 1;
  emit();
}

export async function hydrateGenderStylingContextForUser(userId: string): Promise<void> {
  if (lastHydratedUserId === userId && hydratePromise) {
    return hydratePromise;
  }

  const actorChanged = activeUserId !== userId;
  activeUserId = userId;
  lastHydratedUserId = userId;
  const requestVersion = hydrateRequestVersion + 1;
  hydrateRequestVersion = requestVersion;
  setState({
    value: actorChanged ? null : state.value,
    hasHydrated: actorChanged ? false : state.hasHydrated,
    isLoading: true,
    error: null,
  });

  hydratePromise = (async () => {
    try {
      const value = await fetchGenderStylingContext(userId);
      if (activeUserId !== userId || hydrateRequestVersion !== requestVersion) return;
      setState({ value, hasHydrated: true, isLoading: false, error: null });
    } catch (err: unknown) {
      if (activeUserId !== userId || hydrateRequestVersion !== requestVersion) return;
      const message = err instanceof Error ? err.message : 'Could not load your styling preference.';
      // A failed load must not be mistaken for "answered null" — hasHydrated
      // stays false so the card does not flash and the caller can retry.
      setState({ isLoading: false, error: message });
    }
  })();

  return hydratePromise;
}

export async function saveGenderStylingContextValue(
  value: GenderStylingContext,
): Promise<boolean> {
  if (!isValidGenderStylingContext(value)) {
    setState({ error: 'Choose one of the offered styling context options.' });
    return false;
  }

  const actorUserId = activeUserId;
  const requestVersion = saveRequestVersion + 1;
  saveRequestVersion = requestVersion;
  hydrateRequestVersion += 1;
  hydratePromise = null;

  const previous = state;
  setState({ isLoading: true, error: null });

  try {
    const saved = await saveGenderStylingContext(value, actorUserId ?? undefined);
    if (activeUserId !== actorUserId || saveRequestVersion !== requestVersion) return false;
    setState({ value: saved, hasHydrated: true, isLoading: false, error: null });
    return true;
  } catch (err: unknown) {
    if (activeUserId !== actorUserId || saveRequestVersion !== requestVersion) return false;
    const message = err instanceof Error ? err.message : 'Could not save your styling preference.';
    // Recoverable: restore exactly the prior state (including hasHydrated) so
    // the card remains visible and the user can retry instead of being stuck.
    setState({
      value: previous.value,
      hasHydrated: previous.hasHydrated,
      isLoading: false,
      error: message,
    });
    return false;
  }
}
