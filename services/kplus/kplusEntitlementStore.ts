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

/**
 * INT-KPLUS-006 — entitlement must self-expire.
 *
 * resolveState() evaluates expiry once, at the moment a server row arrives, and
 * freezes the answer into `snapshot`. A session that stays open past expiresAt
 * with no auth event and no refresh therefore kept reading state 'active'
 * indefinitely.
 *
 * Two mechanisms, both required:
 *   1. READ TIME — getKPlusEntitlementSnapshot() downgrades an expired 'active'
 *      snapshot on every read, so no consumer can observe a lapsed entitlement
 *      even if nothing woke the app.
 *   2. BOUNDARY  — a timer fires AT expiresAt and notifies subscribers, so a UI
 *      sitting idle on screen actually re-renders rather than waiting for the
 *      next unrelated interaction.
 *
 * The server remains decisive for privileged operations; this only stops the
 * CLIENT from presenting or acting on a stale local grant.
 */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
/** Cached identity for the effective (time-adjusted) snapshot.
 *  useSyncExternalStore requires getSnapshot to return a STABLE reference when
 *  nothing changed, so the downgraded object is memoised rather than rebuilt. */
let effectiveSnapshot: KPlusEntitlementSnapshot | null = null;

// setTimeout overflows past ~24.8 days and fires immediately; clamp so a long
// grant schedules a far-future re-check instead of a spurious instant one.
const MAX_TIMER_MS = 2_147_483_647;

function clearExpiryTimer() {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function expiresAtMs(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Schedule a notification at the expiry boundary of an active snapshot. */
function scheduleExpiry(next: KPlusEntitlementSnapshot) {
  clearExpiryTimer();
  if (next.state !== 'active') return;
  const ms = expiresAtMs(next.expiresAt);
  if (ms === null) return;
  const delay = ms - Date.now();
  if (delay <= 0) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    // The read-time downgrade in getKPlusEntitlementSnapshot does the actual
    // state change; this just wakes subscribers so they re-read it.
    effectiveSnapshot = null;
    emit();
  }, Math.min(delay, MAX_TIMER_MS));
  // Never hold the process open for this in Node-based tests.
  (expiryTimer as unknown as { unref?: () => void })?.unref?.();
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

function setSnapshot(next: KPlusEntitlementSnapshot) {
  snapshot = next;
  effectiveSnapshot = null;
  scheduleExpiry(next);
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

/**
 * The effective snapshot AS OF NOW.
 *
 * An 'active' snapshot whose expiresAt has passed is reported 'expired' without
 * requiring a server round trip, an auth event, or an app resume. The result is
 * memoised so repeated reads return a stable reference (useSyncExternalStore
 * loops forever otherwise).
 */
export function getKPlusEntitlementSnapshot(): KPlusEntitlementSnapshot {
  if (snapshot.state !== 'active') return snapshot;
  const ms = expiresAtMs(snapshot.expiresAt);
  // An 'active' state with no readable expiry is not a durable grant. Fail
  // closed rather than treating a null expiry as "never expires".
  if (ms === null || ms <= Date.now()) {
    if (!effectiveSnapshot) {
      effectiveSnapshot = { ...snapshot, state: 'expired' };
    }
    return effectiveSnapshot;
  }
  return snapshot;
}

/** Test seam: drop the pending expiry timer. */
export function __clearKPlusExpiryTimerForTests(): void {
  clearExpiryTimer();
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
  clearExpiryTimer();
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
