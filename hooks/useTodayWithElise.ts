/**
 * Build 5 — the Home-side driver for Today with Elise V1.
 *
 * A THIN SEQUENCER, matching hooks/usePrivateDressingRoom.ts. Every rule that
 * can be tested without a renderer lives in services/todayWithElise/**: the
 * priority engine, the eligibility contract, the snapshot builder, the commit
 * gate, the copy templates and the analytics sink. This file gathers React
 * state, performs each source read exactly once per generation, and publishes
 * one committed card.
 *
 * HOME IS NEVER BLOCKED. The hook returns immediately with `loading: true`; the
 * reads resolve afterwards and replace only the card's own body. No Home render
 * awaits this, and nothing here mutates any store — orchestration is read-only
 * by construction, so a Home visit can never write.
 *
 * ONE GENERATION = ONE SET OF READS. `generationRef` is claimed before the first
 * read and checked after every await, so a rerender cannot start a second
 * Closet read, and a slow first generation cannot overwrite a fast second.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  CLOSET_CANDIDATE_STAGING_ACTIVE,
  CLOSET_SEPARATION_V1,
  PRIVATE_DRESSING_ROOM_ELISE_ACTIVE,
  PRIVATE_DRESSING_ROOM_V1,
  TODAY_WITH_ELISE_ACTIVE,
  TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE,
  TODAY_WITH_ELISE_WEATHER_ACTIVE,
} from '../constants/featureFlags';
import {
  createActorRequest,
  getActorContext,
  isActorRequestCurrent,
} from '../services/actorContext';
import { loadClosetTyped } from '../services/closetLibrary';
import { getClosetItemProjections } from '../services/closetItemProjection';
import { classifyClosetItemSlot } from '../services/privateDressingRoomSlots';
import { composePrivateOutfits } from '../services/privateDressingRoomComposer';
import {
  loadActiveSession,
  startActiveSession,
} from '../services/privateDressingRoomSessionStore';
import {
  loadCompositionSet,
  setActiveLook,
} from '../services/privateDressingRoomCompositionStore';
import { composeAndPersistComposition } from '../services/privateDressingRoomLifecycle';
import { buildCompositionFingerprint } from '../services/privateDressingRoomCompositionSchema';
import { loadPrivateSavedLooks } from '../services/privateSavedLookStore';
import { listClosetCandidates } from '../services/closetCandidateLibrary';
import { beginTodayCardEvaluation } from '../services/todayWithElise/actorInvalidation';
import type { TodayCardOrchestrationHandle } from '../services/todayWithElise/actorInvalidation';
import {
  buildTodaySnapshot,
  commitTodayCardResult,
  compositionIdentityChanged,
  compositionIdentityFrom,
  evaluateTodaySnapshot,
  savedLookSessionIdsFrom,
  type TodayCapabilities,
  type TodayClosetProjection,
  type TodayOrchestrationResult,
  type TodaySourceReads,
} from '../services/todayWithElise/orchestrator';
import {
  missingSlotsFor,
  projectCapabilityGatedActions,
  projectPartialLookActions,
  projectTodayCard,
  resolveTodayRoute,
  type TodayCardPresentation,
} from '../services/todayWithElise/presentation';
import {
  openTodayClosetDestination,
  openTodayDressingRoom,
  openTodayEliseModification,
  type TodayHandoffDeps,
} from '../services/todayWithElise/handoff';
import { emitTodayWithEliseEvent } from '../services/todayWithElise/analytics';
import { todayEventPayload } from '../services/todayWithElise/reporting';
import type { TodayWithEliseCardState } from '../types/todayWithElise';

export type TodayWithEliseView = {
  /** True until the first generation commits. Card-level only, never Home. */
  loading: boolean;
  card: TodayWithEliseCardState | null;
  presentation: TodayCardPresentation | null;
  /** Missing slots for a partial Look, from the eligibility outcome. */
  missingSlots: readonly string[];
  /** Re-run one generation. Used by focus and by a completed handoff return. */
  revalidate: () => void;
  /** Internals the action layer needs. Never rendered. */
  handoffContext: {
    handle: TodayCardOrchestrationHandle | null;
    anchorClosetItemId: string | null;
    occasion: string | null;
    sessionId: string | null;
  };
  /** True while a handoff is in flight. Disables both controls. */
  busy: boolean;
  /** Bounded deterministic failure copy, or null. Never an exception message. */
  actionError: string | null;
  /** Undefined when the card offers no runnable action — never a dead control. */
  onPrimaryPress?: () => void;
  onSecondaryPress?: () => void;
  /**
   * Attach the card heading so a return from a Today-originated destination can
   * restore accessibility focus to a stable entry point.
   */
  registerHeading: (node: unknown) => void;
};

const IDLE: {
  actorKey: string | null;
  result: TodayOrchestrationResult | null;
  loading: boolean;
} = { actorKey: null, result: null, loading: true };

/**
 * The capability set the snapshot is evaluated against.
 *
 * READ FROM THE EXISTING BUILD 3 GATES, never re-derived. `PRIVATE_DRESSING_ROOM_V1`
 * is the workspace gate the Dressing Room route itself checks, so Today can
 * never believe the room is reachable when the route would refuse to render it.
 * Build 5 introduces no second availability test and no route-existence probe.
 */
export function currentTodayCapabilities(): TodayCapabilities {
  return {
    todayWithEliseActive: TODAY_WITH_ELISE_ACTIVE,
    privateDressingRoomActive: PRIVATE_DRESSING_ROOM_V1,
    weatherActive: TODAY_WITH_ELISE_WEATHER_ACTIVE,
    generatedGreetingActive: TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE,
    closetReviewActive: CLOSET_CANDIDATE_STAGING_ACTIVE,
  };
}

export const TODAY_CLOSET_SEPARATION_ACTIVE = CLOSET_SEPARATION_V1;

/**
 * Read every Today source exactly once.
 *
 * Ordering is deliberate: the Closet first, because a Closet that did not load
 * makes every other answer untrustworthy; the session next, because the
 * composition read needs its fingerprint; then the two independent reads. A
 * source that fails is reported as a failed read rather than as emptiness — the
 * snapshot builder decides what each failure removes.
 */
export async function readTodaySources(
  actorId: string,
  actorRequest: unknown,
  options: { closetReviewActive: boolean },
): Promise<TodaySourceReads> {
  const closet = await loadClosetTyped(actorId, { actorRequest });

  let session: TodaySourceReads['session'] = null;
  try {
    session = (await loadActiveSession(actorRequest)) as TodaySourceReads['session'];
  } catch {
    session = null;
  }

  let composition: TodaySourceReads['composition'] = null;
  const record = session?.ok ? session.session : null;
  if (record) {
    try {
      composition = (await loadCompositionSet(
        actorRequest,
        buildCompositionFingerprint({
          actorId: record.actorId,
          sessionId: record.sessionId,
          status: record.status,
          anchorClosetItemId: record.anchorClosetItemId,
          occasion: record.occasion,
        }),
      )) as TodaySourceReads['composition'];
    } catch {
      composition = null;
    }
  }

  let savedLooks: TodaySourceReads['savedLooks'] = null;
  try {
    // Read regardless of the Saved Looks flag: once a record exists on disk it
    // is plain versioned JSON, and interpreting it must not depend on the flag
    // still being on. This read never writes.
    savedLooks = (await loadPrivateSavedLooks(actorRequest)) as TodaySourceReads['savedLooks'];
  } catch {
    savedLooks = null;
  }

  let candidates: TodaySourceReads['candidates'] = null;
  if (options.closetReviewActive) {
    try {
      candidates = (await listClosetCandidates(actorRequest)) as TodaySourceReads['candidates'];
    } catch {
      candidates = null;
    }
  }

  return { closet, session, composition, savedLooks, candidates };
}

/**
 * The Build 3 collaborators, bound once.
 *
 * Named rather than inlined so the orchestrator's injection points stay visible:
 * every one of these is an existing certified module, and Build 5 supplies no
 * substitute implementation of any of them.
 */
const TODAY_COLLABORATORS = {
  project: (items: unknown[]) =>
    getClosetItemProjections(
      items as Array<Record<string, unknown> | null | undefined>,
    ) as unknown as TodayClosetProjection[],
  classifySlot: (item: TodayClosetProjection) =>
    classifyClosetItemSlot(item as never) as { primarySlot: string | null },
  compose: composePrivateOutfits as never,
};

/**
 * The handoff's Build 3 bindings, resolved once.
 *
 * Every entry is an existing certified module. Build 5 supplies no alternative
 * session creator, composer, persister or reader — it only sequences them.
 */
const TODAY_HANDOFF_DEPS: TodayHandoffDeps = {
  startSession: (actorRequest, input) =>
    startActiveSession(actorRequest, input) as never,
  loadCloset: (actorId, options) => loadClosetTyped(actorId, options) as never,
  project: (items) =>
    getClosetItemProjections(
      items as Array<Record<string, unknown> | null | undefined>,
    ) as never,
  composeAndPersist: (input) => composeAndPersistComposition(input as never) as never,
  setActiveLook: (actorRequest, input) => setActiveLook(actorRequest, input) as never,
  loadComposition: (actorRequest, fingerprint) =>
    loadCompositionSet(actorRequest, fingerprint) as never,
  fingerprintFor: (session) => {
    const record = session as {
      actorId: string;
      sessionId: string;
      status: string;
      anchorClosetItemId: string | null;
      occasion: string | null;
    };
    return buildCompositionFingerprint({
      actorId: record.actorId,
      sessionId: record.sessionId,
      status: record.status,
      anchorClosetItemId: record.anchorClosetItemId,
      occasion: record.occasion,
    });
  },
  createActorRequest,
  isActorRequestCurrent,
  liveActor: () => {
    const context = getActorContext();
    return { actorId: context.actorId, epoch: context.epoch };
  },
  navigate: (route) => router.push(route as never),
  emit: (event, payload) => emitTodayWithEliseEvent(event, payload),
  now: () => Date.now(),
};

export function useTodayWithElise(): TodayWithEliseView {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';

  const [state, setState] = useState(IDLE);
  const generationRef = useRef(0);
  const handleRef = useRef<TodayCardOrchestrationHandle | null>(null);

  /**
   * An actor transition invalidates every pending and resolved generation.
   *
   * DECLARED BEFORE `useFocusEffect(orchestrate)`, AND THE ORDER IS LOAD-BEARING
   * — the same ordering the private Dressing Room hook documents. React runs
   * effects in declaration order, so on the single commit where auth resolves
   * and `actorKey` and `orchestrate` change together, this must invalidate the
   * OLD actor's work before the new generation claims its token. With the
   * opposite order the new generation is claimed first and immediately bumped
   * past, so its own commit is permanently refused and the card never leaves
   * its loading state.
   */
  useEffect(() => {
    generationRef.current += 1;
    handleRef.current = null;
    setState(IDLE);
  }, [actorKey]);

  const orchestrate = useCallback(() => {
    if (!TODAY_WITH_ELISE_ACTIVE) return undefined;
    if (actorLoading) return undefined;

    const generation = ++generationRef.current;
    let live = true;

    // Signed out is a terminal, correct answer, not a pending one: the engine
    // fails closed to `unauthorized` and no store is read for an actor that
    // does not exist.
    if (!actorId) {
      const handle = beginTodayCardEvaluation({
        actorId: null,
        actorEpoch: getActorContext().epoch,
      });
      handleRef.current = handle;
      const built = buildTodaySnapshot({
        handle,
        reads: {
          closet: { ok: false, items: [] },
          session: null,
          composition: null,
          savedLooks: null,
          candidates: null,
        },
        capabilities: currentTodayCapabilities(),
        collaborators: TODAY_COLLABORATORS,
        nowMs: Date.now(),
      });
      setState({ actorKey, result: evaluateTodaySnapshot(built, []), loading: false });
      return () => {
        live = false;
      };
    }

    const capabilities = currentTodayCapabilities();
    const actorRequest = createActorRequest();
    const handle = beginTodayCardEvaluation({
      actorId,
      actorEpoch: getActorContext().epoch,
    });
    handleRef.current = handle;

    setState((previous) =>
      previous.actorKey === actorKey && previous.result
        ? previous
        : { actorKey, result: null, loading: true },
    );

    void (async () => {
      let reads: TodaySourceReads;
      try {
        reads = await readTodaySources(actorId, actorRequest, {
          closetReviewActive: capabilities.closetReviewActive,
        });
      } catch {
        // A thrown read is a failed read, never an empty Closet.
        reads = {
          closet: { ok: false, items: [] },
          session: null,
          composition: null,
          savedLooks: null,
          candidates: null,
        };
      }

      if (!live || generationRef.current !== generation) return;

      const built = buildTodaySnapshot({
        handle,
        reads,
        capabilities,
        collaborators: TODAY_COLLABORATORS,
        nowMs: Date.now(),
      });
      const evaluated = evaluateTodaySnapshot(
        built,
        savedLookSessionIdsFrom(reads.savedLooks),
        compositionIdentityFrom(reads.composition),
      );

      const liveContext = getActorContext();
      const committed = commitTodayCardResult({
        handle,
        liveActorId: liveContext.actorId,
        liveActorEpoch: liveContext.epoch,
        actorRequestCurrent: isActorRequestCurrent(actorRequest),
        currentGenerationToken: handle.generationToken,
        result: evaluated,
      });

      if (!committed) return;
      if (!live || generationRef.current !== generation) return;
      setState({ actorKey, result: committed, loading: false });
    })();

    return () => {
      live = false;
    };
  }, [actorId, actorKey, actorLoading]);

  // Route focus is the established revalidation seam (useCloset, usePrivateDressingRoom).
  useFocusEffect(orchestrate);

  const current = state.actorKey === actorKey ? state : IDLE;
  const rawCard = current.result?.card ?? null;

  /**
   * The two action projections are applied HERE, once, in this order, between
   * the engine and everything downstream — so analytics, accessibility and the
   * rendered buttons all describe the same actions.
   *
   * CAPABILITY GATING RUNS FIRST. A partial Look's Closet action is always
   * runnable, so gating it afterwards could only ever remove an action that had
   * just been established as safe.
   */
  const card = useMemo(() => {
    if (!rawCard) return null;
    const gated = projectCapabilityGatedActions(rawCard, {
      dressingRoomActive: PRIVATE_DRESSING_ROOM_V1,
      eliseModificationActive: PRIVATE_DRESSING_ROOM_ELISE_ACTIVE,
    });
    return projectPartialLookActions(gated);
  }, [rawCard]);

  const missingSlots = useMemo(
    () => missingSlotsFor(current.result?.ownedLook?.outcome ?? null),
    [current.result],
  );

  const presentation = useMemo(
    () =>
      card
        ? projectTodayCard({
            card,
            projections: (current.result?.projections ?? []) as readonly TodayClosetProjection[],
            missingSlots,
          })
        : null,
    [card, current.result, missingSlots],
  );

  const handoffContext = useMemo(
    () => ({
      handle: handleRef.current,
      anchorClosetItemId: current.result?.ownedLook?.context.anchorClosetItemId ?? null,
      occasion: current.result?.ownedLook?.context.occasion ?? null,
      sessionId:
        current.result?.snapshot.unfinishedLook?.sessionId ??
        current.result?.snapshot.recentStyling?.sessionId ??
        null,
    }),
    [current.result],
  );

  /** Discards the effect-cleanup return so callers get a plain void action. */
  const revalidate = useCallback(() => {
    orchestrate();
  }, [orchestrate]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Read through a ref inside the handoff, never captured in a closure: the
   * point of "is the card still current" is to compare against the card as it
   * is at the moment the async step resolves.
   */
  const liveTokenRef = useRef<string | null>(null);
  liveTokenRef.current = card?.generationToken ?? null;

  /**
   * What a departure to a Today-originated destination left behind.
   *
   * `sessionId` is what lets a LATER generation observe that the Look was
   * saved; `awaitingReturn` is what lets the return restore accessibility focus
   * without hijacking it on an ordinary Home visit. Both are process-local and
   * neither is persisted.
   */
  const departureRef = useRef<{
    sessionId: string | null;
    knownSavedSessionIds: readonly string[];
    compositionIdentity: TodayOrchestrationResult['compositionIdentity'];
    modification: boolean;
    awaitingReturn: boolean;
  }>({
    sessionId: null,
    knownSavedSessionIds: [],
    compositionIdentity: null,
    modification: false,
    awaitingReturn: false,
  });
  const headingNodeRef = useRef<unknown>(null);
  const savedReportedRef = useRef<string | null>(null);
  const modifiedReportedRef = useRef<string | null>(null);

  const registerHeading = useCallback((node: unknown) => {
    headingNodeRef.current = node;
  }, []);

  /**
   * Observe, on a later generation, that a handed-off Look was saved.
   *
   * WHY IT IS OBSERVED RATHER THAN REPORTED BY THE SAVE ITSELF: the save lives
   * in the certified Build 3 Dressing Room, and Build 5 must not instrument it.
   * A Saved Look that did not exist when we handed off and does exist now, for
   * the session we handed off, is the same fact — established without touching
   * Build 3, and emitted exactly once per session.
   */
  useEffect(() => {
    const departure = departureRef.current;
    const result = current.result;
    if (!result || !departure.sessionId) return;
    if (savedReportedRef.current === departure.sessionId) return;
    const wasSaved = departure.knownSavedSessionIds.includes(departure.sessionId);
    const isSaved = result.savedLookSessionIds.includes(departure.sessionId);
    if (wasSaved || !isSaved) return;
    savedReportedRef.current = departure.sessionId;
    emitTodayWithEliseEvent('today_with_elise_look_saved', {
      ...(result.card ? todayEventPayload(result.card, Platform.OS) : {}),
    });
  }, [current.result]);

  /**
   * Observe, on a later generation, that a Look handed off to the modification
   * flow actually changed.
   *
   * Opening the flow was already reported as a secondary action. This is the
   * OUTCOME, and reporting it at tap time instead would have put a click in the
   * funnel where a result belongs.
   */
  useEffect(() => {
    const departure = departureRef.current;
    const result = current.result;
    if (!result || !departure.modification || !departure.sessionId) return;
    if (modifiedReportedRef.current === departure.sessionId) return;
    if (!compositionIdentityChanged(departure.compositionIdentity, result.compositionIdentity)) {
      return;
    }
    modifiedReportedRef.current = departure.sessionId;
    emitTodayWithEliseEvent('today_with_elise_look_modified', {
      ...(result.card ? todayEventPayload(result.card, Platform.OS) : {}),
    });
  }, [current.result]);

  /**
   * Restore accessibility focus to the card heading on RETURN, and only then.
   *
   * The heading rather than a button, because the state the user returns to may
   * legitimately offer no button. Gated on `awaitingReturn` so an ordinary Home
   * visit — or a return from anywhere else — never has its focus stolen.
   */
  useFocusEffect(
    useCallback(() => {
      const departure = departureRef.current;
      if (!departure.awaitingReturn) return undefined;
      departure.awaitingReturn = false;
      const node = headingNodeRef.current;
      if (!node) return undefined;
      try {
        const handle = findNodeHandle(node as never);
        if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle);
      } catch {
        /* focus restoration is best effort and never blocks the return */
      }
      return undefined;
    }, []),
  );

  const routeFor = useCallback(
    (target: string) =>
      resolveTodayRoute(target as never, { closetSeparationActive: CLOSET_SEPARATION_V1 }),
    [],
  );

  const onPrimaryPress = useCallback(async () => {
    const active = card;
    const handle = handleRef.current;
    if (!active || !handle || !actorId) return;
    const target = active.primaryAction?.target;
    const route = routeFor(target);
    if (!route || !active.primaryAction?.runnable) return;

    setActionError(null);

    // A Closet destination is a plain navigation: there is no session to create,
    // nothing to hydrate and nothing that could open blank. It goes through the
    // handoff module anyway, because the rapid-tap guard must be the SAME one —
    // three taps on "Add More Items" have to behave like three taps on "Tap to
    // Get Ready".
    if (target === 'closet_intake' || target === 'closet_review') {
      openTodayClosetDestination(TODAY_HANDOFF_DEPS, {
        card: active,
        generationToken: handle.generationToken,
        actorId,
        actorEpoch: handle.actorEpoch,
        route,
        analyticsPayload: todayEventPayload(active, Platform.OS),
        isCardCurrent: () => liveTokenRef.current === handle.generationToken,
      });
      return;
    }

    setBusy(true);
    try {
      const result = await openTodayDressingRoom(TODAY_HANDOFF_DEPS, {
        card: active,
        generationToken: handle.generationToken,
        actorId,
        actorEpoch: handle.actorEpoch,
        anchorClosetItemId: handoffContext.anchorClosetItemId,
        occasion: handoffContext.occasion,
        route,
        dressingRoomActive: PRIVATE_DRESSING_ROOM_V1,
        analyticsPayload: todayEventPayload(active, Platform.OS),
        isCardCurrent: () => liveTokenRef.current === handle.generationToken,
      });
      if (result.message) setActionError(result.message);
      if (result.outcome === 'opened') {
        // Recorded ONLY on a successful departure, so a refusal cannot arm the
        // save observation or the focus restoration.
        departureRef.current = {
          sessionId: handoffContext.sessionId,
          knownSavedSessionIds: current.result?.savedLookSessionIds ?? [],
          compositionIdentity: current.result?.compositionIdentity ?? null,
          modification: false,
          awaitingReturn: true,
        };
      }
    } finally {
      setBusy(false);
    }
  }, [actorId, card, current.result, handoffContext, routeFor]);

  const onSecondaryPress = useCallback(() => {
    const active = card;
    const handle = handleRef.current;
    if (!active || !handle || !actorId) return;
    const route = routeFor(active.secondaryAction?.target ?? 'none');
    if (!route || !active.secondaryAction?.runnable) return;
    setActionError(null);
    const modification = openTodayEliseModification(TODAY_HANDOFF_DEPS, {
      card: active,
      generationToken: handle.generationToken,
      actorId,
      actorEpoch: handle.actorEpoch,
      route,
      dressingRoomActive: PRIVATE_DRESSING_ROOM_V1,
      eliseModificationActive: PRIVATE_DRESSING_ROOM_ELISE_ACTIVE,
      analyticsPayload: todayEventPayload(active, Platform.OS),
      isCardCurrent: () => liveTokenRef.current === handle.generationToken,
    });
    if (modification.outcome === 'opened') {
      departureRef.current = {
        sessionId: handoffContext.sessionId,
        knownSavedSessionIds: current.result?.savedLookSessionIds ?? [],
        compositionIdentity: current.result?.compositionIdentity ?? null,
        modification: true,
        awaitingReturn: true,
      };
    }
  }, [actorId, card, current.result, handoffContext, routeFor]);

  return {
    loading: current.loading,
    card,
    presentation,
    missingSlots,
    revalidate,
    handoffContext,
    busy,
    actionError,
    onPrimaryPress: card?.primaryAction?.runnable ? onPrimaryPress : undefined,
    onSecondaryPress: card?.secondaryAction?.runnable ? onSecondaryPress : undefined,
    registerHeading,
  };
}
