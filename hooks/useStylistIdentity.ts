// Stable, reusable source of truth for the customer-facing stylist identity.
//
// Requirements:
//   - identity object reference is stable while data is unchanged
//   - default identity is a module-level constant
//   - invalid storage falls back to the default without creating new objects
//   - loading does not trigger a save
//   - account switching reloads identity exactly once
//   - action functions are stable for dependency arrays

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  DEFAULT_STYLIST_IDENTITY,
  type StylistIdentity,
} from '../constants/stylistIdentity';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  getStylistIdentityErrorSnapshot,
  getStylistIdentityLoadingSnapshot,
  getStylistIdentitySnapshot,
  hydrateStylistIdentityForUser,
  resetStylistIdentity,
  resetStylistIdentityStore,
  subscribeToStylistIdentity,
  updateStylistIdentity,
} from '../stores/stylistIdentityStore';

/**
 * Read the current stylist identity without subscribing. Useful for
 * synchronous consumers (e.g., navigation helpers) that cannot use hooks.
 */
export function getCurrentStylistIdentity(): StylistIdentity {
  return getStylistIdentitySnapshot();
}

/**
 * Reset the in-memory identity store. Called on sign-out so the next account
 * does not see the previous user's stylist identity.
 */
export function clearStylistIdentityStore(): void {
  resetStylistIdentityStore();
}

/**
 * Stable identity hook. The returned `identity` object preserves its reference
 * across renders whenever displayName and avatarId are unchanged. Action
 * functions (`updateIdentity`, `resetIdentity`) are also stable.
 */
export function useStylistIdentity() {
  const { isAuthenticated, user } = useAuthSession();
  const userId = user?.id ?? null;
  const previousUserIdRef = useRef<string | null>(null);

  const identity = useSyncExternalStore(
    subscribeToStylistIdentity,
    getStylistIdentitySnapshot,
    getStylistIdentitySnapshot,
  );
  const isLoading = useSyncExternalStore(
    subscribeToStylistIdentity,
    getStylistIdentityLoadingSnapshot,
    getStylistIdentityLoadingSnapshot,
  );
  const error = useSyncExternalStore(
    subscribeToStylistIdentity,
    getStylistIdentityErrorSnapshot,
    getStylistIdentityErrorSnapshot,
  );

  // Hydrate once per authenticated actor. Unauthenticated users keep the
  // module-level default identity without loading.
  useEffect(() => {
    if (!isAuthenticated || !userId) {
      if (previousUserIdRef.current !== null) {
        resetStylistIdentityStore();
      }
      previousUserIdRef.current = null;
      return;
    }

    if (previousUserIdRef.current === userId) return;
    previousUserIdRef.current = userId;

    void hydrateStylistIdentityForUser(userId);
  }, [isAuthenticated, userId]);

  const update = useCallback(async (input: Partial<StylistIdentity>) => {
    await updateStylistIdentity(input);
  }, []);

  const reset = useCallback(async () => {
    await resetStylistIdentity();
  }, []);

  return useMemo(
    () => ({
      identity,
      isLoading,
      error,
      updateIdentity: update,
      resetIdentity: reset,
    }),
    [identity, isLoading, error, update, reset],
  );
}
