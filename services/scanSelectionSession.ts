/**
 * Selection-session persistence and lifecycle safety.
 *
 * THE TWO PROBLEMS THIS SOLVES
 *
 * 1. RESUME. A user photographs four garments, gets the selection screen, and
 *    switches apps to check something. Without persistence the selection state
 *    dies with the in-memory hook and they return to an empty scanner having
 *    lost the photograph — the exact point in the funnel that production
 *    telemetry already shows leaking (multi-item detection active daily,
 *    `selected_item` not firing for four days).
 *
 * 2. DOUBLE DISPATCH. Resume, retry and re-render can each re-enter the
 *    dispatch path. Two identical `selected_item` requests cost two paid
 *    provider runs and can deliver two results for one user action. The claim
 *    ledger below makes a dispatch happen at most once per candidate per
 *    session.
 *
 * WHAT IS DELIBERATELY NOT STORED
 *
 * No image bytes. The session holds the selection tokens, the candidate
 * descriptions and local image URIs — enough to re-render the choice — and
 * nothing that would put photographs into AsyncStorage. Refresh tokens already
 * sit in plaintext AsyncStorage on this platform; adding scan imagery to the
 * same store would widen an exposure that is already an open issue.
 *
 * The store is intentionally single-session. Selection is a decision the user
 * is in the middle of making, not history worth accumulating.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { SelectionCandidateView, SelectionLineageToken } from './scanJourney';

const STORAGE_KEY = 'kscan.scanSelectionSession.v1';

/**
 * Sessions older than this are dropped on read.
 *
 * A selection is only meaningful against the image that produced it, and the
 * backend validates the image digest — so a stale session would fail server-side
 * anyway. Expiring locally turns a confusing rejection into a clean restart.
 */
export const SESSION_TTL_MS = 30 * 60 * 1000;

export type SelectionSession = {
  version: 1;
  scanId: string;
  scanSessionId: string | null;
  imageDigestPrefix: string | null;
  /** Local URI of the scanned image, for re-rendering the selection screen. */
  sourceImageUri: string | null;
  candidates: SelectionCandidateView[];
  /** Candidate ids already dispatched. The double-dispatch ledger. */
  dispatchedCandidateIds: string[];
  /** Candidate ids the backend rejected. Never retried automatically. */
  rejectedCandidateIds: string[];
  createdAtMs: number;
};

export function createSelectionSession(input: {
  scanId: string;
  scanSessionId?: string | null;
  imageDigestPrefix?: string | null;
  sourceImageUri?: string | null;
  candidates: SelectionCandidateView[];
  nowMs: number;
}): SelectionSession {
  return {
    version: 1,
    scanId: input.scanId,
    scanSessionId: input.scanSessionId ?? null,
    imageDigestPrefix: input.imageDigestPrefix ?? null,
    sourceImageUri: input.sourceImageUri ?? null,
    candidates: input.candidates,
    dispatchedCandidateIds: [],
    rejectedCandidateIds: [],
    createdAtMs: input.nowMs,
  };
}

export function isSessionExpired(session: SelectionSession, nowMs: number): boolean {
  return nowMs - session.createdAtMs > SESSION_TTL_MS;
}

/**
 * Whether this candidate may be dispatched right now.
 *
 * Returns a reason rather than a bare boolean so the caller can tell "already
 * running" from "the backend said no" — those need different handling, and one
 * of them must never become an automatic retry.
 */
export type DispatchDecision =
  | { allowed: true }
  | { allowed: false; reason: 'already_dispatched' | 'previously_rejected' | 'unknown_candidate' | 'session_expired' };

export function canDispatchCandidate(
  session: SelectionSession | null,
  candidateId: string,
  nowMs: number,
): DispatchDecision {
  if (!session) return { allowed: false, reason: 'session_expired' };
  if (isSessionExpired(session, nowMs)) return { allowed: false, reason: 'session_expired' };
  if (!session.candidates.some((candidate) => candidate.candidateId === candidateId)) {
    return { allowed: false, reason: 'unknown_candidate' };
  }
  if (session.rejectedCandidateIds.includes(candidateId)) {
    return { allowed: false, reason: 'previously_rejected' };
  }
  if (session.dispatchedCandidateIds.includes(candidateId)) {
    return { allowed: false, reason: 'already_dispatched' };
  }
  return { allowed: true };
}

/** Records a dispatch. Idempotent, so a double call cannot double-count. */
export function markDispatched(session: SelectionSession, candidateId: string): SelectionSession {
  if (session.dispatchedCandidateIds.includes(candidateId)) return session;
  return {
    ...session,
    dispatchedCandidateIds: [...session.dispatchedCandidateIds, candidateId],
  };
}

/**
 * Records a backend rejection of a selection token.
 *
 * THE RULE: a rejected candidate is never retried automatically, and the client
 * never substitutes a different candidate. The backend rejects a mismatched
 * token precisely because it must not guess which garment was meant; a client
 * that responded by silently trying the next one would reintroduce the guess on
 * the other side of the wire.
 *
 * The candidate stays in the session so the user can still see it and choose
 * again deliberately — removing it would look like the app had decided for them.
 */
export function markRejected(session: SelectionSession, candidateId: string): SelectionSession {
  const dispatched = session.dispatchedCandidateIds.filter((id) => id !== candidateId);
  if (session.rejectedCandidateIds.includes(candidateId)) {
    return { ...session, dispatchedCandidateIds: dispatched };
  }
  return {
    ...session,
    dispatchedCandidateIds: dispatched,
    rejectedCandidateIds: [...session.rejectedCandidateIds, candidateId],
  };
}

export function findCandidate(
  session: SelectionSession | null,
  candidateId: string,
): SelectionCandidateView | null {
  return session?.candidates.find((c) => c.candidateId === candidateId) ?? null;
}

export function tokenFor(
  session: SelectionSession | null,
  candidateId: string,
): SelectionLineageToken | null {
  return findCandidate(session, candidateId)?.selectionToken ?? null;
}

// ── persistence ─────────────────────────────────────────────────────────────

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * All three functions swallow storage errors.
 *
 * Persistence is a convenience on top of a flow that works in memory. A failed
 * write must not break a scan the user is in the middle of, and a failed read
 * is indistinguishable from "no session", which is a state the caller already
 * handles.
 */
export async function saveSelectionSession(
  session: SelectionSession,
  storage: Storage = AsyncStorage,
): Promise<void> {
  try {
    await storage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Intentionally ignored — see the note above.
  }
}

export async function loadSelectionSession(
  nowMs: number,
  storage: Storage = AsyncStorage,
): Promise<SelectionSession | null> {
  try {
    const raw = await storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SelectionSession;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.candidates)) return null;
    if (isSessionExpired(parsed, nowMs)) {
      await clearSelectionSession(storage);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearSelectionSession(storage: Storage = AsyncStorage): Promise<void> {
  try {
    await storage.removeItem(STORAGE_KEY);
  } catch {
    // Intentionally ignored — see the note above.
  }
}
