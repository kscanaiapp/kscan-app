import { useCallback, useEffect, useSyncExternalStore } from 'react';
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
