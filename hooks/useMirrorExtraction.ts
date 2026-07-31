// React binding for the Mirror Selfie extraction session (Build 2.5 Step 3).
//
// A THIN ADAPTER. All lifecycle, media ownership and cleanup live in
// services/mirror/mirrorExtractionSession.ts; this hook subscribes to it,
// re-renders on change, and guarantees three things React makes easy to get
// wrong:
//
//   1. a session's media is destroyed when the component unmounts, so backing
//      out of the screen cannot strand a photograph of the user's body in the
//      cache;
//   2. an actor change cancels the in-flight session immediately, rather than
//      at the next user interaction;
//   3. a late state update from a session the user already abandoned is
//      dropped instead of reviving a dead surface.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { createActorRequest, getActorContext } from '../services/actorContext';
import { MIRROR_SELFIE_V1_ACTIVE } from '../constants/featureFlags';
import { createMirrorExtractionSession } from '../services/mirror/mirrorExtractionSession';
import type {
  MirrorSessionController,
  MirrorSessionSnapshot,
} from '../services/mirror/mirrorExtractionSession';
import { reconcileStaleMirrorSessions } from '../services/mirror/mirrorSessionStorage';
import type {
  MirrorExtractionSelection,
  MirrorSourceType,
} from '../types/mirrorExtraction';

export type UseMirrorExtraction = {
  active: boolean;
  snapshot: MirrorSessionSnapshot | null;
  begin: (input: {
    sourceUri: string;
    sourceType: MirrorSourceType;
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  }) => Promise<void>;
  choosePerson: (index: number) => Promise<void>;
  setCropSelected: (cropKey: string, selected: boolean) => void;
  discardCrop: (cropKey: string) => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => Promise<void>;
  accept: () => Promise<MirrorExtractionSelection | null>;
};

export function useMirrorExtraction(
  deps: {
    resolveActive?: () => boolean;
    createSession?: typeof createMirrorExtractionSession;
    reconcile?: typeof reconcileStaleMirrorSessions;
  } = {},
): UseMirrorExtraction {
  const resolveActive = deps.resolveActive ?? (() => MIRROR_SELFIE_V1_ACTIVE);
  const createSession = deps.createSession ?? createMirrorExtractionSession;
  const reconcile = deps.reconcile ?? reconcileStaleMirrorSessions;

  const active = resolveActive() === true;
  const [snapshot, setSnapshot] = useState<MirrorSessionSnapshot | null>(null);
  const controllerRef = useRef<MirrorSessionController | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const actorEpochRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      // Unmount destroys the session's media. Leaving it for a later sweep
      // would keep the selfie on disk for as long as the TTL allows, purely
      // because the user navigated away.
      const controller = controllerRef.current;
      controllerRef.current = null;
      if (controller) void controller.cancel();
    };
  }, []);

  // App-resume reconciliation. Bounded, namespace-scoped, and never a global
  // filesystem scan — see reconcileStaleMirrorSessions.
  useEffect(() => {
    if (!active) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const current = controllerRef.current?.getSnapshot()?.extractionSessionId;
      void reconcile({
        nowMs: Date.now(),
        keepSessionIds: current ? [current] : [],
      });
    });
    return () => subscription.remove();
  }, [active, reconcile]);

  // Actor change cancels immediately, not at the next interaction.
  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => {
      const epoch = getActorContext()?.epoch ?? null;
      if (actorEpochRef.current === null) {
        actorEpochRef.current = epoch;
        return;
      }
      if (epoch !== actorEpochRef.current) {
        actorEpochRef.current = epoch;
        const controller = controllerRef.current;
        controllerRef.current = null;
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        if (controller) void controller.cancel();
        if (mountedRef.current) setSnapshot(null);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [active]);

  const attach = useCallback((controller: MirrorSessionController) => {
    unsubscribeRef.current?.();
    controllerRef.current = controller;
    unsubscribeRef.current = controller.subscribe((next) => {
      // A snapshot from a controller the hook no longer owns must not repaint
      // the screen — that is how a cancelled session appears to come back.
      if (!mountedRef.current || controllerRef.current !== controller) return;
      setSnapshot(next);
    });
    setSnapshot(controller.getSnapshot());
  }, []);

  const begin = useCallback(
    async ({
      sourceUri,
      sourceType,
      sourceWidth,
      sourceHeight,
    }: {
      sourceUri: string;
      sourceType: MirrorSourceType;
      sourceWidth?: number | null;
      sourceHeight?: number | null;
    }) => {
      if (!active) return;
      const previous = controllerRef.current;
      controllerRef.current = null;
      if (previous) await previous.cancel();

      const controller = createSession({ actorRequest: createActorRequest() });
      attach(controller);
      await controller.extractFromSource({ sourceUri, sourceType, sourceWidth, sourceHeight });
    },
    [active, attach, createSession],
  );

  const choosePerson = useCallback(async (index: number) => {
    await controllerRef.current?.choosePerson(index);
  }, []);

  const setCropSelected = useCallback((cropKey: string, selected: boolean) => {
    controllerRef.current?.setCropSelected(cropKey, selected);
  }, []);

  const discardCrop = useCallback(async (cropKey: string) => {
    await controllerRef.current?.discardCrop(cropKey);
  }, []);

  const retry = useCallback(async () => {
    await controllerRef.current?.retry();
  }, []);

  const cancel = useCallback(async () => {
    const controller = controllerRef.current;
    controllerRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (controller) await controller.cancel();
    if (mountedRef.current) setSnapshot(null);
  }, []);

  const accept = useCallback(async (): Promise<MirrorExtractionSelection | null> => {
    const controller = controllerRef.current;
    if (!controller) return null;
    const selection = await controller.acceptSelection();
    // The controller is spent either way: it has deleted the source and, on the
    // zero-selection path, the crops too.
    controllerRef.current = null;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    if (mountedRef.current) setSnapshot(null);
    return selection;
  }, []);

  return useMemo(
    () => ({ active, snapshot, begin, choosePerson, setCropSelected, discardCrop, retry, cancel, accept }),
    [active, snapshot, begin, choosePerson, setCropSelected, discardCrop, retry, cancel, accept],
  );
}
