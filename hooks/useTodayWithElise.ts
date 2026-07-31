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
import { useFocusEffect } from 'expo-router';
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
import { loadActiveSession } from '../services/privateDressingRoomSessionStore';
import { loadCompositionSet } from '../services/privateDressingRoomCompositionStore';
import { buildCompositionFingerprint } from '../services/privateDressingRoomCompositionSchema';
import { loadPrivateSavedLooks } from '../services/privateSavedLookStore';
import { listClosetCandidates } from '../services/closetCandidateLibrary';
import { beginTodayCardEvaluation } from '../services/todayWithElise/actorInvalidation';
import type { TodayCardOrchestrationHandle } from '../services/todayWithElise/actorInvalidation';
import {
  buildTodaySnapshot,
  commitTodayCardResult,
  evaluateTodaySnapshot,
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
  type TodayCardPresentation,
} from '../services/todayWithElise/presentation';
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
      setState({ actorKey, result: evaluateTodaySnapshot(built), loading: false });
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
      const evaluated = evaluateTodaySnapshot(built);

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

  return {
    loading: current.loading,
    card,
    presentation,
    missingSlots,
    revalidate,
    handoffContext,
  };
}
