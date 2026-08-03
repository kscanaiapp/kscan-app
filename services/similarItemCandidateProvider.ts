/**
 * Checkpoint 4.5 — the one entry point the scan path calls to build a bounded
 * similarity candidate set.
 *
 * WHY LOADERS ARE INJECTED RATHER THAN IMPORTED
 *
 * The Closet and Recent Scans loaders are exactly the modules that DIVERGE
 * between the platform lines (`services/library.js` carries per-actor manifest
 * partitioning on one line and not the other; `services/savedScansCloud.ts`
 * differs in its result shape; `services/purchaseOptions.ts` exists on one
 * line only). Importing them here would make this file un-shareable and would
 * force an unsafe cherry-pick of genuinely divergent code.
 *
 * Injecting them keeps this module byte-identical across both lines and puts
 * the platform-specific part where it belongs: in the thin binding that knows
 * which loader its own line has.
 *
 * THE FAILURE CONTRACT — THE MOST IMPORTANT THING IN THIS FILE
 *
 * This never throws and never rejects. Every failure path returns
 * `candidates: []` plus a named `failureReason`, because the caller is in the
 * middle of a scan the user is waiting on:
 *
 *   loader throws         → no candidates, scan proceeds, product match proceeds
 *   loader hangs          → bounded by `loadDeadlineMs`, then no candidates
 *   adapter yields junk   → those records are dropped, the rest proceed
 *   selection throws      → no candidates, scan proceeds
 *
 * "No candidates" degrades exactly to pre-Checkpoint-3 behaviour: the backend
 * receives no `existingItems`, produces no comparison, and the scan and its
 * commerce results are byte-identical to today. That is the whole safety
 * argument for wiring this into a live scan path at all.
 *
 * NO IMAGE BYTES, NO MUTATION, NO PERSISTENCE.
 */

import {
  candidatePayloadBytes,
  readCandidateSelectionConfig,
  selectComparisonCandidates,
  type CandidateSelectionConfig,
  type ClientCandidateReport,
  type ClientScanQuery,
  type TransmittedCandidate,
} from './similarItemCandidates';
import {
  closetRecordsToCandidates,
  recentScanRecordsToCandidates,
} from './similarItemCandidateAdapters';

/**
 * Ceiling on local loading. A HANG GUARD, not a latency budget.
 *
 * Generous on purpose, for the same reason the product-match ceilings are: a
 * slow local read should be MEASURED rather than truncated into an
 * unattributable timeout. It exists so a wedged file read or a stalled cloud
 * list cannot delay a scan indefinitely — not to trim milliseconds.
 */
export const CANDIDATE_LOAD_DEADLINE_MS = 4000;

export type CandidateLoadFailureReason =
  | 'closet_load_failed'
  | 'recent_scans_load_failed'
  | 'both_loads_failed'
  | 'load_timeout'
  | 'selection_failed';

export type SimilarityCandidateOutcome = {
  candidates: TransmittedCandidate[];
  /** Serialized size of the transmitted array, in bytes. */
  payloadBytes: number;
  /** Null when nothing was supplied to load from and nothing failed. */
  report: ClientCandidateReport | null;
  failureReason?: CandidateLoadFailureReason;
  /** Wall clock for each load, measured even when the load failed. */
  loadTimings: { closetMs: number; recentScansMs: number };
};

/** Returns raw stored records. May be async, may throw — both are handled. */
export type RawRecordLoader = () => Promise<unknown[]> | unknown[];

export type BuildSimilarityCandidatesInput = {
  query: ClientScanQuery;
  /** Omit to skip that source entirely (e.g. a Closet-intent scan). */
  loadClosetRecords?: RawRecordLoader | null;
  loadRecentScanRecords?: RawRecordLoader | null;
  config?: CandidateSelectionConfig;
  loadDeadlineMs?: number;
  now?: () => number;
};

/** Resolves a loader to an array, never throwing and never hanging past the deadline. */
async function loadSafely(
  loader: RawRecordLoader | null | undefined,
  deadlineMs: number,
): Promise<{ records: unknown[]; failed: boolean }> {
  if (!loader) return { records: [], failed: false };
  try {
    const result = loader();
    const settled = await Promise.race([
      Promise.resolve(result),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('candidate_load_timeout')), deadlineMs);
      }),
    ]);
    return { records: Array.isArray(settled) ? settled : [], failed: false };
  } catch {
    // Deliberately swallowed and reported as a flag. See the failure contract.
    return { records: [], failed: true };
  }
}

/**
 * Loads, adapts, prunes and bounds — returning what should be transmitted.
 *
 * Both loads run CONCURRENTLY: they are independent reads and running them in
 * sequence would add the slower one's latency to every scan for no reason.
 */
export async function buildSimilarityCandidates(
  input: BuildSimilarityCandidatesInput,
): Promise<SimilarityCandidateOutcome> {
  const now = input.now ?? (() => Date.now());
  const deadlineMs = input.loadDeadlineMs ?? CANDIDATE_LOAD_DEADLINE_MS;

  const closetStartedAt = now();
  const recentStartedAt = now();
  const [closet, recent] = await Promise.all([
    loadSafely(input.loadClosetRecords, deadlineMs),
    loadSafely(input.loadRecentScanRecords, deadlineMs),
  ]);
  const loadedAt = now();
  const loadTimings = {
    closetMs: loadedAt - closetStartedAt,
    recentScansMs: loadedAt - recentStartedAt,
  };

  let failureReason: CandidateLoadFailureReason | undefined;
  if (closet.failed && recent.failed) failureReason = 'both_loads_failed';
  else if (closet.failed) failureReason = 'closet_load_failed';
  else if (recent.failed) failureReason = 'recent_scans_load_failed';

  try {
    const result = selectComparisonCandidates({
      query: input.query,
      closetRecords: closetRecordsToCandidates(closet.records),
      recentScanRecords: recentScanRecordsToCandidates(recent.records),
      config: input.config ?? readCandidateSelectionConfig(),
      now,
    });
    return {
      candidates: result.candidates,
      payloadBytes: candidatePayloadBytes(result.candidates),
      report: result.report,
      ...(failureReason ? { failureReason } : {}),
      loadTimings,
    };
  } catch {
    // Selection is pure and should not throw; if it ever does, the scan must
    // still complete. Reported rather than silently returning an empty report.
    return {
      candidates: [],
      payloadBytes: 0,
      report: null,
      failureReason: 'selection_failed',
      loadTimings,
    };
  }
}
