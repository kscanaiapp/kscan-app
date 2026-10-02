// Module-level store for the K+ entitlement. Exported separately from the hook
// so the actor-boundary reset contract (resetKPlusEntitlementCache, wired into
// contexts/AuthSessionContext.tsx's resetActorScopedRuntimeState) can be
// unit-tested without mounting React components, and so a fresh signed-in actor
// can never observe a previous actor's cached K+ state.
//
// BUILD 35 PHASE A -- the store's truth is the canonical client state of
// types/kplusEntitlementContract.ts, read through
// services/kplus/kplusEntitlementReader.ts (get_my_kplus_entitlement_summary):
//
//     resolved | resolving | unavailable | signed_out
//
// The UI-facing KPlusEntitlementSnapshot that every K+ surface already consumes
// (state 'loading' | 'eligible' | 'active' | 'expired' | 'unavailable' | 'error')
// is a PROJECTION of that state. No surface needs to know whether K+ came from a
// complimentary grant, a store subscription or a lifetime purchase: they ask only
// whether the actor has K+.
//
// Invariants:
//   - The device never grants itself K+. 'active' is projected only from a
//     server answer that parsed and said access 'k_plus'.
//   - RESOLVING != FREE. 'loading', 'error' and 'unavailable' are never 'eligible'
//     or 'expired'; only a positively resolved free answer is.
//   - A cached K+ summary is a bounded PRESENTATION snapshot: used only when the
//     server cannot be reached, never older than the freshness policy allows,
//     never past the entitlement's own end, and never across an actor boundary.
//     A cached FREE answer is never used this way: unreadable != free.

import { activateKPlusEarlyAccess } from './kplusClient';
import { readKPlusEntitlementSummary, type KPlusSummaryReadResult } from './kplusEntitlementReader';
import {
  evaluateKPlusPresentationSnapshot,
  kplusPresentationSnapshotValidUntilMs,
  type KPlusEntitlementClientState,
  type KPlusEntitlementSummary,
} from '../../types/kplusEntitlementContract';
import type { KPlusEntitlementSnapshot, KPlusResolvedState } from '../../types/entitlements';

type Listener = () => void;

export const DEFAULT_KPLUS_SNAPSHOT: KPlusEntitlementSnapshot = Object.freeze({
  state: 'loading' as KPlusResolvedState,
  expiresAt: null,
  campaignKey: null,
  externalSyncStatus: null,
  displaySource: null,
  isOpenEnded: false,
});

const RESOLVING: KPlusEntitlementClientState = Object.freeze({ status: 'resolving' as const });
/** Bounded access that has run past its own end, or a cached answer that has
 *  aged out: unverified, never free. */
const UNVERIFIED: KPlusEntitlementClientState = Object.freeze({
  status: 'unavailable' as const,
  reason: 'snapshot_expired' as const,
});

let clientState: KPlusEntitlementClientState = RESOLVING;
/** The last answer the SERVER gave this actor. Only ever used as a bounded
 *  presentation snapshot while the server is unreachable. */
let lastServerSummary: KPlusEntitlementSummary | null = null;
let inFlightRequestId = 0;
let pendingRefreshId: number | null = null;
/** Bumped only by an actor reset. A flow that awaits across more than one
 *  request compares it, so it can tell "another request superseded me" (benign)
 *  from "the actor changed" (discard everything). */
let actorGeneration = 0;
const listeners = new Set<Listener>();

/**
 * INT-KPLUS-006 -- entitlement must self-expire.
 *
 * Bounded access (a complimentary term, a subscription's paid-through date)
 * must not keep presenting as active past its own end just because nothing woke
 * the app. Two mechanisms, both required:
 *   1. READ TIME -- effectiveClientState() downgrades bounded access that has
 *      run past its end, and a cached snapshot that has aged out, on every read.
 *   2. BOUNDARY  -- a timer fires AT that instant, wakes subscribers, and asks
 *      the server again.
 *
 * Past its end the answer is UNVERIFIED, not free: a subscription may have
 * renewed in the same instant, so the client must not tell a paying customer
 * they are free. The server decides, and the answer is re-read at the boundary.
 */
let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
let projectionCache: { key: string; snapshot: KPlusEntitlementSnapshot } | null = null;

// setTimeout overflows past ~24.8 days and fires immediately; clamp so a long
// grant schedules a far-future re-check instead of a spurious instant one.
const MAX_TIMER_MS = 2_147_483_647;

function clearBoundaryTimer() {
  if (boundaryTimer !== null) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
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

function isBoundedAccess(state: KPlusEntitlementClientState): state is Extract<KPlusEntitlementClientState, { status: 'resolved' }> {
  return state.status === 'resolved'
    && state.summary.access === 'k_plus'
    && !state.summary.isOpenEnded
    && state.summary.effectiveExpiresAt !== null;
}

/** K+ access that is neither open-ended nor carries a readable end is not a
 *  durable grant. (The reader's strict parse already refuses it; this is the
 *  store's own fail-closed guard.) */
function hasUnreadableEnd(summary: KPlusEntitlementSummary): boolean {
  if (summary.access !== 'k_plus' || summary.isOpenEnded) return false;
  return typeof summary.effectiveExpiresAt !== 'string' || !Number.isFinite(Date.parse(summary.effectiveExpiresAt));
}

/** The canonical state AS OF NOW. */
function effectiveClientState(nowMs: number): KPlusEntitlementClientState {
  const state = clientState;
  if (state.status !== 'resolved') return state;
  if (hasUnreadableEnd(state.summary)) return UNVERIFIED;

  if (state.origin === 'presentation_snapshot') {
    // A cached answer ages: it is re-judged against the freshness policy on
    // every read, including clock sanity and the entitlement's own end.
    const evaluated = evaluateKPlusPresentationSnapshot(state.summary, nowMs);
    return evaluated.status === 'resolved' ? state : evaluated;
  }

  if (isBoundedAccess(state)) {
    const endMs = Date.parse(state.summary.effectiveExpiresAt as string);
    // An unreadable end is not a durable grant: fail closed to unverified.
    if (!Number.isFinite(endMs) || nowMs >= endMs) return UNVERIFIED;
  }
  return state;
}

function projectionKey(state: KPlusEntitlementClientState, refreshing: boolean): string {
  if (state.status === 'resolved') {
    const s = state.summary;
    return [
      'resolved', state.origin, s.snapshotIssuedAt, s.access, s.displaySource ?? '-',
      s.effectiveExpiresAt ?? '-', s.isOpenEnded ? 'open' : 'bounded', String(s.complimentaryHistory),
    ].join('|');
  }
  if (state.status === 'unavailable') return `unavailable|${state.reason}|${refreshing ? 'refreshing' : 'idle'}`;
  return state.status;
}

/** Projects the canonical state onto the state every K+ surface already reads. */
function project(state: KPlusEntitlementClientState, refreshing: boolean): KPlusEntitlementSnapshot {
  switch (state.status) {
    case 'resolving':
      return DEFAULT_KPLUS_SNAPSHOT;
    case 'signed_out':
      // Not a K+ answer for anyone: K+ does not apply to a signed-out session.
      return { ...DEFAULT_KPLUS_SNAPSHOT, state: 'unavailable' };
    case 'unavailable':
      // Aged-out or lapsed answers are being re-read right now: say so rather
      // than flash an error. Every other cause is "we could not be told".
      if (refreshing && state.reason === 'snapshot_expired') return DEFAULT_KPLUS_SNAPSHOT;
      return { ...DEFAULT_KPLUS_SNAPSHOT, state: 'error' };
    case 'resolved': {
      const summary = state.summary;
      if (summary.access === 'k_plus') {
        return {
          state: 'active',
          expiresAt: summary.isOpenEnded ? null : summary.effectiveExpiresAt,
          campaignKey: null,
          externalSyncStatus: null,
          displaySource: summary.displaySource,
          isOpenEnded: summary.isOpenEnded,
        };
      }
      // A positively resolved FREE answer. 'expired' means the account has held
      // complimentary access that has ended; 'eligible' means it never has.
      // An older server that does not report history reads as never-activated.
      return {
        ...DEFAULT_KPLUS_SNAPSHOT,
        state: summary.complimentaryHistory === true ? 'expired' : 'eligible',
      };
    }
    default:
      // Exhaustiveness: a new canonical status can never default to free.
      return { ...DEFAULT_KPLUS_SNAPSHOT, state: 'error' };
  }
}

/** The next instant the answer changes by itself, if any. */
function nextBoundaryMs(state: KPlusEntitlementClientState): number | null {
  if (state.status !== 'resolved') return null;
  if (state.origin === 'presentation_snapshot') return kplusPresentationSnapshotValidUntilMs(state.summary);
  if (isBoundedAccess(state)) {
    const endMs = Date.parse(state.summary.effectiveExpiresAt as string);
    return Number.isFinite(endMs) ? endMs : null;
  }
  return null;
}

function scheduleBoundary() {
  clearBoundaryTimer();
  const boundary = nextBoundaryMs(clientState);
  if (boundary === null) return;
  const delay = boundary - Date.now();
  if (delay <= 0) return;
  const armedFor = clientState;
  boundaryTimer = setTimeout(() => {
    boundaryTimer = null;
    // Only the answer this timer was armed for may wake the server: a reset or
    // a newer answer has already replaced it.
    if (clientState !== armedFor) return;
    projectionCache = null;
    // Start the re-read BEFORE waking subscribers: it marks the answer as being
    // re-checked, so the UI reads "checking", not a flash of "could not check".
    void refreshKPlusEntitlement();
    emit();
  }, Math.min(delay, MAX_TIMER_MS));
  // Never hold the process open for this in Node-based tests.
  (boundaryTimer as unknown as { unref?: () => void })?.unref?.();
}

function setClientState(next: KPlusEntitlementClientState) {
  clientState = next;
  projectionCache = null;
  scheduleBoundary();
  emit();
}

/**
 * The canonical client state AS OF NOW (resolved / resolving / unavailable /
 * signed_out). The UI-facing snapshot is a projection of this.
 */
export function getKPlusEntitlementClientState(): KPlusEntitlementClientState {
  return effectiveClientState(Date.now());
}

/**
 * The UI-facing snapshot AS OF NOW.
 *
 * Memoised so repeated reads return a stable reference while nothing changed
 * (useSyncExternalStore loops forever otherwise).
 */
export function getKPlusEntitlementSnapshot(): KPlusEntitlementSnapshot {
  const effective = effectiveClientState(Date.now());
  const refreshing = pendingRefreshId !== null;
  const key = projectionKey(effective, refreshing);
  if (projectionCache && projectionCache.key === key) return projectionCache.snapshot;
  const snapshot = project(effective, refreshing);
  projectionCache = { key, snapshot };
  return snapshot;
}

/** Test seam: drop the pending boundary timer. */
export function __clearKPlusExpiryTimerForTests(): void {
  clearBoundaryTimer();
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
  actorGeneration += 1;
  pendingRefreshId = null;
  lastServerSummary = null;
  clearBoundaryTimer();
  setClientState(RESOLVING);
}

function applyReadResult(result: KPlusSummaryReadResult) {
  if (result.status === 'resolved') {
    lastServerSummary = result.summary;
    setClientState({ status: 'resolved', summary: result.summary, origin: 'server' });
    return;
  }
  if (result.status === 'signed_out') {
    lastServerSummary = null;
    setClientState({ status: 'signed_out' });
    return;
  }
  // The server could not be reached or answered with a server error: the one
  // case a bounded presentation snapshot may stand in -- and only a K+ snapshot.
  // UNREADABLE != FREE: a cached free answer must never be presented as the
  // current answer just because the latest read failed (it would show an upsell
  // to someone who may have just been granted K+), so it is not eligible to
  // stand in. A MALFORMED answer never uses a snapshot either: it may mean the
  // contract moved, and a stale answer must not paper over that. Past the
  // freshness policy the answer is unavailable, not free.
  if (
    lastServerSummary
    && lastServerSummary.access === 'k_plus'
    && (result.reason === 'network' || result.reason === 'server_error')
  ) {
    setClientState(evaluateKPlusPresentationSnapshot(lastServerSummary, Date.now()));
    return;
  }
  setClientState({ status: 'unavailable', reason: result.reason });
}

export async function refreshKPlusEntitlement(): Promise<void> {
  const requestId = ++inFlightRequestId;
  const now = Date.now();
  const keyBefore = projectionKey(effectiveClientState(now), pendingRefreshId !== null);
  pendingRefreshId = requestId;
  projectionCache = null;
  // An answer that was unverified now reads as "checking": tell subscribers.
  if (keyBefore !== projectionKey(effectiveClientState(now), true)) emit();

  let result: KPlusSummaryReadResult;
  try {
    result = await readKPlusEntitlementSummary();
  } catch {
    result = { status: 'unavailable', reason: 'network' };
  }

  // Settle this request's own in-flight marker whether or not its answer is
  // still current. A refresh superseded by an activation that then failed would
  // otherwise leave the store reporting "checking" forever.
  if (pendingRefreshId === requestId) {
    pendingRefreshId = null;
    projectionCache = null;
    if (requestId !== inFlightRequestId) emit();
  }
  if (requestId !== inFlightRequestId) return; // stale response from a prior actor
  applyReadResult(result);
}

export type ActivateOutcome = 'granted' | 'already_active' | 'campaign_consumed' | 'failed';

/**
 * Asks the server to activate Early Access, then re-reads the canonical state.
 * The activation response is used only to LABEL the outcome when the re-read
 * cannot; it never sets the entitlement state.
 */
export async function activateKPlus(): Promise<ActivateOutcome> {
  const requestId = ++inFlightRequestId;
  const generation = actorGeneration;
  const result = await activateKPlusEarlyAccess();
  if (requestId !== inFlightRequestId) return 'failed'; // actor changed mid-flight

  if (result.ok === false) {
    return 'failed';
  }

  const wasAlreadyKnown = (() => {
    const state = getKPlusEntitlementSnapshot().state;
    return state === 'active' || state === 'expired';
  })();
  const row = result.row;
  const responseSaysActive = row.status === 'active'
    && !row.revokedAt
    && !!row.expiresAt
    && new Date(row.expiresAt).getTime() > Date.now();

  await refreshKPlusEntitlement();
  // The actor changed while the re-read was in flight: that answer, and this
  // activation's outcome, belong to the previous actor. Report nothing.
  if (generation !== actorGeneration) return 'failed';

  // The canonical answer wins when it is available.
  const after = getKPlusEntitlementSnapshot().state;
  if (after === 'active') return wasAlreadyKnown ? 'already_active' : 'granted';
  if (after === 'expired' || after === 'eligible') return 'campaign_consumed';
  // Unresolved re-read: fall back to what the server's own activation said.
  if (!responseSaysActive) return 'campaign_consumed';
  return wasAlreadyKnown ? 'already_active' : 'granted';
}
