// K+ Packing Intelligence V1 — request orchestration.
//
// Every dependency is INJECTED (entitlement check, Closet query, Signature
// Style resolver, weather resolver, quota reservation, provider call). That is
// what lets the whole Packing loop -- gate, retrieval, narrowing, prompt,
// validation, fallback -- be exercised deterministically from a test with no
// Supabase, no network and no provider, the same discipline
// privateDressingRoomEliseHandler.ts follows.
//
// ORDER IS LOAD-BEARING:
//   K+ gate -> retrieval -> readiness -> narrowing -> quota reservation ->
//   provider
// The entitlement check runs before any Closet read, the readiness check runs
// before any provider call, and the daily quota is reserved LAST -- only once
// every other gate has passed and a generation is actually about to happen.
// So a lapsed subscriber never reaches the wardrobe, a sparse Closet never
// costs a generation, AND an entitled caller with a sparse Closet is never
// charged for a plan that was never going to be built (PACK-05).
//
// `hasActiveKPlus` is called EXACTLY ONCE, here, by this gate, and the answer
// is never cached or reused elsewhere. A caller that memoizes this across a
// request and reuses the cached answer for anything downstream reintroduces a
// window where a lapsed entitlement is read as still active (PACK-06) --
// there must be exactly one source of truth for "is this caller entitled",
// asked at exactly one moment, immediately before it is acted on.

import {
  PACKING_CONTRACT_VERSION,
  PACKING_LIMITS,
  type ParsedPackingRequest,
} from './packingContract.ts';
import {
  retrievePackingClosetCandidates,
  type PackingClosetDataSource,
} from './packingRetrieval.ts';
import { selectPackingCandidates } from './packingCandidates.ts';
import { derivePackingGaps } from './packingGaps.ts';
import {
  PACKING_PROMPT_VERSION,
  PACKING_SYSTEM_PROMPT,
  buildPackingUserPrompt,
  type PackingWeatherPromptContext,
} from './packingPrompt.ts';
import {
  inspectPackingPlan,
  renderPackingPlanMessage,
  validatePackingModelOutput,
  type PackingPlan,
  type PackingPlanWeather,
} from './packingValidation.ts';
import {
  buildGeneralPackingGuide,
  renderGeneralModeMessage,
  type PackingGeneralGuide,
} from './packingGeneralMode.ts';

export type PackingStatus =
  | 'success'
  | 'general_mode'
  | 'not_entitled'
  | 'no_result'
  | 'error';

export interface PackingResponseBody {
  status: PackingStatus;
  contractVersion: typeof PACKING_CONTRACT_VERSION;
  requestId: string;
  message: string;
  plan: PackingPlan | null;
  generalGuide: PackingGeneralGuide | null;
  errorCode?: string;
}

/**
 * Content-free by construction. Nothing here can carry a destination, a date, a
 * garment name, a brand, a note, a prompt or a user id -- only shapes, counts
 * and buckets. Mirrors the discipline of EliseAdviceTelemetry.
 */
export interface PackingTelemetry {
  event: 'packing_generated' | 'packing_general_fallback' | 'packing_failed' | 'packing_not_entitled';
  tripLengthBucket: '1' | '2-3' | '4-7' | '8-14' | '15+';
  activityCount: number;
  hasConstraints: boolean;
  candidateCount: number;
  usableCandidateCount: number;
  shortlistCount: number;
  uncoveredRoleCount: number;
  /** False when retrieval was truncated, so no absence claim was permitted. */
  censusComplete: boolean;
  packedItemCount: number;
  outfitCount: number;
  gapCount: number;
  revisionCount: number;
  weatherProvenance: PackingPlanWeather['provenance'];
  signatureStyleApplied: boolean;
  modelItemRefs: number;
  rejectedItemRefs: number;
  constraintViolationsDropped: number;
  promptChars: number;
  retrievalLatencyMs: number;
  selectionLatencyMs: number;
  providerLatencyMs: number;
  totalLatencyMs: number;
  latencyBucket: 'fast' | 'normal' | 'slow' | 'very_slow';
  failureClass: string | null;
  promptVersion: string;
}

export interface PackingHandlerResult {
  httpStatus: number;
  body: PackingResponseBody;
  telemetry: PackingTelemetry;
  /** True when a generation was actually spent with the provider. */
  providerInvoked: boolean;
}

/**
 * Outcome of reserving one unit of the shared Elise daily budget. A tri-state
 * rather than a boolean so a caller cannot conflate "the RPC told us no" with
 * "we could not ask the RPC" -- both must block the provider, but they are
 * different failures with different messages (PACK-05).
 */
export type PackingQuotaReservation =
  | { status: 'reserved' }
  | { status: 'limit_reached' }
  | { status: 'check_failed' };

export interface PackingHandlerDeps {
  request: ParsedPackingRequest;
  requestId: string;
  actorId: string;
  /**
   * Resolved from has_active_k_plus(), never from a client flag. Called
   * EXACTLY ONCE by this handler's own gate -- see the file header.
   */
  hasActiveKPlus: () => Promise<boolean>;
  closet: PackingClosetDataSource;
  /**
   * Bounded Signature Style guidance, or null. Advisory only.
   *
   * LAZY, AND CALLED ONLY AFTER THE K+ GATE HAS PASSED. Signature Style is
   * only ever useful right before a prompt is built, so there is no reason to
   * resolve it any earlier -- and resolving it eagerly, before entitlement is
   * known, is exactly the shape of mistake that made PACK-06 possible
   * (something computed from an answer that might not still be true). A
   * caller with no Signature Style authority to offer may omit this entirely.
   */
  resolveSignatureStyleBlock?: () => Promise<string | null>;
  /** B2M passes nothing; B3 injects the resolver. Absent means UNAVAILABLE. */
  resolveWeather?: () => Promise<PackingWeatherPromptContext | null>;
  /**
   * Reserves ONE unit of the shared Elise daily budget. Called EXACTLY ONCE,
   * and only immediately before `callProvider` -- after K+, Closet retrieval
   * and readiness have all already passed. A caller must never be charged for
   * a generation that general mode, an unentitled 403, or any earlier gate
   * was always going to produce instead (PACK-05).
   */
  reserveDailyGeneration: () => Promise<PackingQuotaReservation>;
  /** Returns already-parsed JSON from the provider, or throws. */
  callProvider: (systemText: string, userText: string) => Promise<unknown>;
  /** Injected so the pure path stays deterministic in tests. */
  now?: () => number;
  makePlanId?: () => string;
}

function tripLengthBucket(nights: number): PackingTelemetry['tripLengthBucket'] {
  if (nights <= 1) return '1';
  if (nights <= 3) return '2-3';
  if (nights <= 7) return '4-7';
  if (nights <= 14) return '8-14';
  return '15+';
}

function latencyBucket(ms: number): PackingTelemetry['latencyBucket'] {
  if (ms < 2_000) return 'fast';
  if (ms < 6_000) return 'normal';
  if (ms < 15_000) return 'slow';
  return 'very_slow';
}

const UNAVAILABLE_WEATHER: PackingPlanWeather = { provenance: 'UNAVAILABLE', summary: null };

export async function handlePackingRequest(deps: PackingHandlerDeps): Promise<PackingHandlerResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const { trip, constraints } = deps.request;

  const baseTelemetry = (): PackingTelemetry => ({
    event: 'packing_failed',
    tripLengthBucket: tripLengthBucket(trip.nights),
    activityCount: trip.activities.length,
    hasConstraints:
      constraints.packLight || constraints.notes.length > 0 || constraints.excludeItemIds.length > 0,
    candidateCount: 0,
    usableCandidateCount: 0,
    shortlistCount: 0,
    uncoveredRoleCount: 0,
    censusComplete: true,
    packedItemCount: 0,
    outfitCount: 0,
    gapCount: 0,
    // Every excluded item and every constraint note is one prior refinement,
    // which is the only revision signal available without storing trip history.
    revisionCount: constraints.notes.length + (constraints.excludeItemIds.length > 0 ? 1 : 0),
    weatherProvenance: 'UNAVAILABLE',
    signatureStyleApplied: false,
    modelItemRefs: 0,
    rejectedItemRefs: 0,
    constraintViolationsDropped: 0,
    promptChars: 0,
    retrievalLatencyMs: 0,
    selectionLatencyMs: 0,
    providerLatencyMs: 0,
    totalLatencyMs: 0,
    latencyBucket: 'fast',
    failureClass: null,
    promptVersion: PACKING_PROMPT_VERSION,
  });

  const finish = (
    httpStatus: number,
    body: PackingResponseBody,
    telemetry: PackingTelemetry,
    providerInvoked: boolean,
  ): PackingHandlerResult => {
    telemetry.totalLatencyMs = now() - startedAt;
    telemetry.latencyBucket = latencyBucket(telemetry.totalLatencyMs);
    return { httpStatus, body, telemetry, providerInvoked };
  };

  // ── 1. K+ gate, server-side, before any Closet read ───────────────────────
  // Fails closed: an error resolving the entitlement is not premium access.
  let entitled = false;
  try {
    entitled = await deps.hasActiveKPlus();
  } catch {
    entitled = false;
  }
  if (!entitled) {
    const telemetry = baseTelemetry();
    telemetry.event = 'packing_not_entitled';
    telemetry.failureClass = 'not_entitled';
    return finish(
      403,
      {
        status: 'not_entitled',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: 'Packing plans are part of K+.',
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_REQUIRES_KPLUS',
      },
      telemetry,
      false,
    );
  }

  // ── 2. Authoritative Closet retrieval ─────────────────────────────────────
  const retrieval = await retrievePackingClosetCandidates({
    actorId: deps.actorId,
    data: deps.closet,
    limit: PACKING_LIMITS.maxClosetCandidates,
  });

  const telemetry = baseTelemetry();
  telemetry.candidateCount = retrieval.candidates.length;
  telemetry.retrievalLatencyMs = retrieval.retrievalLatencyMs;
  telemetry.censusComplete = retrieval.censusComplete;

  if (retrieval.failed) {
    // A Closet we could not read is not an empty Closet, and must never be
    // presented as one. The general guide is offered instead of a plan that
    // would silently omit everything the traveller owns.
    telemetry.event = 'packing_general_fallback';
    telemetry.failureClass = 'closet_unavailable';
    return finish(
      200,
      {
        status: 'general_mode',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: renderGeneralModeMessage(trip, 'closet_unavailable'),
        plan: null,
        generalGuide: buildGeneralPackingGuide(trip),
      },
      telemetry,
      false,
    );
  }

  // ── 3. Deterministic narrowing ────────────────────────────────────────────
  const selectionStartedAt = now();
  const selection = selectPackingCandidates({
    candidates: retrieval.candidates,
    trip,
    constraints,
  });
  telemetry.selectionLatencyMs = now() - selectionStartedAt;
  telemetry.usableCandidateCount = selection.usableCount;
  telemetry.shortlistCount = selection.shortlist.length;
  telemetry.uncoveredRoleCount = selection.uncoveredRoles.length;

  // ── 4. Closet readiness, BEFORE the provider is reached ───────────────────
  if (!selection.personalPlanPossible || selection.shortlist.length === 0) {
    telemetry.event = 'packing_general_fallback';
    telemetry.failureClass = 'sparse_closet';
    return finish(
      200,
      {
        status: 'general_mode',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: renderGeneralModeMessage(trip, 'sparse_closet'),
        plan: null,
        generalGuide: buildGeneralPackingGuide(trip),
      },
      telemetry,
      false,
    );
  }

  // ── 5. Weather (enrichment; absence is normal, never an error) ────────────
  let weatherPrompt: PackingWeatherPromptContext | null = null;
  if (deps.resolveWeather) {
    try {
      weatherPrompt = await deps.resolveWeather();
    } catch {
      weatherPrompt = null;
    }
  }
  const weather: PackingPlanWeather = weatherPrompt
    ? { provenance: weatherPrompt.provenance, summary: weatherPrompt.summary }
    : UNAVAILABLE_WEATHER;
  telemetry.weatherProvenance = weather.provenance;

  // ── 5b. Signature Style (enrichment; resolved only now, past the K+ gate) ─
  // Advisory and best-effort, exactly like weather: a failure here is never a
  // Packing failure, the block is simply absent.
  let signatureStyleBlock: string | null = null;
  if (deps.resolveSignatureStyleBlock) {
    try {
      signatureStyleBlock = await deps.resolveSignatureStyleBlock();
    } catch {
      signatureStyleBlock = null;
    }
  }
  telemetry.signatureStyleApplied = Boolean(signatureStyleBlock);

  // ── 6. Bounded fashion reasoning ──────────────────────────────────────────
  const userPrompt = buildPackingUserPrompt({
    trip,
    constraints,
    shortlist: selection.shortlist,
    weather: weatherPrompt,
    signatureStyleBlock,
  });
  telemetry.promptChars = PACKING_SYSTEM_PROMPT.length + userPrompt.length;

  // ── 6b. Daily quota reservation — LAST, because everything above this line
  // can still end in general mode or a 403 at ZERO cost to the caller's
  // budget. Only from this point on is a generation actually about to happen
  // (PACK-05). Weather and Signature Style are enrichment: resolving them
  // above this line, before we know whether a model call will occur, is safe
  // because neither one spends anything from the caller's own budget.
  const reservation = await deps.reserveDailyGeneration();
  if (reservation.status === 'limit_reached') {
    telemetry.event = 'packing_failed';
    telemetry.failureClass = 'quota_limit_reached';
    return finish(
      200,
      {
        status: 'error',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: "You've used today's Elise generations. Your packing plan will be here tomorrow.",
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_LIMIT_REACHED',
      },
      telemetry,
      false,
    );
  }
  if (reservation.status === 'check_failed') {
    telemetry.event = 'packing_failed';
    telemetry.failureClass = 'quota_check_failed';
    return finish(
      500,
      {
        status: 'error',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: 'I could not check your daily usage just now. Please try again.',
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_USAGE_CHECK_FAILED',
      },
      telemetry,
      false,
    );
  }

  // ── 7. Provider call ───────────────────────────────────────────────────
  const providerStartedAt = now();
  let rawOutput: unknown;
  try {
    rawOutput = await deps.callProvider(PACKING_SYSTEM_PROMPT, userPrompt);
  } catch (error) {
    telemetry.providerLatencyMs = now() - providerStartedAt;
    telemetry.event = 'packing_failed';
    telemetry.failureClass =
      error instanceof Error && error.message ? error.message.slice(0, 40) : 'provider_error';
    return finish(
      200,
      {
        status: 'error',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        // Retryable and honest. No partial plan, no invented items.
        message: 'I could not finish your packing plan just now. Your trip details are still here — try again.',
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_GENERATION_FAILED',
      },
      telemetry,
      true,
    );
  }
  telemetry.providerLatencyMs = now() - providerStartedAt;

  // ── 8. Post-model validation: the ownership gate ──────────────────────────
  const planId = deps.makePlanId ? deps.makePlanId() : `plan-${deps.requestId}`;
  // Gaps are derived from the CLOSET CENSUS and the forecast, before the
  // model's output is even looked at, so nothing the model says can create,
  // remove or reword one. A gap is an unmet requirement, never a suggestion.
  const gaps = derivePackingGaps({
    requiredRoles: selection.requiredRoles,
    closetRoleCensus: selection.closetRoleCensus,
    weather,
    // The census is only as complete as the retrieval that produced it.
    censusComplete: retrieval.censusComplete,
  });

  const validation = validatePackingModelOutput({
    raw: rawOutput,
    planId,
    shortlist: selection.shortlist,
    trip,
    constraints,
    weather,
    closetRoleCensus: selection.closetRoleCensus,
    censusComplete: retrieval.censusComplete,
    gaps,
  });
  telemetry.modelItemRefs = validation.telemetry.modelItemRefs;
  telemetry.rejectedItemRefs = validation.telemetry.rejectedItemRefs;
  telemetry.constraintViolationsDropped = validation.telemetry.constraintViolationsDropped;

  if (!validation.ok || !validation.plan) {
    telemetry.event = 'packing_failed';
    telemetry.failureClass = validation.failureReason ?? 'validation_failed';
    return finish(
      200,
      {
        status: 'no_result',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: "I couldn't build a plan from your Closet for this trip yet. Try again, or add a few more pieces to your Closet.",
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_NO_RESULT',
      },
      telemetry,
      true,
    );
  }

  // ── 9. Deterministic sanity check on the validated plan ───────────────────
  // Structural nonsense only. Fashion coherence stays the model's job.
  const problems = inspectPackingPlan(validation.plan);
  if (problems.length > 0) {
    telemetry.event = 'packing_failed';
    telemetry.failureClass = `sanity_${problems[0]}`.slice(0, 40);
    return finish(
      200,
      {
        status: 'no_result',
        contractVersion: PACKING_CONTRACT_VERSION,
        requestId: deps.requestId,
        message: "I couldn't build a plan from your Closet for this trip yet. Try again in a moment.",
        plan: null,
        generalGuide: null,
        errorCode: 'PACKING_NO_RESULT',
      },
      telemetry,
      true,
    );
  }

  telemetry.event = 'packing_generated';
  telemetry.packedItemCount = validation.plan.packedItems.length;
  telemetry.outfitCount = validation.plan.outfits.length;
  telemetry.gapCount = validation.plan.gaps.length;

  return finish(
    200,
    {
      status: 'success',
      contractVersion: PACKING_CONTRACT_VERSION,
      requestId: deps.requestId,
      message: renderPackingPlanMessage(validation.plan),
      plan: validation.plan,
      generalGuide: null,
    },
    telemetry,
    true,
  );
}

/** Metadata-only log line. Never contains trip, Closet or identity content. */
export function formatPackingLog(telemetry: PackingTelemetry): string {
  return [
    '[stylechat-generate] packing',
    `event=${telemetry.event}`,
    `tripLen=${telemetry.tripLengthBucket}`,
    `activities=${telemetry.activityCount}`,
    `candidates=${telemetry.candidateCount}`,
    `usable=${telemetry.usableCandidateCount}`,
    `shortlist=${telemetry.shortlistCount}`,
    `uncoveredRoles=${telemetry.uncoveredRoleCount}`,
    `censusComplete=${telemetry.censusComplete}`,
    `packed=${telemetry.packedItemCount}`,
    `outfits=${telemetry.outfitCount}`,
    `gaps=${telemetry.gapCount}`,
    `revisions=${telemetry.revisionCount}`,
    `weather=${telemetry.weatherProvenance}`,
    `signatureStyle=${telemetry.signatureStyleApplied}`,
    `modelRefs=${telemetry.modelItemRefs}`,
    `rejectedRefs=${telemetry.rejectedItemRefs}`,
    `constraintDrops=${telemetry.constraintViolationsDropped}`,
    `promptChars=${telemetry.promptChars}`,
    `retrievalMs=${telemetry.retrievalLatencyMs}`,
    `selectionMs=${telemetry.selectionLatencyMs}`,
    `providerMs=${telemetry.providerLatencyMs}`,
    `totalMs=${telemetry.totalLatencyMs}`,
    `latency=${telemetry.latencyBucket}`,
    `failure=${telemetry.failureClass ?? 'none'}`,
    `promptV=${telemetry.promptVersion}`,
  ].join(' ');
}
