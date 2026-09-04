/**
 * React binding for one Live VTO session.
 *
 * WHERE THE CAMERA PROMPT LIVES. `enterLive` is the single place a camera
 * permission dialog can be raised, and it is called only from an explicit
 * customer action on a surface the router has already said is Live-capable.
 * Opening Try It On does not reach here; selecting AI Photo does not reach
 * here; a garment Live cannot render does not reach here. A denial is not an
 * error path -- it settles the session into a bounded state and the caller
 * stays on AI Photo, which remains fully usable.
 *
 * SAFE FAILURE, NOT A CRASH. Every native interaction is already wrapped at
 * the adapter boundary (services/vto/liveVtoNativeModule.ts) and every
 * unexpected state resolves to a bounded LiveVtoRuntimeError with K Scan copy.
 * A Live problem may cost the customer Live; it may never cost them the sheet.
 *
 * PHOTOREAL IS EXPLICIT, ALWAYS. `requestPhotoreal` advances the intent state
 * machine and captures a CLEAN person frame; nothing else in this hook can
 * reach the generative path, and no timer, tracking event, or performance
 * signal is an input to it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getLiveVtoNativeModule } from '../services/vto/liveVtoNativeModule';
import { ensureLiveCameraPermission } from '../services/vto/vtoLiveCameraPermission';
import { getLiveVtoHarnessState } from '../services/vto/vtoLiveHarness';
import { buildPhotorealPersonInput } from '../services/vto/vtoPhotorealHandoff';
import {
  createLiveVtoSession,
  INITIAL_LIVE_VTO_SESSION,
  markLiveVtoError,
  type LiveVtoSessionController,
  type LiveVtoSessionSnapshot,
} from '../services/vto/vtoLiveSession';
import {
  advancePhotorealIntent,
  handlePhotorealFailure,
  returnToLive,
  type LiveVtoGarmentDescriptor,
  type PhotorealFailureOutcome,
  type PhotorealIntentState,
} from '../types/vtoLive';
import type { VtoPersonInput } from '../types/vto';

export interface UseVtoLiveSessionArgs {
  descriptor: LiveVtoGarmentDescriptor | null;
  /** Called with the clean person input once a Photoreal capture succeeds.
   *  The caller drives the ORDINARY generative flow with it -- this hook never
   *  contacts the backend itself. */
  onPhotorealPerson: (person: VtoPersonInput) => void;
}

export interface UseVtoLiveSessionResult {
  session: LiveVtoSessionSnapshot;
  photorealIntent: PhotorealIntentState;
  photorealFailure: PhotorealFailureOutcome | null;
  entered: boolean;
  /** Local URI of the most recent composited preview the customer captured, or
   *  null. Held so the control has a visible result -- a capture button that
   *  silently discards what it captured is not a working control. It is a
   *  local display artifact ONLY: assertCleanPersonFrame refuses a PREVIEW at
   *  the generative handoff, and nothing persists it. */
  previewUri: string | null;
  /** Requests permission if needed, then starts the runtime. The ONLY path
   *  that can raise a camera dialog. */
  enterLive: () => Promise<void>;
  exitLive: () => void;
  requestPhotoreal: () => Promise<void>;
  /** Local-only composited still. Never a generative input. */
  capturePreview: () => Promise<string | null>;
  dismissPhotorealFailure: () => void;
}

export function useVtoLiveSession(args: UseVtoLiveSessionArgs): UseVtoLiveSessionResult {
  const [snapshot, setSnapshot] = useState<LiveVtoSessionSnapshot>(INITIAL_LIVE_VTO_SESSION);
  const [entered, setEntered] = useState(false);
  const [photorealIntent, setPhotorealIntent] = useState<PhotorealIntentState>('LIVE_LOCAL');
  const [photorealFailure, setPhotorealFailure] = useState<PhotorealFailureOutcome | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const controllerRef = useRef<LiveVtoSessionController | null>(null);
  const onPhotorealPersonRef = useRef(args.onPhotorealPerson);
  onPhotorealPersonRef.current = args.onPhotorealPerson;

  const descriptor = args.descriptor;

  // Unmount disposes the runtime. A Live session is bound to its surface: it
  // holds a camera, so leaving it running behind a closed sheet is not a
  // performance question, it is a privacy one.
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  const enterLive = useCallback(async () => {
    if (!descriptor || controllerRef.current) return;

    const harness = getLiveVtoHarnessState();
    const permission = harness
      ? { state: harness.cameraPermission, prompted: false }
      : await ensureLiveCameraPermission();

    if (permission.state !== 'granted') {
      // Bounded, non-fatal: the caller keeps AI Photo on offer and we do not
      // ask again. See services/vto/vtoLiveCameraPermission.ts.
      setEntered(true);
      setSnapshot((current) =>
        markLiveVtoError(
          current,
          permission.state === 'denied' ? 'CAMERA_PERMISSION_DENIED' : 'CAMERA_UNAVAILABLE',
        ),
      );
      return;
    }

    const controller = createLiveVtoSession(getLiveVtoNativeModule());
    controllerRef.current = controller;
    controller.subscribe(setSnapshot);
    setEntered(true);
    controller.start(descriptor);
    setSnapshot(controller.getSnapshot());
  }, [descriptor]);

  const exitLive = useCallback(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    setEntered(false);
    setPhotorealIntent(returnToLive());
    setPhotorealFailure(null);
    // The preview is a session artifact and does not outlive the session.
    setPreviewUri(null);
    setSnapshot(INITIAL_LIVE_VTO_SESSION);
  }, []);

  // A garment change while Live is running is a switch, never a restart: the
  // runtime keeps the camera and swaps the asset, and the product identity
  // stays the one the customer was already looking at.
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !descriptor) return;
    if (loadedRef.current === null) {
      loadedRef.current = descriptor.productRef;
      return;
    }
    if (loadedRef.current === descriptor.productRef) return;
    loadedRef.current = descriptor.productRef;
    controller.switchGarment(descriptor);
  }, [descriptor]);

  const requestPhotoreal = useCallback(async () => {
    const controller = controllerRef.current;
    setPhotorealFailure(null);

    const harness = getLiveVtoHarnessState();
    if (harness?.photorealUnavailable) {
      // Simulated unavailability. The session deliberately survives it.
      setPhotorealFailure(handlePhotorealFailure('provider_unavailable'));
      setPhotorealIntent(returnToLive());
      return;
    }

    if (!controller) {
      setPhotorealFailure(handlePhotorealFailure('no_usable_still'));
      return;
    }

    // Explicit consent step, then the capture, then handoff-ready. Each is a
    // separate transition requiring this user-initiated call to have happened.
    const consent = advancePhotorealIntent('LIVE_LOCAL');
    if (consent.ok) setPhotorealIntent(consent.to);

    const frame = await controller.capturePersonFrame();
    if (!frame) {
      setPhotorealFailure(handlePhotorealFailure('no_usable_still'));
      setPhotorealIntent(returnToLive());
      return;
    }

    const outcome = await buildPhotorealPersonInput(frame);
    if (outcome.ok === false) {
      setPhotorealFailure(outcome.failure);
      setPhotorealIntent(outcome.failure.resultingState);
      return;
    }

    setPhotorealIntent('GENERATIVE_HANDOFF_READY');
    onPhotorealPersonRef.current(outcome.person);
  }, []);

  const capturePreview = useCallback(async () => {
    const frame = await controllerRef.current?.capturePreview();
    const uri = frame?.localUri ?? null;
    setPreviewUri(uri);
    return uri;
  }, []);

  const dismissPhotorealFailure = useCallback(() => {
    setPhotorealFailure(null);
    setPhotorealIntent(returnToLive());
  }, []);

  return useMemo(
    () => ({
      session: snapshot,
      photorealIntent,
      photorealFailure,
      entered,
      previewUri,
      enterLive,
      exitLive,
      requestPhotoreal,
      capturePreview,
      dismissPhotorealFailure,
    }),
    [
      snapshot,
      photorealIntent,
      photorealFailure,
      entered,
      previewUri,
      enterLive,
      exitLive,
      requestPhotoreal,
      capturePreview,
      dismissPhotorealFailure,
    ],
  );
}
