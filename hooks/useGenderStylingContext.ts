// Fix #5 — first-use Elise gender styling context.
//
// Mirrors hooks/useStylistIdentity.ts: hydrate once per authenticated actor,
// stable action functions, reset on sign-out so the next account never sees
// a stale answer or a stale "already answered" state.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { GenderStylingContext } from '../constants/genderStylingContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  getGenderStylingContextErrorSnapshot,
  getGenderStylingContextHasHydratedSnapshot,
  getGenderStylingContextLoadingSnapshot,
  getGenderStylingContextSnapshot,
  hydrateGenderStylingContextForUser,
  resetGenderStylingContextStore,
  saveGenderStylingContextValue,
  subscribeToGenderStylingContext,
} from '../stores/genderStylingContextStore';

/** Reset on sign-out so the next account does not inherit this state. */
export function clearGenderStylingContextStore(): void {
  resetGenderStylingContextStore();
}

export function useGenderStylingContext() {
  const { isAuthenticated, user } = useAuthSession();
  const userId = user?.id ?? null;
  const previousUserIdRef = useRef<string | null>(null);

  const value = useSyncExternalStore(
    subscribeToGenderStylingContext,
    getGenderStylingContextSnapshot,
    getGenderStylingContextSnapshot,
  );
  const hasHydrated = useSyncExternalStore(
    subscribeToGenderStylingContext,
    getGenderStylingContextHasHydratedSnapshot,
    getGenderStylingContextHasHydratedSnapshot,
  );
  const isLoading = useSyncExternalStore(
    subscribeToGenderStylingContext,
    getGenderStylingContextLoadingSnapshot,
    getGenderStylingContextLoadingSnapshot,
  );
  const error = useSyncExternalStore(
    subscribeToGenderStylingContext,
    getGenderStylingContextErrorSnapshot,
    getGenderStylingContextErrorSnapshot,
  );

  useEffect(() => {
    if (!isAuthenticated || !userId) {
      if (previousUserIdRef.current !== null) {
        resetGenderStylingContextStore();
      }
      previousUserIdRef.current = null;
      return;
    }

    if (previousUserIdRef.current === userId) return;
    previousUserIdRef.current = userId;

    void hydrateGenderStylingContextForUser(userId);
  }, [isAuthenticated, userId]);

  const save = useCallback(async (next: GenderStylingContext) => {
    return saveGenderStylingContextValue(next);
  }, []);

  // Authoritative-state contract for the first-use card: only render it once
  // hydration has actually completed for the current actor, and only when it
  // resolved to "no stored answer." Before that, callers must show neither
  // the card nor the chat content, to avoid a load flash.
  const needsFirstUseAnswer = isAuthenticated && hasHydrated && value === null;

  return useMemo(
    () => ({
      value,
      hasHydrated,
      isLoading,
      error,
      needsFirstUseAnswer,
      save,
    }),
    [value, hasHydrated, isLoading, error, needsFirstUseAnswer, save],
  );
}
