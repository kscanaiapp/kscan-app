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
 *
 * EXPLICIT ONCE, NOT EXPLICIT REPEATEDLY. Both `enterLive` and
 * `requestPhotoreal` await before they commit anything, and their controls stay
 * enabled across that await, so each carries an in-flight guard (VTO-HA-002,
 * VTO-HA-003). Without them a second tap during the first tap's await started a
 * second Live session and, worse, a second GENERATION: `requestPhotoreal`
 * captures a fresh frame and calls `adoptPerson`, and `setVtoPersonInput`
 * advances the store's intent sequence -- so the two requests carried different
 * server idempotency keys and were billed as two attempts, defeating the very
 * duplicate-tap protection VTO-DUP-001/VTO-QUOTA-001 built for the AI Photo
 * path (where one photo and two Generate taps collapse to one paid job).
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
  /** True while a Photoreal capture/sanitize is running. Surfaced so the
   *  control can be disabled rather than silently swallowing taps -- a guard
   *  the customer cannot see is a button that looks broken. */
  photorealPending: boolean;
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
  /** Set synchronously, BEFORE the permission await, so a second tap during the
   *  dialog cannot create a second controller and orphan the first. */
  const enteringRef = useRef(false);
  /** Same shape for the Photoreal action, where the cost of a second pass is a
   *  second paid generation rather than a leaked subscription. */
  const photorealInFlightRef = useRef(false);
  /** productRef of the garment the RUNTIME has been told to load. Written where
   *  the load actually happens (enterLive / the switch effect) and cleared on
   *  teardown -- see VTO-HA-004 at the effect below. */
  const loadedRef = useRef<string | null>(null);
  const [photorealPending, setPhotorealPending] = useState(false);
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
    // `controllerRef` alone was not enough: it is only assigned AFTER the
    // permission await below, so two taps both passed it. See VTO-HA-002.
    if (!descriptor || controllerRef.current || enteringRef.current) return;
    enteringRef.current = true;
    try {
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
      // Recorded HERE, where the garment is actually loaded, rather than lazily
      // inside the switch effect below -- see VTO-HA-004.
      loadedRef.current = descriptor.productRef;
      setSnapshot(controller.getSnapshot());
    } finally {
      enteringRef.current = false;
    }
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
    // A disposed runtime has no garment loaded. Clearing this is what makes the
    // next enterLive record its own rather than inherit a stale one.
    loadedRef.current = null;
    photorealInFlightRef.current = false;
    setPhotorealPending(false);
  }, []);

  // A garment change while Live is running is a switch, never a restart: the
  // runtime keeps the camera and swaps the asset, and the product identity
  // stays the one the customer was already looking at.
  //
  // VTO-HA-004. This effect used to seed `loadedRef` itself on its first run
  // WITH a controller, returning without switching. But its first run happens
  // at mount, when there is no controller yet, and that run returns even
  // earlier -- so the seeding run was actually the first product switch AFTER
  // Live started, and that switch was swallowed. The runtime kept rendering the
  // previous product's garment while the sheet, and any Photoreal generation,
  // used the new one. `loadedRef` is now written where the garment is genuinely
  // loaded (enterLive) and cleared where it is genuinely unloaded (exitLive),
  // so this effect only has to compare.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !descriptor) return;
    if (loadedRef.current === descriptor.productRef) return;
    loadedRef.current = descriptor.productRef;
    controller.switchGarment(descriptor);
  }, [descriptor]);

  const requestPhotoreal = useCallback(async () => {
    // A second tap while the first capture/sanitize is still running would
    // capture a second frame and adopt it, which advances the store's intent
    // sequence and therefore BILLS A SECOND GENERATION. See VTO-HA-003.
    if (photorealInFlightRef.current) return;
    photorealInFlightRef.current = true;
    setPhotorealPending(true);
    try {
      await runPhotorealCapture();
    } finally {
      photorealInFlightRef.current = false;
      setPhotorealPending(false);
    }
  }, []);

  const runPhotorealCapture = useCallback(async () => {
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
      photorealPending,
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
      photorealPending,
      enterLive,
      exitLive,
      requestPhotoreal,
      capturePreview,
      dismissPhotorealFailure,
    ],
  );
}
