import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  activateKPlus,
  getKPlusEntitlementSnapshot,
  refreshKPlusEntitlement,
  subscribeToKPlusEntitlement,
  type ActivateOutcome,
} from '../services/kplus/kplusEntitlementStore';
import { KPLUS_EARLY_ACCESS_ENABLED } from '../constants/featureFlags';
import type { KPlusEntitlementSnapshot } from '../types/entitlements';

export interface UseKPlusEntitlementResult extends KPlusEntitlementSnapshot {
  isActive: boolean;
  refresh: () => void;
  activate: () => Promise<ActivateOutcome>;
}

/**
 * Loads K+ status only for an authenticated actor -- never resolves
 * entitlement for an anonymous session, and never carries a previous
 * actor's snapshot (resetKPlusEntitlementCache runs on every actor
 * boundary via contexts/AuthSessionContext.tsx). Fails closed: any
 * unresolved state ('loading' | 'error' | 'unavailable') must be treated
 * by callers as "no premium access", never as active.
 */
export function useKPlusEntitlement(): UseKPlusEntitlementResult {
  const { isAuthenticated, user } = useAuthSession();
  const snapshot = useSyncExternalStore(subscribeToKPlusEntitlement, getKPlusEntitlementSnapshot);

  useEffect(() => {
    if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated || !user?.id) return;
    void refreshKPlusEntitlement();
  }, [isAuthenticated, user?.id]);

  // INT-KPLUS-006 — re-read entitlement when the app comes back to the
  // foreground. The store already downgrades a lapsed grant at read time, so
  // the UI is never WRONG without this; but a session that was backgrounded
  // across the expiry boundary (or across a server-side revocation) should
  // reconcile with the server rather than sit on a locally-expired snapshot.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated || !user?.id) return;
    const subscription = AppState.addEventListener('change', (next) => {
      const cameForward = appStateRef.current.match(/inactive|background/) && next === 'active';
      appStateRef.current = next;
      if (cameForward) void refreshKPlusEntitlement();
    });
    return () => subscription.remove();
  }, [isAuthenticated, user?.id]);

  const refresh = useCallback(() => {
    if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated) return;
    void refreshKPlusEntitlement();
  }, [isAuthenticated]);

  const activate = useCallback(async (): Promise<ActivateOutcome> => {
    if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated) return 'failed';
    return activateKPlus();
  }, [isAuthenticated]);

  if (!KPLUS_EARLY_ACCESS_ENABLED || !isAuthenticated) {
    return {
      state: 'unavailable',
      expiresAt: null,
      campaignKey: null,
      externalSyncStatus: null,
      isActive: false,
      refresh,
      activate,
    };
  }

  return {
    ...snapshot,
    isActive: snapshot.state === 'active',
    refresh,
    activate,
  };
}
