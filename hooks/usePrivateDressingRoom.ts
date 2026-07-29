/**
 * Route-level view model for the private Dressing Room workspace.
 *
 * A THIN wrapper. Every ordering rule lives in
 * services/privateDressingRoomCoordinator.ts (pure, tested without a renderer),
 * composition in services/privateDressingRoomComposer.ts (pure), and every
 * write in the two private stores. This file gathers React state and sequences
 * the four of them.
 *
 * ACTOR SAFETY mirrors hooks/useCloset.js: results are held in an
 * actorKey-stamped snapshot, and a completion captured before an actor
 * transition is discarded rather than rendered under the new actor. The
 * monotonic actor epoch is what makes a same-user sign-out / sign-back-in cycle
 * rejectable, since actorId and actorKey are identical across it.
 *
 * THE SCREEN NEVER CALLS PERSISTENCE. The actions below are the only mutation
 * surface, and the Closet stays authoritative for garments: this hook reads it
 * through the same projection boundary the Closet UI uses and never writes to it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { loadClosetTyped } from '../services/closetLibrary';
import { getClosetItemProjections } from '../services/closetItemProjection';
import type { ClosetItemProjection } from '../services/closetItemProjection';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { PRIVATE_DRESSING_ROOM_V1 } from '../constants/featureFlags';
import {
  discardActiveSession,
  loadActiveSession,
  resetCorruptSession,
  startActiveSession,
  updateActiveSession,
} from '../services/privateDressingRoomSessionStore';
import type { PrivateSessionResult } from '../services/privateDressingRoomSessionStore';
import {
  discardCompositionSet,
  loadCompositionSet,
  reconcileCompositionSet,
  replaceCompositionSet,
  resetCorruptComposition,
  setActiveLook,
} from '../services/privateDressingRoomCompositionStore';
import { buildCompositionFingerprint } from '../services/privateDressingRoomCompositionSchema';
import { composePrivateOutfits } from '../services/privateDressingRoomComposer';
import {
  compositionStatusForComposerCode,
  isCompositionReady,
  resolveCompositionLooks,
  resolvePrivateWorkspaceView,
  resolveRouteAnchorIntent,
} from '../services/privateDressingRoomCoordinator';
import type {
  ClosetLoadStatus,
  PrivateCompositionStatus,
  PrivateWorkspaceErrorCode,
  PrivateWorkspaceView,
  ResolvedLook,
} from '../services/privateDressingRoomCoordinator';
import type { PrivateDressingRoomCompositionSet } from '../types/privateDressingRoomComposition';

/**
 * Lightweight active-session probe for entry points.
 *
 * Reads the private session domain and nothing else — no Closet load, no
 * projection work, no composition, and emphatically no collaborative room
 * state. It exists so the Stylist entry can say "Resume" instead of "Start"
 * without mounting the whole workspace, and it never mutates.
 */
export function usePrivateDressingRoomStatus(): { hasActiveSession: boolean } {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';
  const [state, setState] = useState<{ actorKey: string | null; active: boolean }>({
    actorKey: null,
    active: false,
  });

  const probe = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_V1 || actorLoading) return undefined;
    let live = true;
    const actorRequest = createActorRequest();
    void loadActiveSession(actorRequest).then((result) => {
      if (!live || !isActorRequestCurrent(actorRequest)) return;
      setState({ actorKey, active: result.ok && result.session !== null });
    });
    return () => {
      live = false;
    };
  }, [actorKey, actorLoading]);

  useFocusEffect(probe);

  return { hasActiveSession: state.actorKey === actorKey && state.active };
}

type ClosetSnapshot = {
  actorKey: string | null;
  status: ClosetLoadStatus;
  items: ClosetItemProjection[];
};

type SessionSnapshot = {
  actorKey: string | null;
  result: PrivateSessionResult | null;
};

type CompositionSnapshot = {
  actorKey: string | null;
  status: PrivateCompositionStatus;
  composition: PrivateDressingRoomCompositionSet | null;
  errorCode: PrivateWorkspaceErrorCode | null;
  recovered: boolean;
};

const IDLE_COMPOSITION: CompositionSnapshot = {
  actorKey: null,
  status: 'idle',
  composition: null,
  errorCode: null,
  recovered: false,
};

export function usePrivateDressingRoom(routeClosetItemId?: unknown): PrivateWorkspaceView & {
  busy: boolean;
  compositionStatus: PrivateCompositionStatus;
  compositionError: PrivateWorkspaceErrorCode | null;
  compositionRecovered: boolean;
  looks: ResolvedLook[];
  activeLookId: string | null;
  startSession: (input?: { anchorClosetItemId?: string | null; occasion?: string | null }) => Promise<void>;
  resumeSession: () => Promise<void>;
  setAnchor: (closetItemId: string) => Promise<void>;
  clearAnchor: () => Promise<void>;
  setOccasion: (occasion: string) => Promise<void>;
  clearOccasion: () => Promise<void>;
  discardSession: () => Promise<void>;
  resetSession: () => Promise<void>;
  selectLook: (lookId: string) => Promise<void>;
  rebuildOutfits: () => Promise<void>;
  retry: () => void;
  resetComposition: () => Promise<void>;
  revalidate: () => void;
} {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';

  const [closet, setCloset] = useState<ClosetSnapshot>({
    actorKey: null,
    status: 'loading',
    items: [],
  });
  const [session, setSession] = useState<SessionSnapshot>({ actorKey: null, result: null });
  const [composition, setComposition] = useState<CompositionSnapshot>(IDLE_COMPOSITION);
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(0);
  const routeAppliedRef = useRef<string | null>(null);

  /**
   * Compose from a known-good context and persist the result.
   *
   * Publishing happens ONLY after persistence succeeds, so the UI can never
   * show outfits that would vanish on the next launch.
   */
  const composeAndPersist = useCallback(
    async (
      actorRequest: unknown,
      sessionRecord: NonNullable<PrivateSessionResult['session']>,
      items: ClosetItemProjection[],
      closetOk: boolean,
      isCurrent: () => boolean,
    ): Promise<CompositionSnapshot> => {
      const fingerprint = buildCompositionFingerprint({
        actorId: sessionRecord.actorId,
        sessionId: sessionRecord.sessionId,
        status: sessionRecord.status,
        anchorClosetItemId: sessionRecord.anchorClosetItemId,
        occasion: sessionRecord.occasion,
      });

      const composed = composePrivateOutfits({
        session: {
          actorId: sessionRecord.actorId,
          sessionId: sessionRecord.sessionId,
          status: sessionRecord.status,
          anchorClosetItemId: sessionRecord.anchorClosetItemId,
          occasion: sessionRecord.occasion,
        },
        closet: { ok: closetOk, items },
        isActorCurrent: () => isActorRequestCurrent(actorRequest),
      });

      const mapped = compositionStatusForComposerCode(composed.code);
      if (composed.looks.length === 0) {
        return { actorKey, ...mapped, composition: null, recovered: false };
      }

      const saved = await replaceCompositionSet(actorRequest, {
        sessionId: sessionRecord.sessionId,
        inputFingerprint: fingerprint,
        looks: composed.looks,
      });
      if (!isCurrent()) return IDLE_COMPOSITION;
      if (!saved.ok) {
        return {
          actorKey,
          status: 'failed',
          composition: null,
          errorCode: 'PERSISTENCE_FAILED',
          recovered: false,
        };
      }
      return {
        actorKey,
        status: mapped.status,
        composition: saved.composition,
        errorCode: null,
        recovered: false,
      };
    },
    [actorKey],
  );

  /**
   * Read Closet, session and composition for the CURRENT actor, composing when
   * a valid context has no current composition.
   *
   * One generation token covers all three reads, so a stale trio can never be
   * combined with a fresh one into a view that never existed.
   */
  const hydrate = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_V1 || actorLoading) return undefined;

    const generation = ++generationRef.current;
    let live = true;
    const actorRequest = createActorRequest();
    const isCurrent = () =>
      live && generationRef.current === generation && isActorRequestCurrent(actorRequest);

    setCloset({ actorKey, status: 'loading', items: [] });
    setSession({ actorKey, result: null });
    setComposition({ ...IDLE_COMPOSITION, actorKey, status: 'building' });

    void (async () => {
      // TYPED load: an empty Closet and a failed read are finally different
      // things, so the workspace never shows "your Closet is empty" for a fault.
      const closetResult = await loadClosetTyped(actorId, { actorRequest });
      if (!isCurrent()) return;
      const items = closetResult.ok ? getClosetItemProjections(closetResult.items) : [];
      const status: ClosetLoadStatus = closetResult.ok ? 'loaded' : 'failed';
      setCloset({ actorKey, status, items });

      const sessionResult = await loadActiveSession(actorRequest);
      if (!isCurrent()) return;
      setSession({ actorKey, result: sessionResult });

      const record = sessionResult.ok ? sessionResult.session : null;
      if (!record) {
        setComposition({ ...IDLE_COMPOSITION, actorKey });
        return;
      }

      const fingerprint = buildCompositionFingerprint({
        actorId: record.actorId,
        sessionId: record.sessionId,
        status: record.status,
        anchorClosetItemId: record.anchorClosetItemId,
        occasion: record.occasion,
      });

      const stored = await loadCompositionSet(actorRequest, fingerprint);
      if (!isCurrent()) return;

      if (!stored.ok) {
        setComposition({
          actorKey,
          status: 'corrupt',
          composition: null,
          errorCode: 'COMPOSITION_CORRUPT',
          recovered: false,
        });
        return;
      }

      const anchorMissing =
        !!record.anchorClosetItemId && !items.some((item) => item.id === record.anchorClosetItemId);

      // RESTORE WITHOUT RECOMPOSING. A valid stored composition is returned as
      // it was left; foregrounding must not silently produce different outfits.
      if (stored.composition) {
        const reconciled = reconcileCompositionSet(
          stored.composition,
          items.map((item) => item.id),
          record.anchorClosetItemId,
        );
        setComposition({
          actorKey,
          status: reconciled.staleLookIds.length > 0 || reconciled.anchorMissing ? 'stale' : 'ready',
          composition: stored.composition,
          errorCode:
            reconciled.staleLookIds.length > 0 || reconciled.anchorMissing
              ? 'COMPOSITION_STALE'
              : null,
          recovered: stored.recovered === 'backup',
        });
        return;
      }

      if (!isCompositionReady({ session: record, anchorMissing })) {
        setComposition({
          actorKey,
          status: 'idle',
          composition: null,
          errorCode: anchorMissing ? 'ANCHOR_MISSING' : null,
          recovered: false,
        });
        return;
      }

      const next = await composeAndPersist(
        actorRequest,
        record,
        items,
        closetResult.ok,
        isCurrent,
      );
      if (!isCurrent()) return;
      setComposition(next);
    })();

    return () => {
      live = false;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [actorId, actorKey, actorLoading, composeAndPersist]);

  // Route focus: the established route-scoped revalidation seam (useCloset.js).
  useFocusEffect(hydrate);

  /**
   * Returning to the foreground revalidates exactly as a focus does.
   *
   * Route-scoped, not global: the subscription is created by this screen and
   * removed with it, so a backgrounded app with the workspace closed subscribes
   * to nothing.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') hydrate();
    });
    return () => subscription?.remove?.();
  }, [hydrate]);

  /** An actor transition invalidates every snapshot and any pending work. */
  useEffect(() => {
    generationRef.current += 1;
    routeAppliedRef.current = null;
    setCloset({ actorKey: null, status: 'loading', items: [] });
    setSession({ actorKey: null, result: null });
    setComposition(IDLE_COMPOSITION);
  }, [actorKey]);

  const view = useMemo(
    () =>
      resolvePrivateWorkspaceView({
        enabled: PRIVATE_DRESSING_ROOM_V1,
        actorLoading,
        closetStatus: closet.actorKey === actorKey ? closet.status : 'loading',
        closetItems: closet.actorKey === actorKey ? closet.items : [],
        session: session.actorKey === actorKey ? session.result : null,
        routeClosetItemId,
      }),
    [actorKey, actorLoading, closet, session, routeClosetItemId],
  );

  const current = composition.actorKey === actorKey ? composition : IDLE_COMPOSITION;

  const looks = useMemo(
    () =>
      current.composition
        ? resolveCompositionLooks({
            looks: current.composition.looks,
            closetItems: view.closetItems,
            activeLookId: current.composition.activeLookId,
            anchorClosetItemId: view.session?.anchorClosetItemId ?? null,
          })
        : [],
    [current.composition, view.closetItems, view.session],
  );

  /**
   * Mutate the session, then REPLACE the composition.
   *
   * Order matters and is the whole reason no cross-file transaction is needed:
   * the session lands first, which immediately makes the previous composition
   * stale by fingerprint; the old outfits are dropped from state before the new
   * ones are built; and the replacement is published only once persisted.
   */
  const mutateContext = useCallback(
    async (operation: (request: unknown) => Promise<PrivateSessionResult>) => {
      if (busy) return;
      setBusy(true);
      const actorRequest = createActorRequest();
      const isCurrent = () => isActorRequestCurrent(actorRequest);
      try {
        const result = await operation(actorRequest);
        if (!isCurrent()) return;
        setSession({ actorKey, result });

        const record = result.ok ? result.session : null;
        if (!result.ok) {
          setComposition({
            actorKey,
            status: 'failed',
            composition: null,
            errorCode: 'PERSISTENCE_FAILED',
            recovered: false,
          });
          return;
        }
        if (!record) {
          setComposition({ ...IDLE_COMPOSITION, actorKey });
          return;
        }

        // The old composition is hidden the moment the context changes, before
        // any replacement exists.
        setComposition({ ...IDLE_COMPOSITION, actorKey, status: 'building' });
        // Best-effort cleanup. Fingerprint validation already makes a surviving
        // file unusable, so a failure here is not worth surfacing.
        await discardCompositionSet(actorRequest);
        if (!isCurrent()) return;

        const items = closet.actorKey === actorKey ? closet.items : [];
        const closetOk = closet.actorKey === actorKey && closet.status === 'loaded';
        const anchorMissing =
          !!record.anchorClosetItemId &&
          !items.some((item) => item.id === record.anchorClosetItemId);

        if (!isCompositionReady({ session: record, anchorMissing })) {
          setComposition({
            actorKey,
            status: 'idle',
            composition: null,
            errorCode: anchorMissing ? 'ANCHOR_MISSING' : null,
            recovered: false,
          });
          return;
        }

        const next = await composeAndPersist(actorRequest, record, items, closetOk, isCurrent);
        if (!isCurrent()) return;
        setComposition(next);
      } finally {
        setBusy(false);
      }
    },
    [actorKey, busy, closet, composeAndPersist],
  );

  const startSession = useCallback(
    (input: { anchorClosetItemId?: string | null; occasion?: string | null } = {}) =>
      mutateContext((request) => startActiveSession(request, input)),
    [mutateContext],
  );

  const resumeSession = useCallback(async () => {
    hydrate();
  }, [hydrate]);

  const setAnchor = useCallback(
    (closetItemId: string) =>
      mutateContext((request) => updateActiveSession(request, { anchorClosetItemId: closetItemId })),
    [mutateContext],
  );

  const clearAnchor = useCallback(
    () => mutateContext((request) => updateActiveSession(request, { anchorClosetItemId: null })),
    [mutateContext],
  );

  const setOccasion = useCallback(
    (occasion: string) => mutateContext((request) => updateActiveSession(request, { occasion })),
    [mutateContext],
  );

  const clearOccasion = useCallback(
    () => mutateContext((request) => updateActiveSession(request, { occasion: null })),
    [mutateContext],
  );

  const discardSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      const result = await discardActiveSession(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setSession({ actorKey, result });
      // The composition is already invalid by status fingerprint; cleanup is
      // best-effort and the discard stays authoritative if it fails.
      setComposition({ ...IDLE_COMPOSITION, actorKey });
      await discardCompositionSet(actorRequest);
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy]);

  const resetSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      const result = await resetCorruptSession(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setSession({ actorKey, result });
      setComposition({ ...IDLE_COMPOSITION, actorKey });
      await discardCompositionSet(actorRequest);
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy]);

  /** Persist which option is current. Never alters a look's contents. */
  const selectLook = useCallback(
    async (lookId: string) => {
      if (busy) return;
      const record = view.session;
      if (!record) return;
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const fingerprint = buildCompositionFingerprint({
          actorId: record.actorId,
          sessionId: record.sessionId,
          status: record.status,
          anchorClosetItemId: record.anchorClosetItemId,
          occasion: record.occasion,
        });
        const result = await setActiveLook(actorRequest, { lookId, expectedFingerprint: fingerprint });
        if (!isActorRequestCurrent(actorRequest)) return;
        if (result.stale) {
          setComposition({
            actorKey,
            status: 'stale',
            composition: null,
            errorCode: 'COMPOSITION_STALE',
            recovered: false,
          });
          return;
        }
        if (!result.ok) {
          setComposition((previous) => ({
            ...previous,
            errorCode: 'PERSISTENCE_FAILED',
          }));
          return;
        }
        setComposition({
          actorKey,
          status: current.status === 'partial' ? 'partial' : 'ready',
          composition: result.composition,
          errorCode: null,
          recovered: false,
        });
      } finally {
        setBusy(false);
      }
    },
    [actorKey, busy, current.status, view.session],
  );

  /**
   * User-initiated rebuild.
   *
   * Deterministic: the same inputs produce the same outfits, so this is offered
   * only when the current composition is stale, corrupt or absent — never as a
   * "shuffle" on a valid one.
   */
  const rebuildOutfits = useCallback(async () => {
    if (busy) return;
    const record = view.session;
    if (!record) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    const isCurrent = () => isActorRequestCurrent(actorRequest);
    const previous = current;
    try {
      setComposition({ ...IDLE_COMPOSITION, actorKey, status: 'building' });
      await discardCompositionSet(actorRequest);
      if (!isCurrent()) return;

      const items = closet.actorKey === actorKey ? closet.items : [];
      const closetOk = closet.actorKey === actorKey && closet.status === 'loaded';
      const next = await composeAndPersist(actorRequest, record, items, closetOk, isCurrent);
      if (!isCurrent()) return;
      // A failed rebuild restores the state the user was looking at rather than
      // leaving an empty workspace behind.
      const rebuildFailed = next.status === 'failed' && next.composition === null;
      setComposition(rebuildFailed ? { ...previous, errorCode: next.errorCode } : next);
    } finally {
      setBusy(false);
    }
  }, [actorKey, busy, closet, composeAndPersist, current, view.session]);

  /** Explicit reset of a corrupt composition. The SESSION is never touched. */
  const resetComposition = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    const actorRequest = createActorRequest();
    try {
      await resetCorruptComposition(actorRequest);
      if (!isActorRequestCurrent(actorRequest)) return;
      setComposition({ ...IDLE_COMPOSITION, actorKey });
    } finally {
      setBusy(false);
    }
    hydrate();
  }, [actorKey, busy, hydrate]);

  /** Repeat the failed operation without altering session context. */
  const retry = useCallback(() => {
    hydrate();
  }, [hydrate]);

  /**
   * Apply a route-supplied Closet item ONCE, and only after everything it is
   * validated against has loaded. `routeAppliedRef` is what stops a focus
   * revalidation from re-writing an anchor the user has since changed.
   */
  useEffect(() => {
    const intent = resolveRouteAnchorIntent(view, routeClosetItemId);
    if (!intent || routeAppliedRef.current === intent || busy) return;
    routeAppliedRef.current = intent;
    if (view.status === 'active') void setAnchor(intent);
    else void startSession({ anchorClosetItemId: intent });
  }, [view, routeClosetItemId, busy, setAnchor, startSession]);

  return {
    ...view,
    busy,
    compositionStatus: current.status,
    compositionError: current.errorCode,
    compositionRecovered: current.recovered,
    looks,
    activeLookId: current.composition?.activeLookId ?? null,
    startSession,
    resumeSession,
    setAnchor,
    clearAnchor,
    setOccasion,
    clearOccasion,
    discardSession,
    resetSession,
    selectLook,
    rebuildOutfits,
    retry,
    resetComposition,
    revalidate: hydrate,
  };
}
