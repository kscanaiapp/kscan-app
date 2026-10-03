import { useSyncExternalStore } from 'react';
import {
  getKPlusCommerceSnapshot,
  subscribeToKPlusCommerce,
} from '../services/kplus/kplusCommerceService';
import type { KPlusCommerceSnapshot } from '../types/kplusCommerceContract';

/**
 * The K+ commerce service's state (Build 35 Phase B), for acquisition UI only.
 *
 * Nothing read through this hook is entitlement: a READY catalog, a completed
 * purchase and a completed restore all leave K+ access to useKPlusEntitlement().
 * The service resets itself on every actor boundary (resetActorScopedRuntimeState
 * in contexts/AuthSessionContext.tsx), so the snapshot never carries a previous
 * actor's offerings or provider state.
 */
export function useKPlusCommerceSnapshot(): KPlusCommerceSnapshot {
  return useSyncExternalStore(subscribeToKPlusCommerce, getKPlusCommerceSnapshot);
}
