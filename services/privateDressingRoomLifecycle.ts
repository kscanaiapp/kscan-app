/**
 * The private Dressing Room hydration sequence.
 *
 * PRODUCTION CODE, NOT A TEST HELPER. `hooks/usePrivateDressingRoom.ts` is the
 * only production caller and does nothing but publish what this module emits
 * into React state; the lifecycle tests call the same functions directly.
 *
 * It exists because the Phase 3 audit found the integration harness had
 * reimplemented this ordering — and, in reimplementing it, accepted `closetOk`
 * as an argument where production derived it from the typed Closet result. The
 * harness therefore proved a sequence that production did not run, and hid a
 * real defect (a Closet load failure being reported as a missing swapped item).
 * Ordering now lives in one place, so a test cannot pass against an ordering
 * production does not use.
 *
 * DESIGN NOTES
 *
 * - `interactionsEnabled` is a PARAMETER, not a flag read. Both sides of the
 *   nested gate have to be provable, and a module-level constant cannot be.
 * - `isCurrent` is checked after every await. The caller owns what "current"
 *   means (generation token plus actor epoch in the hook); this module only
 *   agrees to stop.
 * - Snapshots carry no `actorKey`. Stamping results with an actor is the
 *   caller's concern, and duplicating it here would be a second source of truth.
 * - Nothing is published before it is persisted, so no state reaches a caller
 *   that would vanish on the next launch.
 */

import { loadClosetTyped } from './closetLibrary';
import { getClosetItemProjections } from './closetItemProjection';
import type { ClosetItemProjection } from './closetItemProjection';
import {
  discardActiveSession,
  loadActiveSession,
  resetCorruptSession,
} from './privateDressingRoomSessionStore';
import type { PrivateSessionResult } from './privateDressingRoomSessionStore';
import {
  discardCompositionSet,
  loadCompositionSet,
  reconcileCompositionSet,
  replaceCompositionSet,
} from './privateDressingRoomCompositionStore';
import { buildCompositionFingerprint } from './privateDressingRoomCompositionSchema';
import { composePrivateOutfits } from './privateDressingRoomComposer';
import {
  discardInteractionState,
  loadInteractionState,
  reconcileInteractionState,
} from './privateDressingRoomInteractionStore';
import type { InteractionContext } from './privateDressingRoomInteractionStore';
import {
  compositionStatusForComposerCode,
  isCompositionReady,
} from './privateDressingRoomCoordinator';
import type {
  ClosetLoadStatus,
  PrivateCompositionStatus,
  PrivateWorkspaceErrorCode,
} from './privateDressingRoomCoordinator';
import type {
  PrivateDressingRoomCompositionSet,
  PrivateDressingRoomSlot,
} from '../types/privateDressingRoomComposition';
import type { PrivateDressingRoomInteractionState } from '../types/privateDressingRoomInteraction';

export type LifecycleClosetSnapshot = {
  status: ClosetLoadStatus;
  items: ClosetItemProjection[];
  /** The TYPED result: an empty Closet and an unreadable one are different. */
  ok: boolean;
};

export type LifecycleCompositionSnapshot = {
  status: PrivateCompositionStatus;
  composition: PrivateDressingRoomCompositionSet | null;
  errorCode: PrivateWorkspaceErrorCode | null;
  recovered: boolean;
};

export type LifecycleInteractionSnapshot = {
  state: PrivateDressingRoomInteractionState | null;
  loading: boolean;
  corrupt: boolean;
  recovered: boolean;
  missing: { lookId: string; slot: PrivateDressingRoomSlot; closetItemId: string }[];
};

export const IDLE_LIFECYCLE_COMPOSITION: LifecycleCompositionSnapshot = {
  status: 'idle',
  composition: null,
  errorCode: null,
  recovered: false,
};

export const IDLE_LIFECYCLE_INTERACTION: LifecycleInteractionSnapshot = {
  state: null,
  loading: false,
  corrupt: false,
  recovered: false,
  missing: [],
};

/** Emitted as each stage resolves, so a caller can render progressively. */
export type LifecyclePublisher = {
  closet?: (snapshot: LifecycleClosetSnapshot) => void;
  session?: (result: PrivateSessionResult) => void;
  composition?: (snapshot: LifecycleCompositionSnapshot) => void;
  interaction?: (snapshot: LifecycleInteractionSnapshot) => void;
};

export type LifecycleResult = {
  closet: LifecycleClosetSnapshot;
  session: PrivateSessionResult | null;
  composition: LifecycleCompositionSnapshot;
  interaction: LifecycleInteractionSnapshot;
  /** Null until a session exists; the interaction identity for this workspace. */
  context: InteractionContext | null;
  /** True when the sequence stopped early because the caller went stale. */
  abandoned: boolean;
};

const ALWAYS_CURRENT = () => true;

function fingerprintFor(record: NonNullable<PrivateSessionResult['session']>): string {
  return buildCompositionFingerprint({
    actorId: record.actorId,
    sessionId: record.sessionId,
    status: record.status,
    anchorClosetItemId: record.anchorClosetItemId,
    occasion: record.occasion,
  });
}

/**
 * Compose from a known-good context and persist the result.
 *
 * Publishing happens ONLY after persistence succeeds.
 */
export async function composeAndPersistComposition(input: {
  actorRequest: unknown;
  session: NonNullable<PrivateSessionResult['session']>;
  items: ClosetItemProjection[];
  closetOk: boolean;
  isCurrent?: () => boolean;
  isActorCurrent?: () => boolean;
}): Promise<LifecycleCompositionSnapshot> {
  const isCurrent = input.isCurrent ?? ALWAYS_CURRENT;
  const record = input.session;
  const fingerprint = fingerprintFor(record);

  const composed = composePrivateOutfits({
    session: {
      actorId: record.actorId,
      sessionId: record.sessionId,
      status: record.status,
      anchorClosetItemId: record.anchorClosetItemId,
      occasion: record.occasion,
    },
    closet: { ok: input.closetOk, items: input.items },
    isActorCurrent: input.isActorCurrent,
  });

  const mapped = compositionStatusForComposerCode(composed.code);
  if (composed.looks.length === 0) {
    return { ...mapped, composition: null, recovered: false };
  }

  const saved = await replaceCompositionSet(input.actorRequest, {
    sessionId: record.sessionId,
    inputFingerprint: fingerprint,
    looks: composed.looks,
  });
  if (!isCurrent()) return IDLE_LIFECYCLE_COMPOSITION;
  if (!saved.ok) {
    return {
      status: 'failed',
      composition: null,
      errorCode: 'PERSISTENCE_FAILED',
      recovered: false,
    };
  }
  return {
    status: mapped.status,
    composition: saved.composition,
    errorCode: null,
    recovered: false,
  };
}

/**
 * Load and reconcile interaction state for a resolved composition.
 *
 * SHORT-CIRCUITS WHEN THE NESTED GATE IS CLOSED: no store read, no
 * reconciliation. That is the Phase 2 view-only guarantee, enforced at this one
 * entry point rather than at every call site.
 *
 * A Closet load failure is never converted into a missing-swapped-item state —
 * with no projections we cannot tell, so nothing is claimed.
 */
export async function loadInteractionSnapshot(input: {
  actorRequest: unknown;
  interactionsEnabled: boolean;
  session: NonNullable<PrivateSessionResult['session']>;
  composition: PrivateDressingRoomCompositionSet | null;
  items: ClosetItemProjection[];
  fingerprint: string;
  closetOk: boolean;
  isCurrent?: () => boolean;
  onLoading?: () => void;
}): Promise<LifecycleInteractionSnapshot | null> {
  const isCurrent = input.isCurrent ?? ALWAYS_CURRENT;
  if (!input.interactionsEnabled || !input.composition) {
    return IDLE_LIFECYCLE_INTERACTION;
  }
  input.onLoading?.();

  const context: InteractionContext = {
    sessionId: input.session.sessionId,
    compositionId: input.composition.compositionId,
    inputFingerprint: input.fingerprint,
  };
  const loaded = await loadInteractionState(input.actorRequest, context);
  // Null means "the caller went stale" — distinct from an idle snapshot.
  if (!isCurrent()) return null;

  if (!loaded.ok) {
    // Corrupt EDITS do not cost the user their outfits: the Phase 2 composition
    // stays exactly as it is and only Reset Edits is offered.
    return { ...IDLE_LIFECYCLE_INTERACTION, corrupt: true };
  }

  const state = loaded.stale ? null : loaded.interaction;
  const reconciled = state
    ? reconcileInteractionState(
        state,
        input.items.map((item) => item.id),
        input.composition.looks.map((look) => look.lookId),
      )
    : { missingOverrides: [], unknownLookIds: [], comparedLookIdsValid: false };

  return {
    state,
    loading: false,
    corrupt: false,
    recovered: loaded.recovered === 'backup',
    missing: input.closetOk ? reconciled.missingOverrides : [],
  };
}

/**
 * End the active session and clean up everything scoped to it.
 *
 * The session write is AUTHORITATIVE; the two cleanups that follow are best
 * effort. A surviving composition or interaction file is already unusable —
 * both are validated against a session identity that no longer exists — so a
 * failed delete cannot resurrect the user's edits, and a thrown error here must
 * not make a successful discard look like a failure.
 *
 * `onSessionSettled` fires the moment the session write lands, so a caller can
 * drop its in-memory state before waiting on cleanup rather than after.
 */
export async function discardPrivateDressingRoomSession(input: {
  actorRequest: unknown;
  interactionsEnabled: boolean;
  /** `reset` is the corrupt-session recovery path; `discard` is user-initiated. */
  mode: 'discard' | 'reset';
  isCurrent?: () => boolean;
  onSessionSettled?: (result: PrivateSessionResult) => void;
}): Promise<{
  session: PrivateSessionResult;
  cleanedComposition: boolean;
  cleanedInteraction: boolean;
}> {
  const isCurrent = input.isCurrent ?? ALWAYS_CURRENT;
  const result =
    input.mode === 'reset'
      ? await resetCorruptSession(input.actorRequest)
      : await discardActiveSession(input.actorRequest);

  if (!isCurrent()) {
    return { session: result, cleanedComposition: false, cleanedInteraction: false };
  }
  input.onSessionSettled?.(result);

  let cleanedComposition = false;
  try {
    await discardCompositionSet(input.actorRequest);
    cleanedComposition = true;
  } catch {
    cleanedComposition = false;
  }

  let cleanedInteraction = false;
  if (input.interactionsEnabled) {
    try {
      await discardInteractionState(input.actorRequest);
      cleanedInteraction = true;
    } catch {
      cleanedInteraction = false;
    }
  }

  return { session: result, cleanedComposition, cleanedInteraction };
}

/**
 * Read Closet, session and composition for the current actor, composing when a
 * valid context has no current composition, then hydrate interaction state.
 *
 * THE SINGLE ORDERING. Every early return publishes an interaction snapshot, so
 * no caller can be left holding interaction state from a previous composition
 * because a branch forgot to clear it.
 */
export async function hydratePrivateDressingRoom(input: {
  actorId: string | null;
  actorRequest: unknown;
  interactionsEnabled: boolean;
  isCurrent?: () => boolean;
  publish?: LifecyclePublisher;
}): Promise<LifecycleResult> {
  const isCurrent = input.isCurrent ?? ALWAYS_CURRENT;
  const publish = input.publish ?? {};

  const abandon = (
    closet: LifecycleClosetSnapshot,
    session: PrivateSessionResult | null = null,
  ): LifecycleResult => ({
    closet,
    session,
    composition: IDLE_LIFECYCLE_COMPOSITION,
    interaction: IDLE_LIFECYCLE_INTERACTION,
    context: null,
    abandoned: true,
  });

  const emptyCloset: LifecycleClosetSnapshot = { status: 'loading', items: [], ok: false };

  // TYPED load: an empty Closet and a failed read are finally different things,
  // so the workspace never shows "your Closet is empty" for a fault.
  const closetResult = await loadClosetTyped(input.actorId, { actorRequest: input.actorRequest });
  if (!isCurrent()) return abandon(emptyCloset);

  const items = closetResult.ok ? getClosetItemProjections(closetResult.items) : [];
  const closet: LifecycleClosetSnapshot = {
    status: closetResult.ok ? 'loaded' : 'failed',
    items,
    ok: closetResult.ok,
  };
  publish.closet?.(closet);

  const sessionResult = await loadActiveSession(input.actorRequest);
  if (!isCurrent()) return abandon(closet);
  publish.session?.(sessionResult);

  const settle = (
    composition: LifecycleCompositionSnapshot,
    interaction: LifecycleInteractionSnapshot,
    context: InteractionContext | null,
  ): LifecycleResult => {
    publish.composition?.(composition);
    publish.interaction?.(interaction);
    return { closet, session: sessionResult, composition, interaction, context, abandoned: false };
  };

  const record = sessionResult.ok ? sessionResult.session : null;
  if (!record) {
    return settle(IDLE_LIFECYCLE_COMPOSITION, IDLE_LIFECYCLE_INTERACTION, null);
  }

  const fingerprint = fingerprintFor(record);
  const stored = await loadCompositionSet(input.actorRequest, fingerprint);
  if (!isCurrent()) return abandon(closet, sessionResult);

  if (!stored.ok) {
    return settle(
      {
        status: 'corrupt',
        composition: null,
        errorCode: 'COMPOSITION_CORRUPT',
        recovered: false,
      },
      IDLE_LIFECYCLE_INTERACTION,
      null,
    );
  }

  const anchorMissing =
    !!record.anchorClosetItemId && !items.some((item) => item.id === record.anchorClosetItemId);

  const hydrateInteraction = async (
    composition: PrivateDressingRoomCompositionSet,
    compositionSnapshot: LifecycleCompositionSnapshot,
  ): Promise<LifecycleResult | null> => {
    publish.composition?.(compositionSnapshot);
    const interaction = await loadInteractionSnapshot({
      actorRequest: input.actorRequest,
      interactionsEnabled: input.interactionsEnabled,
      session: record,
      composition,
      items,
      fingerprint,
      closetOk: closetResult.ok,
      isCurrent,
      onLoading: () =>
        publish.interaction?.({ ...IDLE_LIFECYCLE_INTERACTION, loading: true }),
    });
    if (!interaction) return null;
    publish.interaction?.(interaction);
    return {
      closet,
      session: sessionResult,
      composition: compositionSnapshot,
      interaction,
      context: {
        sessionId: record.sessionId,
        compositionId: composition.compositionId,
        inputFingerprint: fingerprint,
      },
      abandoned: false,
    };
  };

  // RESTORE WITHOUT RECOMPOSING. A valid stored composition is returned as it
  // was left; foregrounding must not silently produce different outfits.
  if (stored.composition) {
    const reconciled = reconcileCompositionSet(
      stored.composition,
      items.map((item) => item.id),
      record.anchorClosetItemId,
    );
    const stale = reconciled.staleLookIds.length > 0 || reconciled.anchorMissing;
    const settled = await hydrateInteraction(stored.composition, {
      status: stale ? 'stale' : 'ready',
      composition: stored.composition,
      errorCode: stale ? 'COMPOSITION_STALE' : null,
      recovered: stored.recovered === 'backup',
    });
    return settled ?? abandon(closet, sessionResult);
  }

  if (!isCompositionReady({ session: record, anchorMissing })) {
    return settle(
      {
        status: 'idle',
        composition: null,
        errorCode: anchorMissing ? 'ANCHOR_MISSING' : null,
        recovered: false,
      },
      IDLE_LIFECYCLE_INTERACTION,
      null,
    );
  }

  const next = await composeAndPersistComposition({
    actorRequest: input.actorRequest,
    session: record,
    items,
    closetOk: closetResult.ok,
    isCurrent,
  });
  if (!isCurrent()) return abandon(closet, sessionResult);

  if (!next.composition) {
    return settle(next, IDLE_LIFECYCLE_INTERACTION, null);
  }
  const settled = await hydrateInteraction(next.composition, next);
  return settled ?? abandon(closet, sessionResult);
}
