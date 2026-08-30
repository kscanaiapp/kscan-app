// K+ Packing Intelligence V1 — screen-facing state.
//
// The hook is the actor boundary for Packing: every read is scoped to the
// signed-in actor's id, so a snapshot left behind by a previous account is
// never returned even before AuthSessionContext's reset runs. Mirrors the
// actorKey discipline useCloset() and useLibrary() already follow.
//
// REFINEMENT IS FULL REGENERATION (build plan addendum section N). V1 does not
// build an incremental plan-patch framework: "don't bring the boots" becomes an
// exclusion constraint and the whole plan is generated again from the original
// trip plus the accumulated constraints. It costs more than a patch and is
// worth it — there is exactly one code path that can produce an authoritative
// plan, so the structured state and the screen cannot drift apart.

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useKPlusEntitlement } from './useKPlusEntitlement';
import { PACKING_INTELLIGENCE_V1 } from '../constants/featureFlags';
import { requestPackingPlan } from '../services/packing/packingClient';
import {
  addPackingConstraintNote,
  applyPackingFailure,
  applyPackingGeneralGuide,
  applyPackingPlan,
  beginPackingRequest,
  excludePackingItem,
  getPackingSnapshot,
  getPackingSnapshotFor,
  setPackingPackLight,
  subscribeToPackingPlan,
  type PackingSnapshot,
} from '../services/packing/packingPlanStore';
import type { PackingTripDraft } from '../types/packing';
import { resolveRefinementIntent } from '../services/packing/packingRefinement';

export interface UsePackingPlanResult extends PackingSnapshot {
  available: boolean;
  entitled: boolean;
  entitlementState: ReturnType<typeof useKPlusEntitlement>['state'];
  generate: (trip: PackingTripDraft) => Promise<void>;
  regenerate: () => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  refineWith: (note: string) => Promise<void>;
  togglePackLight: (packLight: boolean) => Promise<void>;
}

const EMPTY_SNAPSHOT: PackingSnapshot = {
  actorId: null,
  sessionId: null,
  trip: null,
  plan: null,
  generalGuide: null,
  message: null,
  excludedItemIds: [],
  constraintNotes: [],
  packLight: false,
  status: 'idle',
  errorCode: null,
  retryable: false,
};

function newSessionId(): string {
  // The Packing task is carried on a StyleChat session id: the backend records
  // burst/daily usage against the same Elise budget and the plan is written to
  // that session's message stream. No new identity space.
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function usePackingPlan(): UsePackingPlanResult {
  const { isAuthenticated, user } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const entitlement = useKPlusEntitlement();

  // Subscribe to the raw store, then scope the read. Subscribing to a scoped
  // selector would miss the notification that CLEARS another actor's snapshot.
  useSyncExternalStore(subscribeToPackingPlan, getPackingSnapshot);
  const snapshot = useMemo(
    () => (actorId ? getPackingSnapshotFor(actorId) : EMPTY_SNAPSHOT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actorId, getPackingSnapshot()],
  );

  const available = PACKING_INTELLIGENCE_V1 && isAuthenticated;

  const run = useCallback(
    async (
      trip: PackingTripDraft,
      constraints: { excludeItemIds: string[]; notes: string[]; packLight: boolean },
      sessionId: string,
    ) => {
      if (!actorId) return;
      beginPackingRequest({
        actorId,
        sessionId,
        trip,
        excludedItemIds: constraints.excludeItemIds,
        constraintNotes: constraints.notes,
        packLight: constraints.packLight,
      });

      const result = await requestPackingPlan({
        sessionId,
        trip,
        constraints: {
          excludeItemIds: constraints.excludeItemIds,
          notes: constraints.notes,
          packLight: constraints.packLight,
        },
      });

      // The actor may have changed while the request was in flight. Applying the
      // result would render one account's Closet under another's session, so a
      // late completion across an actor boundary is discarded, exactly as
      // useCloset()/useLibrary() discard theirs.
      if (getPackingSnapshot().actorId !== actorId) return;

      if (result.status === 'success' && result.plan) {
        applyPackingPlan({ actorId, plan: result.plan, message: result.message });
        return;
      }
      if (result.status === 'general_mode') {
        applyPackingGeneralGuide({ actorId, guide: result.generalGuide, message: result.message });
        return;
      }
      applyPackingFailure({
        actorId,
        message: result.message,
        errorCode: result.errorCode,
        retryable: result.retryable,
      });
    },
    [actorId],
  );

  const generate = useCallback(
    async (trip: PackingTripDraft) => {
      if (!available || !actorId) return;
      // A new trip starts a new task: previous exclusions and refinements
      // belonged to the previous trip and must not silently follow the traveller
      // to a different destination.
      await run(trip, { excludeItemIds: [], notes: [], packLight: false }, newSessionId());
    },
    [available, actorId, run],
  );

  const regenerate = useCallback(async () => {
    const current = actorId ? getPackingSnapshotFor(actorId) : EMPTY_SNAPSHOT;
    if (!available || !actorId || !current.trip) return;
    await run(
      current.trip,
      {
        excludeItemIds: current.excludedItemIds,
        notes: current.constraintNotes,
        packLight: current.packLight,
      },
      current.sessionId ?? newSessionId(),
    );
  }, [available, actorId, run]);

  const removeItem = useCallback(
    async (itemId: string) => {
      const current = actorId ? getPackingSnapshotFor(actorId) : EMPTY_SNAPSHOT;
      if (!available || !actorId || !current.trip) return;
      const excludeItemIds = excludePackingItem(actorId, itemId);
      await run(
        current.trip,
        { excludeItemIds, notes: current.constraintNotes, packLight: current.packLight },
        current.sessionId ?? newSessionId(),
      );
    },
    [available, actorId, run],
  );

  const refineWith = useCallback(
    async (note: string) => {
      const current = actorId ? getPackingSnapshotFor(actorId) : EMPTY_SNAPSHOT;
      if (!available || !actorId || !current.trip || !note.trim()) return;

      // A refinement that unambiguously names one item in the plan on screen
      // becomes a HARD exclusion the server enforces in post-model
      // validation -- so "don't bring the boots" removes the boots whether or
      // not the model cooperates. Anything the resolver cannot decode still
      // reaches the model as a constraint, so a refinement never silently
      // does nothing.
      const intent = resolveRefinementIntent(note, current.plan);
      const notes = addPackingConstraintNote(actorId, intent.note);
      let excludeItemIds = current.excludedItemIds;
      for (const itemId of intent.excludeItemIds) {
        excludeItemIds = excludePackingItem(actorId, itemId);
      }

      await run(
        current.trip,
        { excludeItemIds, notes, packLight: current.packLight },
        current.sessionId ?? newSessionId(),
      );
    },
    [available, actorId, run],
  );

  const togglePackLight = useCallback(
    async (packLight: boolean) => {
      const current = actorId ? getPackingSnapshotFor(actorId) : EMPTY_SNAPSHOT;
      if (!available || !actorId || !current.trip) return;
      setPackingPackLight(actorId, packLight);
      await run(
        current.trip,
        { excludeItemIds: current.excludedItemIds, notes: current.constraintNotes, packLight },
        current.sessionId ?? newSessionId(),
      );
    },
    [available, actorId, run],
  );

  return {
    ...snapshot,
    available,
    // Client entitlement is UX only; the server re-checks has_active_k_plus()
    // on every request and is the authority. Any unresolved state is treated as
    // "no premium access", never as active.
    entitled: entitlement.isActive,
    entitlementState: entitlement.state,
    generate,
    regenerate,
    removeItem,
    refineWith,
    togglePackLight,
  };
}
