// Stable module-level store for the customer-facing stylist identity.
//
// Exported separately from the hook so the reference-stability contract can be
// unit-tested without mounting React components.

import {
  DEFAULT_STYLIST_IDENTITY,
  normalizeStylistIdentity,
  resolveAvatarId,
  sanitizeStylistName,
  type StylistIdentity,
} from '../constants/stylistIdentity';
import {
  fetchStylistIdentity,
  saveStylistIdentity,
} from '../services/stylistIdentityService';

type StoreState = {
  identity: StylistIdentity;
  isLoading: boolean;
  error: string | null;
};

type Listener = () => void;

export const DEFAULT_STYLIST_STORE_STATE: StoreState = Object.freeze({
  identity: DEFAULT_STYLIST_IDENTITY,
  isLoading: false,
  error: null,
});

let state: StoreState = DEFAULT_STYLIST_STORE_STATE;
const listeners = new Set<Listener>();
let hydratePromise: Promise<void> | null = null;
let lastHydratedUserId: string | null = null;
let activeUserId: string | null = null;
let hydrateRequestVersion = 0;
let saveRequestVersion = 0;

export function getStylistIdentityState(): StoreState {
  return state;
}

export function getStylistIdentitySnapshot(): StylistIdentity {
  return state.identity;
}

export function getStylistIdentityLoadingSnapshot(): boolean {
  return state.isLoading;
}

export function getStylistIdentityErrorSnapshot(): string | null {
  return state.error;
}

export function subscribeToStylistIdentity(listener: Listener): () => void {
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

export function setStylistIdentityState(next: Partial<StoreState>) {
  const nextIdentity = next.identity ?? state.identity;
  const nextIsLoading = next.isLoading ?? state.isLoading;
  const nextError = next.error ?? state.error;

  const identityChanged = nextIdentity !== state.identity;
  const isLoadingChanged = nextIsLoading !== state.isLoading;
  const errorChanged = nextError !== state.error;

  if (!identityChanged && !isLoadingChanged && !errorChanged) return;

  state = Object.freeze({
    identity: nextIdentity,
    isLoading: nextIsLoading,
    error: nextError,
  });
  emit();
}

export function resetStylistIdentityStore() {
  state = DEFAULT_STYLIST_STORE_STATE;
  hydratePromise = null;
  lastHydratedUserId = null;
  activeUserId = null;
  hydrateRequestVersion += 1;
  saveRequestVersion += 1;
  emit();
}

export async function hydrateStylistIdentityForUser(userId: string): Promise<void> {
  if (lastHydratedUserId === userId && hydratePromise) {
    return hydratePromise;
  }

  activeUserId = userId;
  lastHydratedUserId = userId;
  const requestVersion = hydrateRequestVersion + 1;
  hydrateRequestVersion = requestVersion;
  setStylistIdentityState({ isLoading: true, error: null });

  hydratePromise = (async () => {
    try {
      const identity = await fetchStylistIdentity(userId);
      if (activeUserId !== userId || hydrateRequestVersion !== requestVersion) return;
      setStylistIdentityState({ identity, isLoading: false, error: null });
    } catch (err: unknown) {
      if (activeUserId !== userId || hydrateRequestVersion !== requestVersion) return;
      const message = err instanceof Error ? err.message : 'Could not load stylist identity.';
      setStylistIdentityState({ isLoading: false, error: message });
    }
  })();

  return hydratePromise;
}

export async function updateStylistIdentity(input: Partial<StylistIdentity>): Promise<void> {
  const displayName =
    input.displayName !== undefined
      ? sanitizeStylistName(input.displayName).value
      : state.identity.displayName;
  const avatarId =
    input.avatarId !== undefined
      ? resolveAvatarId(input.avatarId)
      : state.identity.avatarId;

  const nextIdentity =
    displayName === state.identity.displayName && avatarId === state.identity.avatarId
      ? state.identity
      : Object.freeze({ displayName, avatarId });

  if (nextIdentity === state.identity) return;

  const actorUserId = activeUserId;
  const requestVersion = saveRequestVersion + 1;
  saveRequestVersion = requestVersion;
  hydrateRequestVersion += 1;
  hydratePromise = null;

  const previousIdentity = state.identity;
  setStylistIdentityState({ isLoading: false, error: null });

  try {
    const saved = await saveStylistIdentity(nextIdentity, actorUserId ?? undefined);
    if (activeUserId !== actorUserId || saveRequestVersion !== requestVersion) return;
    const normalized = normalizeStylistIdentity(saved);
    let identityToSet: StylistIdentity = normalized;
    if (
      normalized.displayName === nextIdentity.displayName &&
      normalized.avatarId === nextIdentity.avatarId
    ) {
      identityToSet = nextIdentity;
    } else if (
      normalized.displayName === previousIdentity.displayName &&
      normalized.avatarId === previousIdentity.avatarId
    ) {
      identityToSet = previousIdentity;
    }
    setStylistIdentityState({ identity: identityToSet, error: null });
  } catch (err: unknown) {
    if (activeUserId !== actorUserId || saveRequestVersion !== requestVersion) return;
    setStylistIdentityState({ identity: previousIdentity, error: null });
    const message = err instanceof Error ? err.message : 'Could not save stylist identity.';
    setStylistIdentityState({ error: message });
  }
}

export async function resetStylistIdentity(): Promise<void> {
  if (state.identity === DEFAULT_STYLIST_IDENTITY) return;

  const actorUserId = activeUserId;
  const requestVersion = saveRequestVersion + 1;
  saveRequestVersion = requestVersion;
  hydrateRequestVersion += 1;
  hydratePromise = null;

  const previousIdentity = state.identity;
  setStylistIdentityState({ isLoading: false, error: null });

  try {
    await saveStylistIdentity(DEFAULT_STYLIST_IDENTITY, actorUserId ?? undefined);
    if (activeUserId !== actorUserId || saveRequestVersion !== requestVersion) return;
    setStylistIdentityState({ identity: DEFAULT_STYLIST_IDENTITY, error: null });
  } catch (err: unknown) {
    if (activeUserId !== actorUserId || saveRequestVersion !== requestVersion) return;
    setStylistIdentityState({ identity: previousIdentity, error: null });
    const message = err instanceof Error ? err.message : 'Could not reset stylist identity.';
    setStylistIdentityState({ error: message });
  }
}
