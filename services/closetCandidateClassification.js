/**
 * Closet candidate classification orchestrator (Build 1).
 *
 * THE ONE PLACE a staged candidate is driven from `queued` to a resolved state.
 * Every ordering decision that matters lives here, in one readable sequence:
 *
 *   load candidate
 *   -> confirm actor authority        (epoch, not just id)
 *   -> confirm not expired
 *   -> confirm candidate still current
 *   -> confirm network state
 *   -> transition to `classifying`
 *   -> create AbortController
 *   -> call identify_for_closet       (services/closetIdentificationV2.ts only)
 *   -> validate + normalize response
 *   -> REVALIDATE actor epoch
 *   -> REVALIDATE candidate state
 *   -> persist metadata
 *   -> transition to review / manual / failure
 *
 * THE TWO REVALIDATIONS AFTER THE NETWORK CALL ARE THE POINT. A response can
 * arrive after the user has switched accounts, signed out and back in, rejected
 * the candidate, or let it expire. `AbortController` reduces wasted work but it
 * does NOT replace epoch validation: an abort races the response, and a request
 * that completed a millisecond before the abort landed would otherwise write
 * classification metadata into a different actor's store.
 *
 * BACKOFF WITHOUT A TIMER SUBSYSTEM: automatic retry eligibility is computed from
 * `lastAttemptAt` plus an exponential, bounded-jitter delay, and the queue runner
 * SKIPS a candidate whose backoff has not elapsed. There is deliberately no
 * background scheduler — a persistent timer service is its own subsystem with its
 * own lifecycle, and the queue is already re-run on screen focus, on reconnect and
 * on manual retry.
 */

import { Platform } from 'react-native';
import { isActorRequestCurrent } from './actorContext';
import { compressForUpload } from './imageUtils';
import { identifyScanImage } from './scanIdentification';
import { prepareFashionEvidence } from './fashionEvidenceGateway';
import {
  buildClosetV2Request,
  validateClosetV2Request,
  validateClosetV2Response,
  resolveClassificationOutcome,
  classifyClosetTransportFailure,
  closetEntryPathKeyForSource,
  createEvidenceId,
} from './closetIdentificationV2';
import {
  getClosetCandidate,
  listClosetCandidates,
  transitionClosetCandidate,
} from './closetCandidateLibrary';
import {
  CLOSET_CANDIDATE_MAX_AUTOMATIC_RETRIES,
  CLOSET_CANDIDATE_MAX_TOTAL_ATTEMPTS,
  CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS,
} from '../types/closetCandidate';
import { isAutomaticallyRetryable } from './closetCandidateErrors';
import {
  isClosetOnline,
  noteClosetNetworkFailure,
  noteClosetNetworkSuccess,
  refreshClosetConnectivity,
} from './closetConnectivity';
import { emitClosetCandidateEvent } from './closetTelemetry';

/** Exponential backoff base and ceiling for automatic retries. */
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;

/**
 * In-flight controllers, keyed by candidateId.
 *
 * Module-scoped rather than React state on purpose, mirroring services/actorContext.js:
 * an unmounted hook still has to be able to abort what it started, and the store
 * has to be cancellable without a React tree.
 */
const inFlight = new Map();

// ── Backoff ──────────────────────────────────────────────────────────────────

/**
 * Exponential backoff with BOUNDED jitter.
 *
 * The jitter is the load-bearing part on reconnect: several candidates become
 * eligible at the same instant, and identical delays would send them at the same
 * instant too. Jitter is +/-25% rather than full-range so the ordering intent of
 * the exponent survives.
 */
export function retryBackoffMs(automaticRetryCount, random = Math.random) {
  const attempt = Math.max(0, Math.floor(automaticRetryCount ?? 0));
  const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jitter = base * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * True when a candidate's automatic backoff has elapsed.
 *
 * Keyed on `attemptCount`, not `automaticRetryCount`. A candidate that has NEVER
 * been attempted starts immediately; every RE-attempt waits. Keying on the retry
 * counter would let the first retry — the one immediately after a failure, and
 * therefore the one most likely to hit the same fault — fire with no delay at all.
 * The DELAY is still derived from `automaticRetryCount`, so it grows per retry.
 */
export function isRetryEligible(candidate, nowMs, random = Math.random) {
  if (!candidate) return false;
  if ((candidate.attemptCount ?? 0) <= 0) return true;
  const last = Date.parse(candidate.lastAttemptAt ?? '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= retryBackoffMs(candidate.automaticRetryCount, random);
}

/** Automatic-attempt budget. Manual retry is governed separately. */
export function hasAutomaticBudget(candidate) {
  if (!candidate) return false;
  return (
    (candidate.automaticRetryCount ?? 0) < CLOSET_CANDIDATE_MAX_AUTOMATIC_RETRIES &&
    (candidate.attemptCount ?? 0) < CLOSET_CANDIDATE_MAX_TOTAL_ATTEMPTS
  );
}

// ── Cancellation ─────────────────────────────────────────────────────────────

/**
 * Abort in-flight classifications.
 *
 * Called on actor change, sign-out, owning-hook unmount, candidate rejection,
 * candidate expiry, and explicit cancellation. Aborting is an OPTIMIZATION —
 * every write path still revalidates actor and candidate state afterwards.
 */
export function cancelClosetClassification(candidateId) {
  const controller = inFlight.get(candidateId);
  if (!controller) return false;
  try {
    controller.abort();
  } catch {
    /* aborting an already-settled controller is not an error */
  }
  inFlight.delete(candidateId);
  return true;
}

export function cancelAllClosetClassifications() {
  let cancelled = 0;
  for (const candidateId of [...inFlight.keys()]) {
    if (cancelClosetClassification(candidateId)) cancelled += 1;
  }
  return cancelled;
}

export function inFlightClosetClassificationCount() {
  return inFlight.size;
}

// ── Single candidate ─────────────────────────────────────────────────────────

/**
 * Classify one candidate end to end.
 *
 * Returns a string-discriminated outcome so a caller can tell "did not run" from
 * "ran and failed" without inspecting a status field:
 *
 *   { kind: 'resolved',  status, errorCode }
 *   { kind: 'deferred',  errorCode }   parked, e.g. waiting_for_network
 *   { kind: 'skipped',   errorCode }   never started, nothing changed
 */
export async function classifyClosetCandidate(actorRequest, candidateId, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const attemptKind = options.attempt === 'manual' ? 'manual' : 'automatic';

  const loaded = await getClosetCandidate(actorRequest, candidateId, { nowMs });
  if (!loaded.ok) return { kind: 'skipped', errorCode: loaded.errorCode };
  const candidate = loaded.candidate;

  // Only these two statuses may begin a classification. Anything else means
  // another runner already took it, or the user resolved it.
  if (candidate.status !== 'queued' && candidate.status !== 'waiting_for_network') {
    return { kind: 'skipped', errorCode: 'candidate_invalid_transition' };
  }
  if (!isActorRequestCurrent(actorRequest)) {
    return { kind: 'skipped', errorCode: 'candidate_actor_stale' };
  }
  if (!candidate.candidateImageUri) {
    await transitionClosetCandidate(
      actorRequest,
      candidateId,
      { to: 'failed', errorCode: 'candidate_media_unreadable' },
      { nowMs },
    );
    return { kind: 'resolved', status: 'failed', errorCode: 'candidate_media_unreadable' };
  }

  // Network state BEFORE spending media preparation on a request that cannot go.
  if (!(await isClosetOnline())) {
    if (candidate.status !== 'waiting_for_network') {
      await transitionClosetCandidate(
        actorRequest,
        candidateId,
        { to: 'waiting_for_network', errorCode: 'candidate_offline' },
        { nowMs },
      );
      emitClosetCandidateEvent('closet_candidate_waiting_for_network', {
        errorCode: 'candidate_offline',
      });
    }
    return { kind: 'deferred', errorCode: 'candidate_offline' };
  }

  const started = await transitionClosetCandidate(
    actorRequest,
    candidateId,
    { to: 'classifying', attempt: attemptKind, errorCode: null },
    { nowMs },
  );
  if (!started.ok) return { kind: 'skipped', errorCode: started.errorCode };

  emitClosetCandidateEvent('closet_candidate_classification_started', {
    automatic: attemptKind === 'automatic',
    attemptBucket: String(Math.min(started.candidate.attemptCount ?? 1, 9)),
  });

  const controller = new AbortController();
  inFlight.set(candidateId, controller);
  const startedAtMs = options.startedAtMs ?? nowMs;

  let signal = { aborted: false, offline: false, httpStatus: null, contractErrorCode: null };
  let validated = null;

  try {
    // Resolve the entry path BEFORE spending any media work. `camera` and
    // `gallery` always resolve; anything else (e.g. a `mirror_extract`
    // candidate reaching this queue while Mirror staging's own flag is off,
    // which should never happen but is not this orchestrator's gate to trust)
    // has no backend-accepted entry path yet, and must fail closed rather than
    // silently classify itself as a `closet_gallery` request.
    const entryPathKey = closetEntryPathKeyForSource(candidate.sourceType);
    if (!entryPathKey) {
      return await settle(actorRequest, candidateId, nowMs, candidate, {
        errorCode: 'classification_contract_rejected',
      });
    }

    // Analysis derivative. Reuses the SAME preprocessing and payload bounds the
    // Scanner V2 path uses (services/scannerEvidenceGateway.ts -> compressForUpload,
    // 896px / q0.65 / base64). No new normalization constants are introduced, and
    // the candidate's own durable 1440px derivative is untouched.
    let preparedImage;
    try {
      preparedImage = await compressForUpload(candidate.candidateImageUri);
    } catch (error) {
      noteClosetNetworkFailure(error);
      return await settle(actorRequest, candidateId, nowMs, candidate, {
        errorCode: 'candidate_media_normalization_failed',
      });
    }

    const evidence = prepareFashionEvidence({
      preparedImage,
      source: candidate.sourceType === 'camera' ? 'camera' : 'gallery',
      evidenceId: createEvidenceId(),
    });
    if (!evidence) {
      return await settle(actorRequest, candidateId, nowMs, candidate, {
        errorCode: 'candidate_media_normalization_failed',
      });
    }

    const built = buildClosetV2Request({
      evidence,
      entryPath: entryPathKey,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      requestId: evidence.evidenceId,
      appVersion: options.appVersion,
    });
    if (built.kind !== 'ok' || !validateClosetV2Request(built.request)) {
      return await settle(actorRequest, candidateId, nowMs, candidate, {
        errorCode: 'classification_malformed_response',
      });
    }

    // The ONE Closet network call. `contractRequestV2` is what makes the V2
    // envelope the request body; there is no branch here that could send the
    // legacy shape, and therefore no branch that could shop.
    const response = await identifyScanImage(evidence.imageBase64, {
      contractRequestV2: built.request,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      signal = { ...signal, aborted: true };
      emitClosetCandidateEvent('closet_candidate_request_aborted', { aborted: true });
      return await settle(actorRequest, candidateId, nowMs, candidate, {
        errorCode: 'candidate_request_aborted',
      });
    }

    const envelope = response?.identificationV2;
    if (envelope !== undefined) {
      validated = validateClosetV2Response(envelope);
    }

    if (!validated || validated.kind !== 'ok') {
      signal = {
        aborted: false,
        offline: false,
        httpStatus: typeof response?.httpStatus === 'number' ? response.httpStatus : null,
        contractErrorCode:
          typeof response?.contractErrorCode === 'string' ? response.contractErrorCode : null,
        malformed: envelope !== undefined,
      };
      // A transport-level network failure carries no contract code and no status.
      // Treat it as an offline signal only when the connectivity port agrees.
      if (!signal.contractErrorCode && signal.httpStatus === null && !signal.malformed) {
        noteClosetNetworkFailure('network request failed');
        signal.offline = !(await isClosetOnline());
      }
      const errorCode = classifyClosetTransportFailure(signal);
      return await settle(actorRequest, candidateId, nowMs, candidate, { errorCode });
    }

    noteClosetNetworkSuccess();
    const outcome = resolveClassificationOutcome(validated.result);
    return await settle(actorRequest, candidateId, nowMs, candidate, {
      outcome,
      latencyMs: (options.finishedAtMs ?? Date.now()) - startedAtMs,
    });
  } catch (error) {
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    if (aborted) {
      return await settle(actorRequest, candidateId, nowMs, candidate, {
        errorCode: 'candidate_request_aborted',
      });
    }
    // A THROWN transport error goes through the same offline classification as a
    // RETURNED one. The shared transport normally returns rather than throws, but
    // the two paths must not disagree: a dropped connection that happens to throw
    // would otherwise fail the candidate permanently while the identical
    // connection drop that returns would correctly park it.
    noteClosetNetworkFailure(error);
    const offline = !(await isClosetOnline());
    return await settle(actorRequest, candidateId, nowMs, candidate, {
      errorCode: classifyClosetTransportFailure({ offline }),
    });
  } finally {
    // Only clear OUR controller: a later attempt may already own the slot.
    if (inFlight.get(candidateId) === controller) inFlight.delete(candidateId);
  }
}

/**
 * Persist the result of one attempt.
 *
 * THE REVALIDATION GATE. Every write below happens only after `isActorRequestCurrent`
 * passes again and after the store confirms the candidate is still the one we
 * started on and still in `classifying`. A late completion under a changed actor
 * writes NOTHING — not to the old actor's records and not to the new actor's.
 */
async function settle(actorRequest, candidateId, nowMs, startedFrom, result) {
  if (!isActorRequestCurrent(actorRequest)) {
    return { kind: 'skipped', errorCode: 'candidate_actor_stale' };
  }

  const reloaded = await getClosetCandidate(actorRequest, candidateId, { nowMs });
  if (!reloaded.ok) return { kind: 'skipped', errorCode: reloaded.errorCode };
  const current = reloaded.candidate;

  // Rejected, expired, retried, or otherwise moved on while we were in flight.
  if (current.status !== 'classifying') {
    return { kind: 'skipped', errorCode: 'candidate_invalid_transition' };
  }
  // Paranoid identity check: the store is keyed by candidateId, but a record
  // whose immutable media changed underneath us is not the record we classified.
  if (current.candidateImageUri !== startedFrom.candidateImageUri) {
    return { kind: 'skipped', errorCode: 'candidate_invalid_transition' };
  }

  if (result.outcome) {
    const { status, errorCode, classification } = result.outcome;
    const patch = classification
      ? {
        category: classification.category,
        clothingType: classification.clothingType,
        subtype: classification.subtype,
        brand: classification.brand,
        primaryColor: classification.primaryColor,
        secondaryColors: classification.secondaryColors,
        material: classification.material,
        confidence: classification.confidence,
        classificationVersion: classification.classificationVersion,
      }
      : {};
    const written = await transitionClosetCandidate(
      actorRequest,
      candidateId,
      { to: status, errorCode, patch },
      { nowMs },
    );
    if (!written.ok) return { kind: 'skipped', errorCode: written.errorCode };

    if (status === 'ready_for_review') {
      emitClosetCandidateEvent('closet_candidate_classified', {
        status,
        candidateCountBucket: classification ? String(Math.min(classification.candidateCount, 9)) : null,
      });
    } else if (status === 'needs_manual_classification') {
      emitClosetCandidateEvent('closet_candidate_manual_classification_required', {
        status,
        errorCode,
      });
    } else {
      emitClosetCandidateEvent('closet_candidate_classification_failed', { status, errorCode });
    }
    return { kind: 'resolved', status, errorCode };
  }

  const errorCode = result.errorCode;

  // Offline is a PARK, not a failure: the work is still wanted, just not now.
  if (errorCode === 'candidate_offline') {
    await transitionClosetCandidate(
      actorRequest,
      candidateId,
      { to: 'waiting_for_network', errorCode },
      { nowMs },
    );
    emitClosetCandidateEvent('closet_candidate_waiting_for_network', { errorCode });
    return { kind: 'deferred', errorCode };
  }

  // An abort returns the candidate to a PRISTINE `queued` state — no error code.
  //
  // Nothing about the candidate is wrong: the user navigated away, switched
  // actors, or cancelled. Leaving `candidate_request_aborted` on the record would
  // be worse than useless, because the queue skips any candidate whose error is
  // not automatically retryable — so navigating away mid-classification would
  // strand the candidate in `queued` forever, with no retry affordance, looking
  // like it was simply never picked up.
  if (errorCode === 'candidate_request_aborted') {
    await transitionClosetCandidate(
      actorRequest,
      candidateId,
      { to: 'queued', errorCode: null },
      { nowMs },
    );
    emitClosetCandidateEvent('closet_candidate_request_aborted', { aborted: true, errorCode });
    return { kind: 'deferred', errorCode };
  }

  await transitionClosetCandidate(actorRequest, candidateId, { to: 'failed', errorCode }, { nowMs });
  emitClosetCandidateEvent('closet_candidate_classification_failed', {
    status: 'failed',
    errorCode,
  });
  return { kind: 'resolved', status: 'failed', errorCode };
}

// ── Queue runner ─────────────────────────────────────────────────────────────

/**
 * Drive pending candidates, at most
 * CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS at a time.
 *
 * Build 1 only creates one candidate at a time, but the scheduler is written for
 * batches now rather than retrofitted later: the concurrency cap, the backoff
 * skip and the no-stampede reconnect behaviour are all properties of the runner,
 * and adding them after a batch UI exists means changing the thing under test.
 *
 * NO RECONNECT STAMPEDE: `waiting_for_network` candidates enter the same bounded
 * pool as everything else, so a reconnect starts at most two requests no matter
 * how many were parked.
 */
export async function runClosetCandidateQueue(actorRequest, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(
    1,
    Math.min(
      options.maxConcurrent ?? CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS,
      CLOSET_CANDIDATE_MAX_CONCURRENT_CLASSIFICATIONS,
    ),
  );

  const listed = await listClosetCandidates(actorRequest, { nowMs });
  if (!listed.ok) return { ok: false, errorCode: listed.errorCode, started: 0 };

  const waiting = listed.candidates.filter(
    (candidate) =>
      (candidate.status === 'queued' || candidate.status === 'waiting_for_network') &&
      !inFlight.has(candidate.candidateId),
  );

  /**
   * PERMANENTLY ineligible for automatic work — as distinct from merely inside a
   * backoff window.
   *
   * Either the automatic budget is spent, or the last failure is one that
   * retrying cannot fix (re-running it would spend an identification unit on an
   * outcome that is already determined).
   */
  const isPermanentlyIneligible = (candidate) =>
    !hasAutomaticBudget(candidate) ||
    (candidate.errorCode && !isAutomaticallyRetryable(candidate.errorCode));

  /**
   * Move permanently-ineligible pending candidates to `failed`.
   *
   * WITHOUT THIS THEY STRAND. A candidate the runner will never pick up again is
   * still displayed as `queued` — "Waiting to start" — and `queued` offers no
   * retry affordance, because `queued -> queued` is a self-transition the state
   * machine rejects. So the user would watch something wait forever with no way
   * to act on it. `failed` is the honest state: it carries the real reason and it
   * is the one state a manual retry can legally leave.
   */
  for (const candidate of waiting) {
    if (!isPermanentlyIneligible(candidate)) continue;
    await transitionClosetCandidate(
      actorRequest,
      candidate.candidateId,
      {
        to: 'failed',
        errorCode: candidate.errorCode ?? 'classification_provider_failed',
      },
      { nowMs },
    );
  }

  const pending = waiting.filter(
    (candidate) =>
      !isPermanentlyIneligible(candidate) && isRetryEligible(candidate, nowMs, options.random),
  );

  // Oldest first: a candidate that has waited longest is the one the user is most
  // likely still expecting.
  pending.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  const slots = Math.max(0, limit - inFlight.size);
  const batch = pending.slice(0, slots);
  const results = await Promise.all(
    batch.map((candidate) =>
      classifyClosetCandidate(actorRequest, candidate.candidateId, {
        nowMs,
        attempt: 'automatic',
        appVersion: options.appVersion,
      }).catch(() => ({ kind: 'skipped', errorCode: 'classification_provider_failed' })),
    ),
  );

  return { ok: true, started: batch.length, results };
}

/**
 * Reconnect entry point. Refreshes the connectivity belief, then runs ONE bounded
 * pass. Deliberately not a loop: a caller that wants more calls it again, which
 * keeps the "no stampede" property in one place rather than in a retry loop.
 */
export async function requeueClosetCandidatesOnReconnect(actorRequest, options = {}) {
  refreshClosetConnectivity();
  return runClosetCandidateQueue(actorRequest, options);
}

/** Test seam only. Not used by production code. */
export const __closetClassificationInternals = {
  inFlight,
  settle,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
};
