// Module-level store for the K+ entitlement snapshot. Exported separately
// from the hook so the actor-boundary reset contract (resetKPlusEntitlementCache,
// wired into contexts/AuthSessionContext.tsx's resetActorScopedRuntimeState)
// can be unit-tested without mounting React components, and so a fresh
// signed-in actor can never observe a previous actor's cached K+ state.

import { activateKPlusEarlyAccess, fetchKPlusStatus } from './kplusClient';
import type {
  KPlusEntitlementRow,
  KPlusEntitlementSnapshot,
  KPlusResolvedState,
} from '../../types/entitlements';

type Listener = () => void;

export const DEFAULT_KPLUS_SNAPSHOT: KPlusEntitlementSnapshot = Object.freeze({
  state: 'loading' as KPlusResolvedState,
  expiresAt: null,
  campaignKey: null,
  externalSyncStatus: null,
});

let snapshot: KPlusEntitlementSnapshot = DEFAULT_KPLUS_SNAPSHOT;
const listeners = new Set<Listener>();
let inFlightRequestId = 0;

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Store listeners must never corrupt the store.
    }
  }
}

function setSnapshot(next: KPlusEntitlementSnapshot) {
  snapshot = next;
  emit();
}

/** Derives the UI-facing state from a raw row, re-checking expiry locally
 *  so a stale cached "active" row past its expiry never renders as active.
 *  Never upgrades a row the server did not send. */
function resolveState(row: KPlusEntitlementRow | null): KPlusEntitlementSnapshot {
  if (!row) {
    return { state: 'eligible', expiresAt: null, campaignKey: null, externalSyncStatus: null };
  }
  const isActive =
    row.status === 'active' && !!row.expiresAt && new Date(row.expiresAt).getTime() > Date.now();
  return {
    state: isActive ? 'active' : 'expired',
    expiresAt: row.expiresAt,
    campaignKey: row.campaignKey,
    externalSyncStatus: row.externalSyncStatus,
  };
}

export function getKPlusEntitlementSnapshot(): KPlusEntitlementSnapshot {
  return snapshot;
}

export function subscribeToKPlusEntitlement(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clears cached K+ state. Called synchronously (before any await) from
 *  resetActorScopedRuntimeState on sign-out and on every detected actor
 *  boundary crossing -- must never leak one user's K+ status to the next. */
export function resetKPlusEntitlementCache(): void {
  inFlightRequestId += 1; // invalidates any in-flight refresh/activate response
  setSnapshot(DEFAULT_KPLUS_SNAPSHOT);
}

export async function refreshKPlusEntitlement(): Promise<void> {
  const requestId = ++inFlightRequestId;
  const result = await fetchKPlusStatus();
  if (requestId !== inFlightRequestId) return; // stale response from a prior actor

  if (result.ok === false) {
    setSnapshot({
      state: result.reason === 'signed_out' ? 'unavailable' : 'error',
      expiresAt: null,
      campaignKey: null,
      externalSyncStatus: null,
    });
    return;
  }
  setSnapshot(resolveState(result.row));
}

export type ActivateOutcome = 'granted' | 'already_active' | 'campaign_consumed' | 'failed';

export async function activateKPlus(): Promise<ActivateOutcome> {
  const requestId = ++inFlightRequestId;
  const result = await activateKPlusEarlyAccess();
  if (requestId !== inFlightRequestId) return 'failed'; // actor changed mid-flight

  if (result.ok === false) {
    return 'failed';
  }

  const wasAlreadyKnown = snapshot.state === 'active' || snapshot.state === 'expired';
  setSnapshot(resolveState(result.row));
  const nowActive = result.row.status === 'active' && !!result.row.expiresAt && new Date(result.row.expiresAt).getTime() > Date.now();
  if (!nowActive) return 'campaign_consumed';
  if (wasAlreadyKnown) return 'already_active';
  return 'granted';
}
