/**
 * Build 5 — Today with Elise V1 orchestration.
 *
 * WHAT THIS FILE OWNS: turning actor-scoped Build 3 reads into ONE frozen
 * snapshot, handing that snapshot to the Phase 1 priority engine, and refusing
 * to commit a result the live actor no longer owns.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN, because Phase 1 already does:
 *   - which priority wins            → priorityEngine.evaluateTodayWithEliseCard
 *   - whether an item may be used    → eligibility.evaluateTodayOwnedLookEligibility
 *   - whether a result may commit    → actorInvalidation.canCommitTodayCardResult
 *   - what the card says             → copyTemplates.resolveTodayDeterministicCopy
 *   - what Build 4 confidence means  → build4ConfidenceAdapter
 * There is no second copy of any of them here, and no threshold invented.
 *
 * WHAT IT DOES NOT OWN, because Build 3 already does:
 *   - reading the Closet             → closetLibrary.loadClosetTyped
 *   - reading the private session    → privateDressingRoomSessionStore
 *   - reading the composition        → privateDressingRoomCompositionStore
 *   - reading Saved Looks            → privateSavedLookStore
 *   - COMPOSING AN OUTFIT            → privateDressingRoomComposer
 *
 * THE COMPOSER REUSE IS THE POINT, NOT A SHORTCUT. A Today card that showed a
 * Look assembled by its own rules would be lying the moment the user tapped it,
 * because the Dressing Room would then build a different outfit from the same
 * Closet. Today previews the outfit through the SAME deterministic composer the
 * Dressing Room runs, against the SAME context it will later hand off, so
 * "Tap to Get Ready" opens the Look the card showed. Nothing is persisted while
 * previewing: `composePrivateOutfits` is pure, and the synthetic context below
 * is never written to the session store.
 *
 * READS HAPPEN ONCE PER GENERATION. Every source is read exactly once in
 * `readTodaySources`, so a rerender cannot start a Closet read loop.
 */

import type {
  TodayWithEliseCardState,
  TodayWithEliseItemRef,
  TodayWithEliseSnapshot,
} from '../../types/todayWithElise';
import { evaluateTodayWithEliseCard } from './priorityEngine';
import {
  evaluateTodayOwnedLookEligibility,
  type TodayEligibleSlotCandidate,
  type TodayLookEligibilityOutcome,
} from './eligibility';
import {
  canCommitTodayCardResult,
  type TodayCardOrchestrationHandle,
} from './actorInvalidation';

/**
 * How old a private session may be and still be offered as "continue".
 *
 * Seven days, and stated once here rather than guessed per call site. Beyond
 * it, resuming a session the user has forgotten is not a useful recommendation,
 * so Today falls through to a Closet action instead of resurfacing stale work.
 */
export const TODAY_RECENT_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a captured snapshot may sit before evaluation refuses it.
 *
 * The snapshot is normally evaluated microseconds after capture; this bound
 * exists for the case where the app was suspended mid-generation and resumes
 * with reads that describe a Closet the user has since changed on another
 * surface. The priority engine performs the refusal (`stale`), not this file.
 */
export const TODAY_SNAPSHOT_MAX_SOURCE_AGE_MS = 5 * 60 * 1000;

/** The synthetic composer context id. NEVER persisted, never a real session. */
export const TODAY_PREVIEW_CONTEXT_ID = 'today_with_elise_preview';

// ── Source reads ─────────────────────────────────────────────────────────────

/** The typed Closet read outcome, as `loadClosetTyped` returns it. */
export type TodayClosetRead = {
  ok: boolean;
  items: unknown[];
  code?: string;
};

export type TodaySessionRead = {
  ok: boolean;
  session: {
    sessionId: string;
    actorId: string;
    status: string;
    anchorClosetItemId: string | null;
    occasion: string | null;
    updatedAt?: string;
    createdAt?: string;
  } | null;
} | null;

export type TodayCompositionRead = {
  ok: boolean;
  stale?: boolean;
  composition: {
    compositionId: string;
    activeLookId: string | null;
    inputFingerprint: string;
    looks: ReadonlyArray<{
      lookId: string;
      items: ReadonlyArray<{ slot: string; closetItemId: string }>;
    }>;
  } | null;
} | null;

export type TodaySavedLooksRead = {
  ok: boolean;
  looks: ReadonlyArray<{ id: string; sourceCompositionId: string }>;
} | null;

export type TodayCandidatesRead = {
  ok: boolean;
  candidates: ReadonlyArray<{ status?: string }>;
} | null;

export type TodaySourceReads = {
  closet: TodayClosetRead;
  session: TodaySessionRead;
  composition: TodayCompositionRead;
  savedLooks: TodaySavedLooksRead;
  candidates: TodayCandidatesRead;
};

export type TodayCapabilities = {
  todayWithEliseActive: boolean;
  privateDressingRoomActive: boolean;
  weatherActive: boolean;
  generatedGreetingActive: boolean;
  /** Candidate staging is what makes a Closet review queue reachable at all. */
  closetReviewActive: boolean;
};

/** Minimal projection shape this module needs. Mirrors ClosetItemProjection. */
export type TodayClosetProjection = {
  id: string;
  title: string;
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  primaryColor: string | null;
  secondaryColors: readonly string[];
  material: readonly string[];
  imageUri: string | null;
  thumbnailUri: string | null;
};

/** Build 3 collaborators, injected so the pure core is testable without I/O. */
export type TodayComposerCollaborators = {
  project: (items: unknown[]) => TodayClosetProjection[];
  classifySlot: (item: TodayClosetProjection) => { primarySlot: string | null };
  compose: (input: {
    session: {
      actorId: string | null;
      sessionId: string;
      status: string;
      anchorClosetItemId?: string | null;
      occasion?: string | null;
    };
    closet: { ok: boolean; items: unknown[] };
  }) => {
    code: string;
    looks: ReadonlyArray<{
      lookId: string;
      items: ReadonlyArray<{ slot: string; closetItemId: string }>;
    }>;
  };
};

// ── Deterministic helpers ────────────────────────────────────────────────────

function normalizeActor(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The local calendar day the recommendation belongs to.
 *
 * LOCAL, not UTC: "today" is the user's day, and a UTC key would roll the card
 * over in the middle of an evening for most of the world.
 */
export function todayDayKey(nowMs: number): string {
  const date = new Date(nowMs);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The session's most recent activity, or null when neither stamp is readable.
 *
 * A malformed timestamp is NOT treated as "just now": that would let a corrupt
 * record win the highest priority forever. Unreadable means unknown, and
 * unknown loses the recency test.
 */
export function sessionActivityMs(session: {
  updatedAt?: string;
  createdAt?: string;
}): number | null {
  const updated = parseTimestamp(session?.updatedAt);
  const created = parseTimestamp(session?.createdAt);
  if (updated === null && created === null) return null;
  if (updated === null) return created;
  if (created === null) return updated;
  return Math.max(updated, created);
}

function isRecent(activityMs: number | null, nowMs: number): boolean {
  if (activityMs === null) return false;
  // A future timestamp is a clock or corruption problem, not recent activity.
  if (activityMs > nowMs) return false;
  return nowMs - activityMs <= TODAY_RECENT_SESSION_MAX_AGE_MS;
}

/**
 * The deterministic Today anchor: the newest Closet garment with a usable slot.
 *
 * `loadClosetTyped` already returns newest-first, and this walks that order
 * without re-sorting, so the same Closet always yields the same anchor and the
 * same handed-off session context.
 */
export function pickTodayAnchor(
  projections: readonly TodayClosetProjection[],
  classifySlot: TodayComposerCollaborators['classifySlot'],
): TodayClosetProjection | null {
  for (const item of projections) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    if (classifySlot(item).primarySlot) return item;
  }
  return null;
}

/**
 * The composer context Today previews with AND hands off.
 *
 * ONE context, produced once, used twice. If these could diverge the card would
 * show an outfit the Dressing Room then refuses to build.
 */
export type TodayComposerContext = {
  anchorClosetItemId: string | null;
  occasion: string | null;
};

export function resolveTodayComposerContext(input: {
  session: TodaySessionRead;
  projections: readonly TodayClosetProjection[];
  classifySlot: TodayComposerCollaborators['classifySlot'];
}): TodayComposerContext | null {
  const record = input.session?.ok ? input.session.session : null;
  const sessionAnchor = normalizeActor(record?.anchorClosetItemId);
  // An anchor the Closet can no longer resolve is not usable context.
  const anchorStillOwned =
    sessionAnchor !== null && input.projections.some((item) => item.id === sessionAnchor);

  if (anchorStillOwned) {
    return { anchorClosetItemId: sessionAnchor, occasion: record?.occasion ?? null };
  }

  const picked = pickTodayAnchor(input.projections, input.classifySlot);
  if (!picked) return null;
  // A session with an occasion but no resolvable anchor keeps its occasion:
  // the user said what the day is for, and Today must not silently forget it.
  return {
    anchorClosetItemId: picked.id,
    occasion: record && !sessionAnchor ? record.occasion ?? null : null,
  };
}

// ── Owned-item Look preview ──────────────────────────────────────────────────

export type TodayOwnedLookPreview = {
  outcome: TodayLookEligibilityOutcome;
  context: TodayComposerContext;
  lookKey: string;
};

/**
 * Preview one owned-item Look for today.
 *
 * TWO INDEPENDENT GATES, in this order and never merged:
 *   1. Build 3's composer decides which garments go together.
 *   2. Phase 1's eligibility contract decides whether they may be shown.
 * Composition is a styling judgement; ownership approval is a truth claim. A
 * composer that liked a garment cannot approve it, and eligibility never
 * re-composes around what it rejected — a rejected slot becomes a MISSING slot,
 * which is exactly how a partial Look stays honest instead of being quietly
 * completed with something the user does not own.
 */
export function previewTodayOwnedLook(input: {
  actorId: string;
  closet: TodayClosetRead;
  projections: readonly TodayClosetProjection[];
  context: TodayComposerContext;
  collaborators: TodayComposerCollaborators;
  nowMs: number;
}): TodayOwnedLookPreview | null {
  if (!input.closet?.ok) return null;
  if (!input.context) return null;

  const composed = input.collaborators.compose({
    session: {
      actorId: input.actorId,
      sessionId: TODAY_PREVIEW_CONTEXT_ID,
      status: 'active',
      anchorClosetItemId: input.context.anchorClosetItemId,
      occasion: input.context.occasion,
    },
    closet: { ok: input.closet.ok, items: input.closet.items },
  });

  const look = composed?.looks?.[0] ?? null;
  if (!look || !Array.isArray(look.items) || look.items.length === 0) return null;

  const byId = new Map<string, TodayClosetProjection>();
  for (const item of input.projections) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }

  const candidates: TodayEligibleSlotCandidate[] = [];
  for (const entry of look.items) {
    const projection = byId.get(entry.closetItemId) ?? null;
    candidates.push({
      closetItemId: entry.closetItemId,
      slot: entry.slot as TodayEligibleSlotCandidate['slot'],
      // The projection intentionally carries no owner field. Scope is attested
      // by the actor-scoped load below, which is the Build 3 ownership rule.
      actorId: null,
      // A garment the actor-scoped Closet no longer resolves is a deleted
      // reference, never an unknown one to be optimistically accepted.
      ownership: projection ? 'exact_owned' : 'deleted_reference',
      category: projection?.category ?? null,
      clothingType: projection?.clothingType ?? null,
      subtype: projection?.subtype ?? null,
      primaryColor: projection?.primaryColor ?? null,
      secondaryColor: projection?.secondaryColors?.[0] ?? null,
      material: projection?.material?.[0] ?? null,
      // Build 4 confidence is absent in Build 5; the adapter reports `absent`
      // and eligibility continues on the Build 3 contract unchanged.
      build4Confidence: undefined,
    });
  }

  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: input.actorId,
    loadedForActorId: input.actorId,
    candidates,
    // Outerwear is a weather judgement, and weather is deferred in V1. Never
    // require a layer we have no basis to require.
    requireOuterwear: false,
  });

  if (outcome.status === 'ineligible') return null;

  return {
    outcome,
    context: input.context,
    lookKey: `today_${todayDayKey(input.nowMs)}_${input.context.anchorClosetItemId ?? 'none'}`,
  };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export type TodaySnapshotBuild = {
  snapshot: TodayWithEliseSnapshot;
  /** Retained for the handoff and for the presentation layer. Not analytics. */
  ownedLook: TodayOwnedLookPreview | null;
  projections: readonly TodayClosetProjection[];
};

/**
 * Build the frozen evaluation snapshot. PURE — every read has already happened.
 *
 * The five priority inputs are populated here and NOWHERE else, so the ranking
 * itself stays entirely inside the Phase 1 engine. Producing a null input is
 * how this file says "that priority does not apply"; it never says which one
 * wins.
 */
export function buildTodaySnapshot(input: {
  handle: TodayCardOrchestrationHandle;
  reads: TodaySourceReads;
  capabilities: TodayCapabilities;
  collaborators: TodayComposerCollaborators;
  nowMs: number;
}): TodaySnapshotBuild {
  const { reads, capabilities, collaborators, nowMs } = input;
  const actorId = normalizeActor(input.handle?.actorId);

  const closetOk = reads.closet?.ok === true;
  const projections = closetOk ? collaborators.project(reads.closet.items ?? []) : [];

  const base: TodayWithEliseSnapshot = {
    actorId,
    actorEpoch: input.handle?.actorEpoch ?? 0,
    generationToken: input.handle?.generationToken ?? 'invalid',
    evaluatedAtMs: nowMs,
    maxSourceAgeMs: TODAY_SNAPSHOT_MAX_SOURCE_AGE_MS,
    sourceCapturedAtMs: nowMs,
    unfinishedLook: null,
    todayOwnedLook: null,
    recentStyling: null,
    closetAction: null,
    onboarding: null,
    capabilities: {
      todayWithEliseActive: capabilities.todayWithEliseActive === true,
      privateDressingRoomActive: capabilities.privateDressingRoomActive === true,
      weatherActive: capabilities.weatherActive === true,
      generatedGreetingActive: capabilities.generatedGreetingActive === true,
    },
    malformed: false,
  };

  // No actor: the engine fails closed to `unauthorized`. Nothing else is read
  // into the snapshot, because nothing else has an owner to be true for.
  if (!actorId) return { snapshot: base, ownedLook: null, projections };

  /**
   * A source that reports a hard failure makes the recommendation untrustworthy.
   * The Closet is the only source Today cannot proceed without: session,
   * composition, Saved Look and candidate faults each remove one priority, and
   * the engine's own fall-through handles that safely.
   */
  if (!closetOk) {
    return { snapshot: { ...base, malformed: true }, ownedLook: null, projections };
  }

  const sessionRecord = reads.session?.ok ? reads.session.session : null;
  const activityMs = sessionRecord ? sessionActivityMs(sessionRecord) : null;
  const sessionUsable =
    sessionRecord !== null &&
    sessionRecord.status === 'active' &&
    normalizeActor(sessionRecord.actorId) === actorId &&
    isRecent(activityMs, nowMs);

  // ── 1. Recent unfinished Look ──────────────────────────────────────────────
  //
  // "Unfinished" is a fact about SAVED state, not about how the outfit looks: a
  // composition whose active Look has already been saved is finished, and
  // re-offering it as unfinished would be false.
  const composition = reads.composition?.ok ? reads.composition.composition : null;
  const compositionStale = reads.composition?.stale === true;
  const savedForComposition =
    composition && reads.savedLooks?.ok
      ? reads.savedLooks.looks.find(
          (look) => look?.sourceCompositionId === composition.compositionId,
        ) ?? null
      : null;

  let unfinished: TodayWithEliseSnapshot['unfinishedLook'] = null;
  if (sessionUsable && composition && !compositionStale && composition.activeLookId) {
    const activeLook =
      composition.looks.find((look) => look.lookId === composition.activeLookId) ?? null;
    if (activeLook && !savedForComposition) {
      unfinished = {
        sessionId: sessionRecord.sessionId,
        savedLookId: null,
        updatedAtMs: activityMs ?? nowMs,
        itemRefs: activeLook.items
          .filter((item) => projections.some((p) => p.id === item.closetItemId))
          .map((item) => ({
            closetItemId: item.closetItemId,
            slot: item.slot as TodayWithEliseItemRef['slot'],
          })),
      };
      // A Look whose every garment has left the Closet is not continuable.
      if (unfinished.itemRefs.length === 0) unfinished = null;
    }
  }

  // ── 2. Today's owned-item Look ─────────────────────────────────────────────
  const context = resolveTodayComposerContext({
    session: reads.session,
    projections,
    classifySlot: collaborators.classifySlot,
  });
  const ownedLook = context
    ? previewTodayOwnedLook({
        actorId,
        closet: reads.closet,
        projections,
        context,
        collaborators,
        nowMs,
      })
    : null;

  const todayOwnedLook: TodayWithEliseSnapshot['todayOwnedLook'] =
    ownedLook && ownedLook.outcome.status !== 'ineligible'
      ? {
          lookKey: ownedLook.lookKey,
          completeness: ownedLook.outcome.status,
          itemRefs: ownedLook.outcome.itemRefs,
          dayKey: todayDayKey(nowMs),
        }
      : null;

  // ── 3. Continue recent styling ─────────────────────────────────────────────
  const recentStyling: TodayWithEliseSnapshot['recentStyling'] = sessionUsable
    ? {
        sessionId: sessionRecord.sessionId,
        updatedAtMs: activityMs ?? nowMs,
        itemRefs: [],
      }
    : null;

  // ── 4. Closet action ───────────────────────────────────────────────────────
  //
  // A review queue is offered only when candidate staging is actually reachable;
  // otherwise the review screen is not a destination and the action would be
  // dead. Reaching here with a non-empty Closet and no usable Look means the
  // Closet needs more pieces, which is a Closet step, not onboarding.
  const pendingReview =
    capabilities.closetReviewActive && reads.candidates?.ok
      ? reads.candidates.candidates.filter(
          (candidate) => candidate?.status === 'ready_for_review',
        ).length
      : 0;

  let closetAction: TodayWithEliseSnapshot['closetAction'] = null;
  if (pendingReview > 0) {
    closetAction = { kind: 'review_queue', pendingCount: pendingReview };
  } else if (projections.length > 0) {
    closetAction = { kind: 'empty_prompt', pendingCount: 0 };
  }

  // ── 5. Onboarding ──────────────────────────────────────────────────────────
  const onboarding: TodayWithEliseSnapshot['onboarding'] = {
    closetItemCount: projections.length,
  };

  return {
    snapshot: {
      ...base,
      unfinishedLook: unfinished,
      todayOwnedLook,
      recentStyling,
      closetAction,
      onboarding,
    },
    ownedLook,
    projections,
  };
}

// ── Commit ───────────────────────────────────────────────────────────────────

export type TodayOrchestrationResult = {
  card: TodayWithEliseCardState;
  ownedLook: TodayOwnedLookPreview | null;
  projections: readonly TodayClosetProjection[];
  snapshot: TodayWithEliseSnapshot;
};

/**
 * Evaluate a built snapshot into a card state.
 *
 * Separated from `buildTodaySnapshot` so a test can prove the engine sees
 * exactly the snapshot this file constructed, with no post-processing in
 * between.
 */
export function evaluateTodaySnapshot(built: TodaySnapshotBuild): TodayOrchestrationResult {
  return {
    card: evaluateTodayWithEliseCard(built.snapshot),
    ownedLook: built.ownedLook,
    projections: built.projections,
    snapshot: built.snapshot,
  };
}

/**
 * The commit gate. Returns the result only when the live actor still owns it.
 *
 * BOTH checks are required and neither implies the other:
 *   - `canCommitTodayCardResult` proves the LIVE actor context still matches the
 *     handle the reads were started under (including the sign-out / sign-back-in
 *     cycle, which the epoch catches and the id alone does not).
 *   - the generation-token equality proves this particular evaluation is still
 *     the newest one, so a slow first generation cannot overwrite a fast second.
 */
export function commitTodayCardResult(input: {
  handle: TodayCardOrchestrationHandle;
  liveActorId: string | null;
  liveActorEpoch: number;
  actorRequestCurrent: boolean;
  currentGenerationToken: string;
  result: TodayOrchestrationResult;
}): TodayOrchestrationResult | null {
  if (!input.result || !input.result.card) return null;
  if (input.handle?.generationToken !== input.currentGenerationToken) return null;
  if (input.result.card.generationToken !== input.currentGenerationToken) return null;
  if (
    !canCommitTodayCardResult({
      handle: input.handle,
      liveActorId: input.liveActorId,
      liveActorEpoch: input.liveActorEpoch,
      actorRequestCurrent: input.actorRequestCurrent,
    })
  ) {
    return null;
  }
  // The engine stamps the card from the snapshot, and the snapshot from the
  // handle — but a card carrying a different actor than the live one must never
  // render, whatever produced it.
  const cardActor = normalizeActor(input.result.card.actorId);
  const liveActor = normalizeActor(input.liveActorId);
  if (cardActor === null || liveActor === null || cardActor !== liveActor) return null;
  return input.result;
}
