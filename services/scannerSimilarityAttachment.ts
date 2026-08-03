/**
 * Checkpoint 5A — the one place a similarity candidate set is attached to a
 * real scanner request.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHEN CANDIDATES MAY BE ATTACHED — the rule this module exists to enforce
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Only once a SPECIFIC GARMENT IDENTITY HAS BEEN RESOLVED, whether that came
 * from an ordinary single-item scan or from an explicit multi-item selection.
 *
 * Both of those reach `runScannerIdentification` with
 * `mode === 'identify_selected_item'`, because neither platform auto-selects:
 * a photo containing exactly one garment still produces one detection
 * candidate that the user confirms, and that confirmation is what dispatches
 * the selected-item request. So a single mount point covers both flows, and
 * the check is on the resolved selection rather than on a count of garments.
 *
 * The initial `detect_items` request is deliberately EXCLUDED. At that moment
 * the client does not know what it is looking at, so any candidate set built
 * there would be pruned against a guessed garment — the specific failure this
 * checkpoint forbids. `shouldAttachCandidates` returns false for it, and no
 * loader runs, so a detection request costs exactly what it costs today.
 *
 * FAILURE CONTRACT — FAIL OPEN, ALWAYS
 *
 * This never throws and never rejects. Every failure returns
 * `{ attached: false }` and the scan proceeds without candidates, which is
 * byte-identical to the pre-mount request. Similarity is advisory; it may
 * never be the reason a scan or a product match fails.
 *
 * NO IMAGE BYTES, NO MUTATION, NO PERSISTENCE, NO NETWORK.
 */

import {
  buildSimilarityCandidates,
  type BuildSimilarityCandidatesInput,
  type CandidateLoadTimings,
  type RawRecordLoader,
  type SimilarityCandidateOutcome,
} from './similarItemCandidateProvider';
import type { ClientCandidateReport, ClientScanQuery, TransmittedCandidate } from './similarItemCandidates';
import {
  canAttachCandidates,
  findEntry,
  markCandidatesDispatched,
  recordCandidateSetBuilt,
  type SimilarityLedger,
} from './similarityRequestLedger';

/** The scanner modes this module understands. Mirrors `ScannerV2Mode`. */
export type SimilarityDispatchMode = 'detect_items' | 'identify_selected_item';

/**
 * Why no candidates were attached. Every one of these is a normal outcome, not
 * an error — they exist so device measurement can tell "the feature is off"
 * apart from "the user has an empty Closet" apart from "the read failed".
 */
export type SimilaritySkipReason =
  | 'flag_disabled'
  | 'not_a_resolved_item_request'
  | 'no_identity_resolved'
  | 'no_binding_supplied'
  | 'ledger_already_dispatched'
  | 'ledger_candidate_set_expired'
  | 'ledger_scan_mismatch'
  | 'no_candidates_survived'
  | 'provider_failed';

/**
 * Everything the platform binding supplies. The loaders are injected rather
 * than imported for the same reason the provider injects them: they are the
 * modules that genuinely diverge between the platform lines, and importing
 * them here would make this file un-shareable.
 */
export type SimilarityBinding = {
  /**
   * Resolved by the caller from the governed flag. Passed in rather than read
   * here so this module stays pure and a test can drive both states without
   * touching `process.env`.
   */
  enabled: boolean;
  /** Correlates the built candidate set to this scan. Never reused across scans. */
  scanId: string;
  /** The resolved garment identity. Built from the user's confirmed selection. */
  query: ClientScanQuery;
  loadClosetRecords?: RawRecordLoader | null;
  loadRecentScanRecords?: RawRecordLoader | null;
  /** In-memory duplicate-dispatch guard. Omit to skip ledger enforcement. */
  ledger?: SimilarityLedger | null;
  config?: BuildSimilarityCandidatesInput['config'];
  loadDeadlineMs?: number;
  now?: () => number;
  /** Receives one record per attempt, attached or not. Never throws upward. */
  onInstrumentation?: (record: SimilarityAttachmentInstrumentation) => void;
};

/**
 * One measurement per attach attempt. Emitted even when nothing was attached,
 * because "the flag was on and zero candidates survived" and "the flag was
 * off" are different facts and a device run has to distinguish them.
 */
export type SimilarityAttachmentInstrumentation = {
  scanId: string;
  mode: SimilarityDispatchMode;
  attached: boolean;
  skipReason?: SimilaritySkipReason;
  /** Named provider failure, when the provider reported one. */
  failureReason?: SimilarityCandidateOutcome['failureReason'];
  transmittedCount: number;
  payloadBytes: number;
  loadTimings: CandidateLoadTimings | null;
  report: ClientCandidateReport | null;
  /** Wall clock for the whole attach attempt, loaders included. */
  totalMs: number;
};

export type SimilarityAttachmentResult = {
  attached: boolean;
  /** Present only when `attached` is true AND at least one candidate survived. */
  existingItems?: TransmittedCandidate[];
  skipReason?: SimilaritySkipReason;
  /** The ledger advanced by this attempt. Callers must adopt it. */
  ledger?: SimilarityLedger | null;
  instrumentation: SimilarityAttachmentInstrumentation;
};

const ZERO_TIMINGS: CandidateLoadTimings = {
  closetMs: 0,
  recentScansMs: 0,
  closetStartedAtMs: 0,
  closetCompletedAtMs: 0,
  recentScansStartedAtMs: 0,
  recentScansCompletedAtMs: 0,
  combinedMs: 0,
};

/**
 * The gate, exported so the wiring test can assert it directly rather than
 * inferring it from a request body.
 *
 * A detection request is excluded even when the flag is on and a binding is
 * present, because at detection time there is no resolved identity to prune
 * against.
 */
export function shouldAttachCandidates(
  mode: SimilarityDispatchMode,
  binding: SimilarityBinding | null | undefined,
): boolean {
  if (!binding) return false;
  if (!binding.enabled) return false;
  return mode === 'identify_selected_item';
}

/** True when the query carries at least one field the backend could compare. */
function hasResolvedIdentity(query: ClientScanQuery | null | undefined): boolean {
  if (!query || typeof query !== 'object') return false;
  return Object.values(query).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

function emit(
  binding: SimilarityBinding | null | undefined,
  record: SimilarityAttachmentInstrumentation,
): void {
  if (!binding?.onInstrumentation) return;
  try {
    binding.onInstrumentation(record);
  } catch {
    // An instrumentation sink must never be able to fail a scan.
  }
}

function skip(
  mode: SimilarityDispatchMode,
  binding: SimilarityBinding | null | undefined,
  skipReason: SimilaritySkipReason,
  startedAtMs: number,
  nowMs: number,
): SimilarityAttachmentResult {
  const instrumentation: SimilarityAttachmentInstrumentation = {
    scanId: binding?.scanId ?? '',
    mode,
    attached: false,
    skipReason,
    transmittedCount: 0,
    payloadBytes: 0,
    loadTimings: null,
    report: null,
    totalMs: nowMs - startedAtMs,
  };
  emit(binding, instrumentation);
  return {
    attached: false,
    skipReason,
    ledger: binding?.ledger ?? null,
    instrumentation,
  };
}

/**
 * Builds and attaches a bounded candidate set, or explains why it did not.
 *
 * Never throws. Never rejects. Never mutates a record. Never persists.
 */
export async function attachSimilarityCandidates(
  mode: SimilarityDispatchMode,
  binding: SimilarityBinding | null | undefined,
): Promise<SimilarityAttachmentResult> {
  const now = binding?.now ?? (() => Date.now());
  const startedAtMs = now();

  if (!binding) return skip(mode, binding, 'no_binding_supplied', startedAtMs, now());
  if (!binding.enabled) return skip(mode, binding, 'flag_disabled', startedAtMs, now());
  if (mode !== 'identify_selected_item') {
    return skip(mode, binding, 'not_a_resolved_item_request', startedAtMs, now());
  }
  if (!hasResolvedIdentity(binding.query)) {
    return skip(mode, binding, 'no_identity_resolved', startedAtMs, now());
  }

  // Duplicate-dispatch guard. A background/resume must not produce a second
  // similarity request, and a set built for a previous scan must never be
  // attached to this one — the answer is to send nothing, never to substitute.
  //
  // The check runs against the ledger AS FOUND. Recording the new set first
  // would overwrite the entry that carries the `dispatchedAtMs` marker, which
  // is exactly the record proving this scan already sent candidates — the
  // resume case this guard exists for.
  let ledger = binding.ledger ?? null;
  if (ledger && findEntry(ledger, binding.scanId)) {
    const decision = canAttachCandidates(ledger, { scanId: binding.scanId, nowMs: now() });
    if (decision.allowed !== true) {
      // Read off a widened view rather than the narrowed union: this repo
      // compiles without `strictNullChecks`, under which the discriminant does
      // not reliably narrow a `{allowed:true} | {allowed:false; reason}` union.
      const declined = decision as { reason?: string };
      const reason: SimilaritySkipReason =
        declined.reason === 'already_dispatched'
          ? 'ledger_already_dispatched'
          : declined.reason === 'candidate_set_expired'
            ? 'ledger_candidate_set_expired'
            : 'ledger_scan_mismatch';
      const result = skip(mode, binding, reason, startedAtMs, now());
      return { ...result, ledger };
    }
  }

  let outcome: SimilarityCandidateOutcome;
  try {
    outcome = await buildSimilarityCandidates({
      query: binding.query,
      loadClosetRecords: binding.loadClosetRecords ?? null,
      loadRecentScanRecords: binding.loadRecentScanRecords ?? null,
      ...(binding.config ? { config: binding.config } : {}),
      ...(binding.loadDeadlineMs !== undefined ? { loadDeadlineMs: binding.loadDeadlineMs } : {}),
      now,
    });
  } catch {
    // The provider documents that it never throws. Guarded anyway: a scan the
    // user is waiting on must not depend on that promise holding.
    const instrumentation: SimilarityAttachmentInstrumentation = {
      scanId: binding.scanId,
      mode,
      attached: false,
      skipReason: 'provider_failed',
      transmittedCount: 0,
      payloadBytes: 0,
      loadTimings: ZERO_TIMINGS,
      report: null,
      totalMs: now() - startedAtMs,
    };
    emit(binding, instrumentation);
    return { attached: false, skipReason: 'provider_failed', ledger, instrumentation };
  }

  const candidates = Array.isArray(outcome.candidates) ? outcome.candidates : [];

  if (candidates.length === 0) {
    const instrumentation: SimilarityAttachmentInstrumentation = {
      scanId: binding.scanId,
      mode,
      attached: false,
      skipReason: 'no_candidates_survived',
      ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
      transmittedCount: 0,
      payloadBytes: outcome.payloadBytes ?? 0,
      loadTimings: outcome.loadTimings ?? ZERO_TIMINGS,
      report: outcome.report ?? null,
      totalMs: now() - startedAtMs,
    };
    emit(binding, instrumentation);
    return { attached: false, skipReason: 'no_candidates_survived', ledger, instrumentation };
  }

  if (ledger) {
    ledger = recordCandidateSetBuilt(ledger, {
      scanId: binding.scanId,
      candidateCount: candidates.length,
      nowMs: now(),
    });
    ledger = markCandidatesDispatched(ledger, { scanId: binding.scanId, nowMs: now() });
  }

  const instrumentation: SimilarityAttachmentInstrumentation = {
    scanId: binding.scanId,
    mode,
    attached: true,
    ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
    transmittedCount: candidates.length,
    payloadBytes: outcome.payloadBytes ?? 0,
    loadTimings: outcome.loadTimings ?? ZERO_TIMINGS,
    report: outcome.report ?? null,
    totalMs: now() - startedAtMs,
  };
  emit(binding, instrumentation);

  return { attached: true, existingItems: candidates, ledger, instrumentation };
}
