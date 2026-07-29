/**
 * Route-level view model for the private Dressing Room workspace.
 *
 * A THIN wrapper. Every ordering rule lives in
 * services/privateDressingRoomCoordinator.ts (pure, tested without a renderer)
 * and every write lives in services/privateDressingRoomSessionStore.ts (atomic,
 * actor-guarded). This file gathers React state and wires the two together.
 *
 * ACTOR SAFETY mirrors hooks/useCloset.js exactly: results are held in an
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
import { loadCloset } from '../services/closetLibrary';
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
  resolvePrivateWorkspaceView,
  resolveRouteAnchorIntent,
} from '../services/privateDressingRoomCoordinator';
import type {
  ClosetLoadStatus,
  PrivateWorkspaceView,
} from '../services/privateDressingRoomCoordinator';

/**
 * Lightweight active-session probe for entry points.
 *
 * Reads the private session domain and nothing else — no Closet load, no
 * projection work, and emphatically no collaborative room state. It exists so
 * the Stylist entry can say "Resume" instead of "Start" without mounting the
 * whole workspace, and it never mutates.
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

export function usePrivateDressingRoom(routeClosetItemId?: unknown): PrivateWorkspaceView & {
  busy: boolean;
  startSession: (input?: { anchorClosetItemId?: string | null; occasion?: string | null }) => Promise<void>;
  resumeSession: () => Promise<void>;
  setAnchor: (closetItemId: string) => Promise<void>;
  clearAnchor: () => Promise<void>;
  setOccasion: (occasion: string) => Promise<void>;
  clearOccasion: () => Promise<void>;
  discardSession: () => Promise<void>;
  resetSession: () => Promise<void>;
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
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(0);
  const routeAppliedRef = useRef<string | null>(null);

  /**
   * Read the Closet and the session for the CURRENT actor.
   *
   * Both reads share one generation token, so a stale pair can never be
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

    void (async () => {
      let items: ClosetItemProjection[] = [];
      let status: ClosetLoadStatus = 'loaded';
      try {
        items = getClosetItemProjections(await loadCloset(actorId));
      } catch {
        // `loadCloset` fails soft to [] internally, so this branch is reached
        // only when the call itself rejects. See the note on ClosetLoadStatus.
        status = 'failed';
        items = [];
      }
      if (!isCurrent()) return;
      setCloset({ actorKey, status, items });

      const result = await loadActiveSession(actorRequest);
      if (!isCurrent()) return;
      setSession({ actorKey, result });
    })();

    return () => {
      live = false;
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [actorId, actorKey, actorLoading]);

  // Route focus: the established route-scoped revalidation seam (useCloset.js).
  useFocusEffect(hydrate);

  /**
   * Returning to the foreground revalidates the same way a focus does.
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

  /** An actor transition invalidates both snapshots and any pending work. */
  useEffect(() => {
    generationRef.current += 1;
    routeAppliedRef.current = null;
    setCloset({ actorKey: null, status: 'loading', items: [] });
    setSession({ actorKey: null, result: null });
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

  /**
   * Run one mutation under a fresh actor request.
   *
   * A result that arrives after an actor change is dropped rather than rendered,
   * which is the UI half of the guarantee the store already enforces on disk.
   */
  const run = useCallback(
    async (operation: (request: unknown) => Promise<PrivateSessionResult>) => {
      if (busy) return;
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await operation(actorRequest);
        if (!isActorRequestCurrent(actorRequest)) return;
        setSession({ actorKey, result });
      } finally {
        setBusy(false);
      }
    },
    [actorKey, busy],
  );

  const startSession = useCallback(
    (input: { anchorClosetItemId?: string | null; occasion?: string | null } = {}) =>
      run((request) => startActiveSession(request, input)),
    [run],
  );

  const resumeSession = useCallback(
    () => run((request) => loadActiveSession(request)),
    [run],
  );

  const setAnchor = useCallback(
    (closetItemId: string) =>
      run((request) => updateActiveSession(request, { anchorClosetItemId: closetItemId })),
    [run],
  );

  const clearAnchor = useCallback(
    () => run((request) => updateActiveSession(request, { anchorClosetItemId: null })),
    [run],
  );

  const setOccasion = useCallback(
    (occasion: string) => run((request) => updateActiveSession(request, { occasion })),
    [run],
  );

  const clearOccasion = useCallback(
    () => run((request) => updateActiveSession(request, { occasion: null })),
    [run],
  );

  const discardSession = useCallback(
    () => run((request) => discardActiveSession(request)),
    [run],
  );

  const resetSession = useCallback(
    () => run((request) => resetCorruptSession(request)),
    [run],
  );

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
    startSession,
    resumeSession,
    setAnchor,
    clearAnchor,
    setOccasion,
    clearOccasion,
    discardSession,
    resetSession,
    revalidate: hydrate,
  };
}
