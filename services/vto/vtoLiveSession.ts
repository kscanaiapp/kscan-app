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
}

export const INITIAL_LIVE_VTO_SESSION: LiveVtoSessionSnapshot = Object.freeze({
  state: 'INITIALIZING' as LiveVtoSessionState,
  error: null,
  loadedProductRef: null,
  guidance: 'none' as LiveVtoGuidance,
  privacyPhase: 'live' as LiveVtoPrivacyPhase,
});

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
      return { ...current, state: 'READY', error: null, guidance: 'none' };

    case 'garmentLoaded': {
      const payload = event.payload as { productRef?: unknown };
      return {
        ...current,
        state: 'READY',
        error: null,
        loadedProductRef:
          typeof payload?.productRef === 'string' ? payload.productRef : current.loadedProductRef,
      };
    }

    case 'trackingAcquired':
      return { ...current, state: 'TRACKING', error: null, guidance: 'none' };

    case 'trackingRecovered':
      return { ...current, state: 'TRACKING', error: null, guidance: 'none' };

    case 'trackingWeak': {
      if (current.state === 'ERROR') return current;
      const payload = event.payload as { guidance?: unknown };
      return {
        ...current,
        state: 'TRACKING_WEAK',
        guidance: typeof payload?.guidance === 'string'
          ? (payload.guidance as LiveVtoGuidance)
          : 'none',
      };
    }

    case 'trackingLost':
      if (current.state === 'ERROR') return current;
      return { ...current, state: 'TRACKING_LOST', guidance: 'none' };

    case 'captureReady':
      if (current.state === 'ERROR') return current;
      return { ...current, state: 'CAPTURE_READY' };

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
      return { ...current, state: 'ERROR', error: toLiveVtoRuntimeError(state) };
    }

    default:
      return current;
  }
}

/** Applied when a load/switch command is issued, so the surface can show a
 *  loading state without waiting for the runtime to say anything. */
export function markGarmentLoading(current: LiveVtoSessionSnapshot): LiveVtoSessionSnapshot {
  return { ...current, state: 'GARMENT_LOADING', error: null };
}

/** Applied when the app itself decides the session cannot proceed -- a denied
 *  permission, a missing module -- without any native event having arrived. */
export function markLiveVtoError(
  current: LiveVtoSessionSnapshot,
  state: LiveVtoRuntimeErrorState,
): LiveVtoSessionSnapshot {
  return { ...current, state: 'ERROR', error: toLiveVtoRuntimeError(state) };
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
      emit(markGarmentLoading(snapshot));
      const started = sendLiveVtoCommand(nativeModule, (target) => {
        target.start();
        target.loadGarment(descriptor);
      });
      if (!started) emit(markLiveVtoError(snapshot, 'RUNTIME_INITIALIZATION_FAILED'));
    },
    switchGarment(descriptor) {
      if (disposed || !nativeModule) return;
      emit(markGarmentLoading(snapshot));
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
