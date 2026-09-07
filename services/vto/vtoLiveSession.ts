/**
 * Live VTO session state -- the application's view of a running Live runtime.
 *
 * TWO HALVES, DELIBERATELY SEPARATE. `reduceLiveVtoSession` is a pure
 * reducer over the high-level event contract: no native handle, no React, no
 * I/O, so the whole session lifecycle can be exercised exhaustively without a
 * device -- which matters because no device can run it yet.
 * `createLiveVtoSession` is the thin controller that wires the native module's
 * events into that reducer and its commands out.
 *
 * HIGH-LEVEL ONLY. The reducer's entire input vocabulary is
 * `LIVE_VTO_EVENTS`. There is no frame event, no mask event and no pose
 * event to handle, and every inbound payload passes `normalizeLiveVtoEvent`'s
 * recursive raw-data check before reaching here. Anything carrying camera
 * frames, masks, landmarks or a body proxy is DROPPED -- not rendered and not
 * logged, because logging camera-derived data is exactly what the privacy
 * boundary forbids.
 *
 * NO PROVIDER ERROR TEXT. A `fatalError` event carries a state enum, never a
 * message; the customer-facing copy comes from `toLiveVtoRuntimeError`, which
 * discards any native detail it is handed.
 *
 * NOTHING HERE TALKS TO THE NETWORK. The Photoreal handoff lives in
 * services/vto/vtoPhotorealHandoff.ts and runs only on an explicit user
 * action; a session cannot start one on its own, because it has no way to.
 */

import {
  normalizeLiveVtoEvent,
  sendLiveVtoCommand,
  type LiveVtoNativeModule,
} from './liveVtoNativeModule';
import {
  toLiveVtoRuntimeError,
  type LiveVtoCapturedFrame,
  type LiveVtoEvent,
  type LiveVtoGarmentDescriptor,
  type LiveVtoGarmentStatus,
  type LiveVtoGuidance,
  type LiveVtoPrivacyPhase,
  type LiveVtoRuntimeError,
  type LiveVtoRuntimeErrorState,
  type LiveVtoSessionState,
} from '../../types/vtoLive';

export interface LiveVtoSessionSnapshot {
  state: LiveVtoSessionState;
  /** Bounded, K Scan-authored copy. Never provider or ML text. */
  error: LiveVtoRuntimeError | null;
  /** productRef of the garment the runtime reports it has loaded. */
  loadedProductRef: string | null;
  /** Coarse framing hint while tracking is weak. Never geometry. */
  guidance: LiveVtoGuidance;
  privacyPhase: LiveVtoPrivacyPhase;
  /**
   * THE CAPTURE AUTHORITY (Section 14). Every customer capture control binds
   * to THIS and to nothing else -- see `deriveCaptureReady` below for the
   * four conditions and why each one is required.
   */
  captureReady: boolean;
  /** Section 18's garment lifecycle. */
  garmentStatus: LiveVtoGarmentStatus;
  /**
   * productRef of the garment a load/switch command is currently in flight
   * for, or null when nothing is pending. This identity is what makes a STALE
   * completion DETECTABLE rather than merely unlikely.
   */
  pendingProductRef: string | null;
  /**
   * The runtime's own last answer to "is a clean person frame buffered right
   * now". Held separately from `captureReady` because they are different
   * facts: this is native evidence, `captureReady` is the whole rule.
   */
  nativeCaptureReady: boolean;
}

export const INITIAL_LIVE_VTO_SESSION: LiveVtoSessionSnapshot = Object.freeze({
  state: 'INITIALIZING' as LiveVtoSessionState,
  error: null,
  loadedProductRef: null,
  guidance: 'none' as LiveVtoGuidance,
  privacyPhase: 'live' as LiveVtoPrivacyPhase,
  captureReady: false,
  garmentStatus: 'IDLE' as LiveVtoGarmentStatus,
  pendingProductRef: null,
  nativeCaptureReady: false,
});

/**
 * THE CAPTURE-READINESS RULE, in one place (Section 14).
 *
 *   SESSION VALID          a tracking state, not ERROR and not INITIALIZING
 * + TRACKING SUFFICIENT    the runtime says it is TRACKING -- not weak, not
 *                          lost, not still acquiring
 * + PERSON FRAME AVAILABLE the runtime's own `captureReady` from the last
 *                          tracking event; absent reads as false
 * + NO ACTIVE INVALIDATION no garment load in flight and no garment failure,
 *                          so what is drawn is what the customer chose
 *   -> CAPTURE READY
 *
 * RECOMPUTED, NEVER LATCHED. Every reducer branch runs this again over the
 * snapshot it just produced, so readiness cannot outlive the condition that
 * granted it: a tracking loss, a fatal error, a garment switch, or a runtime
 * that stops reporting a buffered frame each withdraw it on the very event
 * that carries the bad news -- not on some later cleanup pass.
 */
export function deriveCaptureReady(snapshot: LiveVtoSessionSnapshot): boolean {
  if (snapshot.state !== 'TRACKING' && snapshot.state !== 'CAPTURE_READY') return false;
  if (snapshot.error) return false;
  if (snapshot.nativeCaptureReady !== true) return false;
  // A garment that is loading, or that failed to load, is an active
  // invalidation: whatever the runtime is drawing is not what was chosen.
  if (snapshot.garmentStatus !== 'RENDERED') return false;
  return true;
}

/** Applies the rule to a freshly-reduced snapshot. One call site per branch,
 *  so no branch can forget it. */
function withCaptureReady(snapshot: LiveVtoSessionSnapshot): LiveVtoSessionSnapshot {
  const captureReady = deriveCaptureReady(snapshot);
  return captureReady === snapshot.captureReady ? snapshot : { ...snapshot, captureReady };
}

/** The runtime's readiness answer, read fail-closed: anything that is not an
 *  explicit `true` is a no. */
function readNativeCaptureReady(payload: unknown): boolean {
  return (payload as { captureReady?: unknown } | null)?.captureReady === true;
}

/**
 * The reducer.
 *
 * ERROR IS STICKY UNTIL SOMETHING GOOD HAPPENS. Once in ERROR the session
 * stays there until an event that genuinely indicates recovery arrives
 * ('ready', 'trackingAcquired', 'trackingRecovered', 'garmentLoaded') -- a
 * stray tracking-weak from a dying runtime must not read as "we're fine now".
 */
export function reduceLiveVtoSession(
  current: LiveVtoSessionSnapshot,
  event: LiveVtoEvent,
): LiveVtoSessionSnapshot {
  switch (event.type) {
    case 'ready':
      return withCaptureReady({ ...current, state: 'READY', error: null, guidance: 'none' });

    case 'garmentLoaded': {
      const payload = event.payload as { productRef?: unknown };
      const productRef = typeof payload?.productRef === 'string' ? payload.productRef : null;

      // STALE COMPLETION REJECTION (Section 53). The runtime reports what it
      // finished loading; the app knows what it last ASKED for. When those
      // disagree, this completion belongs to a garment the customer already
      // moved on from -- accepting it would report SUCCESS for the wrong
      // product, leave `loadedProductRef` naming a garment that is no longer
      // on screen, and (through `deriveCaptureReady`) hand the capture
      // control back for a session still loading something else.
      //
      // Only an ACTIVE disagreement rejects. With nothing pending there is
      // nothing to be stale relative to, and the runtime's report is simply
      // the truth about what it has -- which is the ordinary first-load case.
      if (current.pendingProductRef && productRef && productRef !== current.pendingProductRef) {
        return current;
      }

      return withCaptureReady({
        ...current,
        state: 'READY',
        error: null,
        loadedProductRef: productRef ?? current.loadedProductRef,
        garmentStatus: 'RENDERED',
        pendingProductRef: null,
      });
    }

    case 'trackingAcquired':
      return withCaptureReady({
        ...current,
        state: 'TRACKING',
        error: null,
        guidance: 'none',
        nativeCaptureReady: readNativeCaptureReady(event.payload),
      });

    case 'trackingRecovered':
      return withCaptureReady({
        ...current,
        state: 'TRACKING',
        error: null,
        guidance: 'none',
        nativeCaptureReady: readNativeCaptureReady(event.payload),
      });

    case 'trackingWeak': {
      if (current.state === 'ERROR') return current;
      const payload = event.payload as { guidance?: unknown };
      return withCaptureReady({
        ...current,
        state: 'TRACKING_WEAK',
        guidance: typeof payload?.guidance === 'string'
          ? (payload.guidance as LiveVtoGuidance)
          : 'none',
        nativeCaptureReady: readNativeCaptureReady(event.payload),
      });
    }

    case 'trackingLost':
      if (current.state === 'ERROR') return current;
      return withCaptureReady({
        ...current,
        state: 'TRACKING_LOST',
        guidance: 'none',
        nativeCaptureReady: readNativeCaptureReady(event.payload),
      });

    case 'captureReady':
      if (current.state === 'ERROR') return current;
      return withCaptureReady({ ...current, state: 'CAPTURE_READY' });

    case 'privacyStateChanged': {
      const payload = event.payload as { phase?: unknown };
      return {
        ...current,
        privacyPhase: typeof payload?.phase === 'string'
          ? (payload.phase as LiveVtoPrivacyPhase)
          : current.privacyPhase,
      };
    }

    case 'performanceChanged':
      // Reported for diagnostics; it never changes what the customer sees, and
      // there is deliberately no automatic quality-downgrade policy here.
      return current;

    case 'fatalError': {
      const payload = event.payload as { state?: unknown };
      const state = payload?.state as LiveVtoRuntimeErrorState;
      // GARMENT_UNSUPPORTED is the runtime's report that the load it was
      // asked for FAILED, so the garment lifecycle has to record that
      // (Section 18's FAILED) rather than leave the surface showing LOADING
      // for a load that will never complete. Every other fatal state is a
      // session-level failure and leaves the garment lifecycle where it was:
      // a camera that died did not un-load the garment.
      const garmentFailed = state === 'GARMENT_UNSUPPORTED';
      return withCaptureReady({
        ...current,
        state: 'ERROR',
        error: toLiveVtoRuntimeError(state),
        nativeCaptureReady: false,
        garmentStatus: garmentFailed ? 'FAILED' : current.garmentStatus,
        pendingProductRef: garmentFailed ? null : current.pendingProductRef,
      });
    }

    default:
      return current;
  }
}

/**
 * Applied when a load/switch command is issued, so the surface can show a
 * loading state without waiting for the runtime to say anything.
 *
 * SELECTION IS ACKNOWLEDGED IMMEDIATELY (Section 18). `pendingProductRef` is
 * recorded HERE, at the moment the command goes out, which is what gives a
 * later `garmentLoaded` something to be checked against. It also withdraws
 * capture readiness on the spot: between asking for garment B and B being
 * confirmed, whatever is on screen is still A, and a capture taken in that
 * window would be attributed to the wrong product.
 */
export function markGarmentLoading(
  current: LiveVtoSessionSnapshot,
  productRef?: string | null,
): LiveVtoSessionSnapshot {
  return withCaptureReady({
    ...current,
    state: 'GARMENT_LOADING',
    error: null,
    garmentStatus: 'LOADING',
    pendingProductRef: productRef ?? current.pendingProductRef,
    nativeCaptureReady: false,
  });
}

/** The customer's choice, acknowledged before anything is sent. Distinct from
 *  LOADING so a surface can say "selected" the instant it is tapped even if
 *  the runtime is momentarily unable to accept a command. */
export function markGarmentSelected(
  current: LiveVtoSessionSnapshot,
  productRef: string,
): LiveVtoSessionSnapshot {
  return withCaptureReady({
    ...current,
    garmentStatus: 'SELECTED',
    pendingProductRef: productRef,
    nativeCaptureReady: false,
  });
}

/** Applied when the app itself decides the session cannot proceed -- a denied
 *  permission, a missing module -- without any native event having arrived. */
export function markLiveVtoError(
  current: LiveVtoSessionSnapshot,
  state: LiveVtoRuntimeErrorState,
): LiveVtoSessionSnapshot {
  return withCaptureReady({
    ...current,
    state: 'ERROR',
    error: toLiveVtoRuntimeError(state),
    nativeCaptureReady: false,
    garmentStatus: state === 'GARMENT_UNSUPPORTED' ? 'FAILED' : current.garmentStatus,
  });
}

// ─── Controller ──────────────────────────────────────────────────────────────

export interface LiveVtoSessionController {
  getSnapshot(): LiveVtoSessionSnapshot;
  subscribe(listener: (snapshot: LiveVtoSessionSnapshot) => void): () => void;
  start(descriptor: LiveVtoGarmentDescriptor): void;
  switchGarment(descriptor: LiveVtoGarmentDescriptor): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** The ONLY capture that may feed the generative path. */
  capturePersonFrame(): Promise<LiveVtoCapturedFrame | null>;
  /** A composited preview, for local display only. Never a generative input --
   *  assertCleanPersonFrame refuses it at the handoff. */
  capturePreview(): Promise<LiveVtoCapturedFrame | null>;
  dispose(): void;
}

/**
 * Wires one native module instance to one reducer.
 *
 * Per-session rather than module-scoped on purpose: a Live session is bound to
 * one surface and one actor, and a module-global would outlive both. The
 * generative store is module-scoped for the opposite and equally deliberate
 * reason -- a generation must survive its surface (see vtoRequestStore.ts).
 */
export function createLiveVtoSession(
  nativeModule: LiveVtoNativeModule | null,
): LiveVtoSessionController {
  let snapshot: LiveVtoSessionSnapshot = INITIAL_LIVE_VTO_SESSION;
  const listeners = new Set<(next: LiveVtoSessionSnapshot) => void>();
  let subscription: { remove(): void } | null = null;
  let disposed = false;

  function emit(next: LiveVtoSessionSnapshot): void {
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A listener must never corrupt the session.
      }
    }
  }

  function handleRaw(raw: unknown): void {
    if (disposed) return;
    const event = normalizeLiveVtoEvent(raw);
    // null means malformed OR carrying forbidden raw live data. Both are
    // dropped silently -- see the module header on why not logged.
    if (!event) return;
    emit(reduceLiveVtoSession(snapshot, event));
  }

  function ensureSubscribed(): void {
    if (subscription || !nativeModule || typeof nativeModule.addListener !== 'function') return;
    try {
      subscription = nativeModule.addListener('liveVtoEvent', handleRaw);
    } catch {
      subscription = null;
    }
  }

  async function capture(
    kind: 'capturePersonFrame' | 'capturePreview',
  ): Promise<LiveVtoCapturedFrame | null> {
    if (!nativeModule || typeof nativeModule[kind] !== 'function') return null;
    try {
      const frame = await nativeModule[kind]();
      if (!frame || typeof frame !== 'object' || typeof frame.captureId !== 'string') return null;
      return frame;
    } catch {
      return null;
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(descriptor) {
      if (disposed) return;
      ensureSubscribed();
      if (!nativeModule) {
        emit(markLiveVtoError(snapshot, 'MODULE_MISSING'));
        return;
      }
      emit(markGarmentLoading(snapshot, descriptor.productRef));
      const started = sendLiveVtoCommand(nativeModule, (target) => {
        target.start();
        target.loadGarment(descriptor);
      });
      if (!started) emit(markLiveVtoError(snapshot, 'RUNTIME_INITIALIZATION_FAILED'));
    },
    switchGarment(descriptor) {
      if (disposed || !nativeModule) return;
      // The customer's choice is acknowledged, then the load starts. Both
      // steps record the SAME `pendingProductRef`, which is what a later
      // completion is checked against: a `garmentLoaded` naming the garment
      // this switch replaced is a stale completion and the reducer drops it
      // (Section 53). Without that identity, a slow load of A completing
      // after a switch to B reported success, cleared the loading state, and
      // left the surface claiming B while the runtime still drew A.
      emit(markGarmentSelected(snapshot, descriptor.productRef));
      emit(markGarmentLoading(snapshot, descriptor.productRef));
      const switched = sendLiveVtoCommand(nativeModule, (target) => target.switchGarment(descriptor));
      if (!switched) emit(markLiveVtoError(snapshot, 'GARMENT_UNSUPPORTED'));
    },
    pause() {
      sendLiveVtoCommand(nativeModule, (target) => target.pause());
    },
    resume() {
      sendLiveVtoCommand(nativeModule, (target) => target.resume());
    },
    stop() {
      sendLiveVtoCommand(nativeModule, (target) => target.stop());
    },
    capturePersonFrame: () => capture('capturePersonFrame'),
    capturePreview: () => capture('capturePreview'),
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        subscription?.remove();
      } catch {
        // Nothing useful to do; the session is going away regardless.
      }
      subscription = null;
      listeners.clear();
      sendLiveVtoCommand(nativeModule, (target) => target.dispose());
    },
  };
}
