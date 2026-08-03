/**
 * Checkpoint 4.5 — lifecycle safety for the similarity candidate request.
 *
 * WHY A SEPARATE LEDGER FROM `scanSelectionSession.ts`
 *
 * They guard different things and must not be merged:
 *
 *   scanSelectionSession  "which GARMENT did the user pick out of a multi-item
 *                          photo, and has that selection been dispatched?"
 *                          Its claim ledger prevents a second PAID provider run.
 *
 *   this module           "for this scan, has a candidate set already been
 *                          attached, and is the one I am holding still valid?"
 *                          It prevents a duplicate similarity request after a
 *                          background/resume, and prevents a stale candidate
 *                          set built against a previous scan from being
 *                          attached to a new one.
 *
 * `scanSelectionSession` remains the single source of truth for selection
 * dispatch. Nothing here reads, writes or duplicates its
 * `dispatchedCandidateIds` / `rejectedCandidateIds` ledger, and nothing here
 * can authorise a selection dispatch.
 *
 * DELIBERATELY IN-MEMORY ONLY
 *
 * This is NOT persisted to AsyncStorage, and that is a decision rather than an
 * omission. Persisting it would mean writing a description of the user's
 * wardrobe — brand, category, colour and image URIs for up to 20 owned items —
 * into the same plaintext store that already holds refresh tokens. The
 * candidate set is cheap to rebuild (it is a bounded read of data already on
 * the device), so persistence would trade a real privacy cost for a saved
 * file read.
 *
 * Consequently a cold start after a process death simply rebuilds. A warm
 * background/resume keeps the entry and is protected by the checks below.
 *
 * NO IMAGE BYTES ARE HELD HERE. The ledger stores counts, a scan id and a
 * timestamp — never candidate payloads.
 */

/**
 * How long a built candidate set stays attachable.
 *
 * Matched to `SESSION_TTL_MS` in `scanSelectionSession.ts` on purpose: the two
 * expire together, so a resumed scan cannot find a live selection session
 * beside a dead candidate set (or vice versa) and behave inconsistently.
 */
export const CANDIDATE_SET_TTL_MS = 30 * 60 * 1000;

export type SimilarityRequestEntry = {
  /** The scan this candidate set was built for. Never reused across scans. */
  scanId: string;
  /** Count only — the payload itself is never held here. */
  candidateCount: number;
  builtAtMs: number;
  /** Set once the request carrying these candidates has been dispatched. */
  dispatchedAtMs: number | null;
};

export type SimilarityLedger = {
  entries: SimilarityRequestEntry[];
};

export function createSimilarityLedger(): SimilarityLedger {
  return { entries: [] };
}

/** Records that a candidate set has been built for a scan. Idempotent per scan. */
export function recordCandidateSetBuilt(
  ledger: SimilarityLedger,
  input: { scanId: string; candidateCount: number; nowMs: number },
): SimilarityLedger {
  const without = ledger.entries.filter((entry) => entry.scanId !== input.scanId);
  return {
    entries: [
      ...without,
      {
        scanId: input.scanId,
        candidateCount: input.candidateCount,
        builtAtMs: input.nowMs,
        dispatchedAtMs: null,
      },
    ],
  };
}

export function findEntry(
  ledger: SimilarityLedger,
  scanId: string,
): SimilarityRequestEntry | null {
  return ledger.entries.find((entry) => entry.scanId === scanId) ?? null;
}

export function isEntryExpired(entry: SimilarityRequestEntry, nowMs: number): boolean {
  return nowMs - entry.builtAtMs > CANDIDATE_SET_TTL_MS;
}

/**
 * Whether a similarity candidate set may be attached to a request right now.
 *
 * Returns a REASON rather than a bare boolean so a caller — and a test — can
 * distinguish "already sent, do not send again" from "too old, rebuild it".
 * Those need opposite handling, and collapsing them to `false` is how a resume
 * quietly becomes either a duplicate request or a silently disabled feature.
 */
export type AttachDecision =
  | { allowed: true }
  | { allowed: false; reason: 'already_dispatched' | 'candidate_set_expired' | 'unknown_scan' | 'scan_mismatch' };

export function canAttachCandidates(
  ledger: SimilarityLedger,
  input: { scanId: string; nowMs: number },
): AttachDecision {
  const entry = findEntry(ledger, input.scanId);
  if (!entry) return { allowed: false, reason: 'unknown_scan' };
  if (isEntryExpired(entry, input.nowMs)) return { allowed: false, reason: 'candidate_set_expired' };
  if (entry.dispatchedAtMs !== null) return { allowed: false, reason: 'already_dispatched' };
  return { allowed: true };
}

/**
 * Marks the candidate set as dispatched. Idempotent — a double call cannot
 * produce a second dispatch, which is the resume case this exists for.
 */
export function markCandidatesDispatched(
  ledger: SimilarityLedger,
  input: { scanId: string; nowMs: number },
): SimilarityLedger {
  return {
    entries: ledger.entries.map((entry) =>
      entry.scanId === input.scanId && entry.dispatchedAtMs === null
        ? { ...entry, dispatchedAtMs: input.nowMs }
        : entry
    ),
  };
}

/**
 * Guards against attaching a candidate set built for a DIFFERENT scan.
 *
 * The stale-state failure this prevents: a user scans item A, backgrounds the
 * app while candidates are being built, returns, and scans item B. Without
 * this check the in-flight candidate set from A could be attached to B's
 * request — producing comparisons against a wardrobe subset chosen for a
 * garment the user is no longer looking at.
 *
 * NO SUBSTITUTION: the answer is to send nothing, never to swap in a
 * different candidate set. That mirrors the selection rule in
 * `scanSelectionSession.markRejected` — the client does not guess.
 */
export function candidateSetMatchesScan(
  builtForScanId: string | null | undefined,
  currentScanId: string | null | undefined,
): boolean {
  if (!builtForScanId || !currentScanId) return false;
  return builtForScanId === currentScanId;
}

/** Drops expired entries. Called on resume so the ledger cannot grow unbounded. */
export function pruneExpired(ledger: SimilarityLedger, nowMs: number): SimilarityLedger {
  return { entries: ledger.entries.filter((entry) => !isEntryExpired(entry, nowMs)) };
}
