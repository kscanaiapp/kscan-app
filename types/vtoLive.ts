/**
 * Live VTO application contract -- the promoted subset.
 *
 * WHAT THIS FILE IS. The K Scan application's view of a future Live VTO
 * native runtime: the high-level commands the app may send, the high-level
 * events it may receive, the session states a UI may render, and the
 * capture/handoff rules the privacy boundary depends on. It is a peer of
 * types/vto.ts, which stays the generative (AI Photo) contract.
 *
 * WHAT THIS FILE IS NOT. It is NOT the research workspace. PRs #291 and #295
 * (`kscan-live-vto/`) are an isolated Node workspace and are deliberately not
 * a dependency of this app -- nothing here imports them, and the production
 * bundle gains no package tree from them. Only the minimum stable definitions
 * the real client needs were promoted, recorded one by one in
 * docs/vto-live-integration-manifest.md.
 *
 * DELIBERATELY NOT PROMOTED: BodyFrame, segmentation masks, pose landmarks,
 * the body proxy, the deformation/renderer math, and the device-capability
 * thresholds. Those stay native. See FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS below
 * -- the boundary is a tested rule here, not a convention.
 *
 * NAME RECONCILIATION. #291's `nativeView.ts` predates #295's split of
 * `capture()` into `capturePersonFrame()`/`capturePreview()`, and names the
 * privacy/performance events `privacyState`/(none). The P3-C application
 * contract adopts the LATER, more specific vocabulary in both cases --
 * `capturePersonFrame`/`capturePreview`/`requestPhotorealCapture`, and
 * `privacyStateChanged`/`performanceChanged` -- rather than carrying two
 * competing sets. __tests__/vtoLiveContractPromotion.test.js pins the
 * mapping so the reconciliation cannot silently drift.
 */

// ─── Commands (app -> native) ────────────────────────────────────────────────

/**
 * The complete set of messages the application may send to a Live runtime.
 * A command not in this list has no application-side caller by construction.
 */
export const LIVE_VTO_COMMANDS = [
  'start',
  'pause',
  'resume',
  'stop',
  'loadGarment',
  'switchGarment',
  'capturePersonFrame',
  'capturePreview',
  'requestPhotorealCapture',
  'dispose',
] as const;
export type LiveVtoCommand = (typeof LIVE_VTO_COMMANDS)[number];

// ─── Events (native -> app) ──────────────────────────────────────────────────

/**
 * The complete set of messages the application may receive. Low-frequency
 * and high-level on purpose: there is no per-frame event in this list, which
 * is what makes "no continuous camera/mask/landmark data in JS" a property of
 * the contract rather than a promise about the implementation.
 */
export const LIVE_VTO_EVENTS = [
  'ready',
  'trackingAcquired',
  'trackingWeak',
  'trackingLost',
  'trackingRecovered',
  'garmentLoaded',
  'captureReady',
  'privacyStateChanged',
  'performanceChanged',
  'fatalError',
] as const;
export type LiveVtoEventName = (typeof LIVE_VTO_EVENTS)[number];

/**
 * Keys that may never appear anywhere in a Live event payload, at any depth.
 *
 * Promoted from #291's FORBIDDEN_EVENT_PAYLOAD_KEYS and widened with the
 * data-class names #291's privacy contract requires stay local during a live
 * session (LOCAL_ONLY_DURING_LIVE). Enforced recursively by
 * assertNoRawLiveData below, and exercised against a deliberately poisoned
 * payload in __tests__/vtoLivePrivacyBoundary.test.js -- a guard that has
 * never caught anything is not evidence that anything was caught.
 *
 * THE UNION IS NOW MECHANICAL, NOT MANUAL. This list must be a SUPERSET of
 * both source lists at #291's own SHA, and
 * __tests__/vtoLiveContractPromotion.test.js reads them out of
 * kscan-live-vto/ on that ref and asserts it. It is a superset rather than an
 * equality because the plural/byte spellings below ('frames', 'masks',
 * 'imageBytes') are deliberate hardening the research lane does not carry.
 *
 * VTO-HA-001. That test did not exist when this list was first written, and
 * the list was one key short of the union it claimed to be: 'lightingAnalysis'
 * -- a LOCAL_ONLY_DURING_LIVE class in #291's privacy.ts -- was absent, so a
 * payload carrying camera-derived scene analysis passed the guard and reached
 * the reducer. Transcribing a security list by hand is how that happens; the
 * repair is the test, not just the missing entry.
 */
export const FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS = [
  'frame',
  'frames',
  'pixels',
  'imageData',
  'imageBytes',
  'mask',
  'masks',
  'segmentationMask',
  'landmarks',
  'poseLandmarks',
  'bodyFrame',
  'bodyProxy',
  'pose',
  'cameraFrame',
  'faceImagery',
  'bodyImagery',
  'cameraDerivedGeometry',
  'captureReplayBuffer',
  // #291 privacy.ts LOCAL_ONLY_DURING_LIVE. Camera-derived scene measurement:
  // local during a live session exactly like the geometry classes above.
  'lightingAnalysis',
] as const;
export type ForbiddenLiveEventPayloadKey = (typeof FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS)[number];

const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS);

/**
 * Recursive structural check. Returns the offending key path, or null.
 *
 * Recursive rather than a shallow key scan because the interesting failure is
 * not `{ mask }` -- nobody writes that -- it is a mask that arrives three
 * levels down inside a diagnostics blob somebody added "just for debugging".
 */
export function findForbiddenLiveDataKey(
  value: unknown,
  path: readonly string[] = [],
  seen: Set<unknown> = new Set(),
): string | null {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenLiveDataKey(value[index], [...path, String(index)], seen);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_SET.has(key)) return [...path, key].join('.');
    const found = findForbiddenLiveDataKey(child, [...path, key], seen);
    if (found) return found;
  }
  return null;
}

/** Throws when a payload carries raw live data. Called at the single point
 *  every native event enters the application (services/vto/vtoLiveSession.ts),
 *  so an offending payload is dropped rather than rendered or logged. */
export function assertNoRawLiveData(payload: unknown, context: string): void {
  const offending = findForbiddenLiveDataKey(payload);
  if (offending) {
    throw new RangeError(
      `Live VTO ${context} payload carries forbidden raw live data at "${offending}". `
      + 'Camera frames, masks, landmarks and body proxies stay native.',
    );
  }
}

// ─── Event payloads ──────────────────────────────────────────────────────────

/** Coarse, non-anatomical framing hint. Deliberately an enum rather than any
 *  geometry: "step back" is guidance, a bounding box is body data. */
export type LiveVtoGuidance =
  | 'none'
  | 'step_back'
  | 'step_closer'
  | 'center_yourself'
  | 'improve_lighting'
  | 'hold_still';

/**
 * ADDITIVE, CARRIED BY EVERY TRACKING EVENT.
 *
 * The runtime is the only party that knows all of Section 14's conditions at
 * once: whether a pose is currently resolved well enough, AND whether a clean
 * person frame is actually buffered right now (the same source
 * `capturePersonFrame()` reads -- "a camera object exists" is not that).
 * `captureReady` is that answer, computed natively by
 * `LiveVtoTrackingQualityMachine` on both platforms from the same facts the
 * tracking phase itself is derived from.
 *
 * OPTIONAL FOR A REASON, NOT BY OVERSIGHT. A runtime that predates this field
 * simply omits it, and `reduceLiveVtoSession` then reads it as FALSE -- the
 * fail-closed direction, where the customer keeps a disabled capture control
 * on a session that might have been ready, rather than an enabled one on a
 * session that would capture nothing.
 */
export interface LiveVtoTrackingReadiness {
  captureReady?: boolean;
}

export interface LiveVtoEventPayloads {
  ready: Record<string, never>;
  trackingAcquired: { confidence: number } & LiveVtoTrackingReadiness;
  trackingWeak: { confidence: number; guidance: LiveVtoGuidance } & LiveVtoTrackingReadiness;
  trackingLost: LiveVtoTrackingReadiness;
  trackingRecovered: { confidence: number } & LiveVtoTrackingReadiness;
  garmentLoaded: { productRef: string; assetVersion: string };
  /** A capture is buffered natively and addressable by id. Never pixel data. */
  captureReady: { captureId: string; kind: LiveVtoCapturedFrameKind };
  privacyStateChanged: { networkActive: boolean; phase: LiveVtoPrivacyPhase };
  performanceChanged: {
    qualityLevel: LiveVtoQualityLevel;
    frameCadenceHz: number | null;
    droppedFrameRatio: number | null;
  };
  fatalError: { state: LiveVtoRuntimeErrorState; recoverable: boolean };
}

export interface LiveVtoEvent<K extends LiveVtoEventName = LiveVtoEventName> {
  type: K;
  timestamp: number;
  payload: LiveVtoEventPayloads[K];
}

// ─── Privacy phase ───────────────────────────────────────────────────────────

/**
 * The type-level fence between local Live processing and the governed
 * generative path. Promoted from #291's LiveVTOPrivacyPhase unchanged: the
 * only way out of 'live' is an explicit user Photoreal action.
 */
export type LiveVtoPrivacyPhase = 'live' | 'aiPhotoRequested' | 'aiPhotoInFlight';

/**
 * What the UI is allowed to tell the customer about where processing happens.
 *
 * Two separate statements on purpose. K Scan must never describe the whole
 * VTO feature as local: the generative path sends an explicit photo to a
 * governed cloud provider, and saying otherwise would be false.
 */
export const LIVE_VTO_PROCESSING_NOTE = 'Processed on this device.';
export const AI_PHOTO_PROCESSING_NOTE = 'Uses a photo you choose for AI generation.';

// ─── Session states (Section 19) ─────────────────────────────────────────────

export const LIVE_VTO_SESSION_STATES = [
  'INITIALIZING',
  'READY',
  'TRACKING',
  'TRACKING_WEAK',
  'TRACKING_LOST',
  'GARMENT_LOADING',
  'CAPTURE_READY',
  'ERROR',
] as const;
export type LiveVtoSessionState = (typeof LIVE_VTO_SESSION_STATES)[number];

/** Quality level. Manual selection only -- there is deliberately no automatic
 *  measurement-driven downgrade path through this contract, matching #295. */
export const LIVE_VTO_QUALITY_LEVELS = ['FULL', 'REDUCED', 'MINIMAL', 'FALLBACK'] as const;
export type LiveVtoQualityLevel = (typeof LIVE_VTO_QUALITY_LEVELS)[number];

// ─── Runtime errors (Section 16/17) ──────────────────────────────────────────

export const LIVE_VTO_RUNTIME_ERROR_STATES = [
  'MODULE_MISSING',
  'MODEL_UNAVAILABLE',
  'CAMERA_UNAVAILABLE',
  'CAMERA_PERMISSION_DENIED',
  'RUNTIME_INITIALIZATION_FAILED',
  'GARMENT_UNSUPPORTED',
  'TRACKING_UNAVAILABLE',
  'DEVICE_LIMITED',
  'PHOTOREAL_UNAVAILABLE',
] as const;
export type LiveVtoRuntimeErrorState = (typeof LIVE_VTO_RUNTIME_ERROR_STATES)[number];

export interface LiveVtoRuntimeError {
  state: LiveVtoRuntimeErrorState;
  /** K Scan copy. Never a provider-native or ML-native string. */
  message: string;
  recoverable: boolean;
}

/** Bounded, customer-safe copy for every runtime error state. A state with no
 *  entry here cannot be rendered, which is the point: an unmapped native error
 *  degrades to a generic message rather than leaking one. */
const LIVE_VTO_ERROR_COPY: Readonly<Record<LiveVtoRuntimeErrorState, { message: string; recoverable: boolean }>> = {
  MODULE_MISSING: { message: 'Live isn’t available in this version.', recoverable: false },
  MODEL_UNAVAILABLE: { message: 'Live isn’t ready on this device yet.', recoverable: false },
  CAMERA_UNAVAILABLE: { message: 'The camera isn’t available right now.', recoverable: true },
  CAMERA_PERMISSION_DENIED: { message: 'Camera access is off, so Live can’t run.', recoverable: false },
  RUNTIME_INITIALIZATION_FAILED: { message: 'Live couldn’t start. You can try again.', recoverable: true },
  GARMENT_UNSUPPORTED: { message: 'This piece isn’t supported in Live yet.', recoverable: false },
  TRACKING_UNAVAILABLE: { message: 'Live can’t see you clearly enough right now.', recoverable: true },
  DEVICE_LIMITED: { message: 'This device can’t run Live smoothly right now.', recoverable: false },
  PHOTOREAL_UNAVAILABLE: { message: 'The AI photo couldn’t be created. Live is still running.', recoverable: true },
};

/**
 * The one mapping from a runtime error state to something a customer sees.
 *
 * `nativeDetail` is accepted and deliberately DISCARDED: a native caller may
 * hold the real error for its own on-device logging, but it never reaches the
 * returned value, this app's telemetry, or the screen. Promoted from #295's
 * toRuntimeErrorEvent with the same guarantee.
 */
export function toLiveVtoRuntimeError(
  state: LiveVtoRuntimeErrorState,
  _nativeDetail?: unknown,
): LiveVtoRuntimeError {
  const copy = LIVE_VTO_ERROR_COPY[state];
  if (!copy) {
    return { state: 'RUNTIME_INITIALIZATION_FAILED', message: 'Live couldn’t start. You can try again.', recoverable: true };
  }
  return { state, message: copy.message, recoverable: copy.recoverable };
}

// ─── Capture + the clean-frame rule (Section 22) ─────────────────────────────

export const LIVE_VTO_CAPTURED_FRAME_KINDS = ['PERSON_FRAME', 'PREVIEW'] as const;
export type LiveVtoCapturedFrameKind = (typeof LIVE_VTO_CAPTURED_FRAME_KINDS)[number];

/**
 * A handle to a frame the native runtime captured and holds. A local URI, not
 * bytes: nothing pixel-shaped crosses the command/event boundary.
 */
export interface LiveVtoCapturedFrame {
  captureId: string;
  kind: LiveVtoCapturedFrameKind;
  localUri: string;
  width: number | null;
  height: number | null;
}

/**
 * THE CLEAN-FRAME RULE. Only a PERSON_FRAME may feed the generative path.
 *
 * The guarantee lives in the contract, not in a heuristic: there is
 * deliberately no dimension comparison, no pixel sniffing, and no "does this
 * look composited" check anywhere in this integration. Such a proxy would be
 * both defeatable and wrong. The native runtime labels what it captured, this
 * assertion is the single gate every handoff passes through, and
 * __tests__/vtoLivePhotorealHandoff.test.js proves a PREVIEW handle is
 * refused at that gate.
 */
export function assertCleanPersonFrame(frame: LiveVtoCapturedFrame): void {
  if (!frame || frame.kind !== 'PERSON_FRAME') {
    throw new RangeError(
      `Generative handoff requires a PERSON_FRAME capture, got kind=${String(frame?.kind)}. `
      + 'The composited Live preview must never be sent for AI generation.',
    );
  }
}

// ─── Photoreal intent (Section 21) ───────────────────────────────────────────

export const PHOTOREAL_INTENT_STATES = [
  'LIVE_LOCAL',
  'CAPTURE_CONSENT',
  'STILL_CAPTURED',
  'GENERATIVE_HANDOFF_READY',
] as const;
export type PhotorealIntentState = (typeof PHOTOREAL_INTENT_STATES)[number];

export const PHOTOREAL_STATE_TO_PRIVACY_PHASE: Readonly<Record<PhotorealIntentState, LiveVtoPrivacyPhase>> = {
  LIVE_LOCAL: 'live',
  CAPTURE_CONSENT: 'aiPhotoRequested',
  STILL_CAPTURED: 'aiPhotoRequested',
  GENERATIVE_HANDOFF_READY: 'aiPhotoRequested',
};

export interface PhotorealIntentTransition {
  from: PhotorealIntentState;
  to: PhotorealIntentState;
  /** Always true. No timer, tracking event, or any input other than a user
   *  action may drive a transition -- kept as a field rather than a comment so
   *  a future automatic transition cannot be added without touching it. */
  requiresExplicitUserAction: true;
}

export const PHOTOREAL_INTENT_TRANSITIONS: readonly PhotorealIntentTransition[] = [
  { from: 'LIVE_LOCAL', to: 'CAPTURE_CONSENT', requiresExplicitUserAction: true },
  { from: 'CAPTURE_CONSENT', to: 'STILL_CAPTURED', requiresExplicitUserAction: true },
  { from: 'STILL_CAPTURED', to: 'GENERATIVE_HANDOFF_READY', requiresExplicitUserAction: true },
];

const PHOTOREAL_TRANSITION_BY_FROM: ReadonlyMap<PhotorealIntentState, PhotorealIntentTransition> = new Map(
  PHOTOREAL_INTENT_TRANSITIONS.map((transition) => [transition.from, transition]),
);

export type PhotorealAdvanceResult =
  | { ok: true; from: PhotorealIntentState; to: PhotorealIntentState }
  | { ok: false; reason: 'terminal_state' | 'unknown_state' };

/** Advances one step. Takes no measurement, no elapsed time and no event --
 *  only the current state -- so there is structurally no automatic path from
 *  a live session into a cloud request. */
export function advancePhotorealIntent(current: PhotorealIntentState): PhotorealAdvanceResult {
  const transition = PHOTOREAL_TRANSITION_BY_FROM.get(current);
  if (transition) return { ok: true, from: transition.from, to: transition.to };
  return (PHOTOREAL_INTENT_STATES as readonly string[]).includes(current)
    ? { ok: false, reason: 'terminal_state' }
    : { ok: false, reason: 'unknown_state' };
}

/** Cancellation from ANY state returns to a running Live session. */
export function returnToLive(): PhotorealIntentState {
  return 'LIVE_LOCAL';
}

// ─── Photoreal failure (Section 23) ──────────────────────────────────────────

export const PHOTOREAL_FAILURE_CODES = [
  'capture_cancelled',
  'no_usable_still',
  'garment_not_eligible',
  'feature_disabled',
  'entitlement_missing',
  'provider_unavailable',
  'generation_failed',
  'harness_active',
] as const;
export type PhotorealFailureCode = (typeof PHOTOREAL_FAILURE_CODES)[number];

export interface PhotorealFailureOutcome {
  code: PhotorealFailureCode;
  resultingState: PhotorealIntentState;
  /** Always true. A cloud generation failing is not a reason to tear down a
   *  local session that is still working. One handler, no per-code branch. */
  liveSessionRemainsUsable: true;
}

export function handlePhotorealFailure(code: PhotorealFailureCode): PhotorealFailureOutcome {
  return { code, resultingState: returnToLive(), liveSessionRemainsUsable: true };
}

// ─── Live garment descriptor (promoted subset) ───────────────────────────────

/**
 * What the native runtime needs to load a garment. A strict subset of the
 * research GarmentDescriptor: identity, the image, and the template family.
 *
 * Everything the research descriptor carries for rendering (silhouette,
 * neckline, closure, texture, material) is deliberately absent -- this app
 * has no source of truth for those fields, and inventing them would be
 * fabricating metadata the research contract itself forbids.
 */
export const LIVE_SUPPORTED_TEMPLATE_FAMILIES = ['t-shirt', 'simple-top', 'sweater'] as const;
export type LiveSupportedTemplateFamily = (typeof LIVE_SUPPORTED_TEMPLATE_FAMILIES)[number];

/**
 * The garment lifecycle a surface may render, Section 18.
 *
 * WHY THE SESSION STATE WAS NOT ENOUGH. `LIVE_VTO_SESSION_STATES` has one
 * `GARMENT_LOADING` member and nothing else about the garment, so a surface
 * could tell that SOMETHING was loading but never which product it was, nor
 * whether the previously-loaded one was still what the runtime was drawing.
 * A switch that failed left the session back in READY with the OLD garment
 * still rendered and nothing on screen saying so.
 *
 *   IDLE      no garment has ever been selected for this session
 *   SELECTED  the customer's choice is acknowledged; nothing sent yet
 *   LOADING   a load/switch command is in flight for `pendingProductRef`
 *   RENDERED  the runtime confirmed THIS product's asset is what it draws
 *   FAILED    the load was refused; the previous garment, if any, still draws
 *
 * The identity, not just the phase, is what makes a stale completion
 * detectable: see `reduceLiveVtoSession`, where a `garmentLoaded` naming a
 * product that is not the pending one is REJECTED rather than allowed to
 * report success for a garment the customer already moved on from.
 */
export const LIVE_VTO_GARMENT_STATUSES = [
  'IDLE',
  'SELECTED',
  'LOADING',
  'RENDERED',
  'FAILED',
] as const;
export type LiveVtoGarmentStatus = (typeof LIVE_VTO_GARMENT_STATUSES)[number];

/**
 * `assetKey`/`assetId`/`assetVersion` (added alongside the governed asset
 * resolver, services/vto/vtoLiveGarment.ts's `resolveLiveGarment`). Required,
 * not optional: a descriptor that reached ELIGIBLE went through the resolver
 * and therefore always has a real governed asset attached, and the native
 * parser (`LiveVtoGarmentDescriptor.fromBridgeMap`/`.parse`, both platforms)
 * refuses anything without a valid, allowlisted `assetKey` rather than
 * silently falling back to a bundled diagnostic fixture -- see
 * services/vto/vtoLiveGarmentRegistry.ts for why "no entry" is the expected,
 * truthful outcome for most real productRef values, not a bug to work around
 * with a default.
 */
export interface LiveVtoGarmentDescriptor {
  /** The SAME productRef the generative path uses. One product identity. */
  productRef: string;
  imageUrl: string;
  /** K Scan canonical taxonomy token, e.g. 'top'. */
  canonicalCategory: string;
  templateFamily: LiveSupportedTemplateFamily;
  /** Allowlisted bundled-asset directory key the resolver selected --
   *  services/vto/vtoLiveGarmentRegistry.ts's LIVE_VTO_ASSET_KEY_ALLOWLIST.
   *  Native validates membership itself; this is never treated as a raw
   *  filesystem path. */
  assetKey: string;
  /** The resolved governed asset's stable identifier (manifest.assetId). */
  assetId: string;
  /** The resolved governed asset's version (manifest.assetVersion). A newer
   *  asset must not silently mutate an in-progress session -- switching to a
   *  new version is always a new loadGarment/switchGarment call, never a
   *  live mutation of an already-loaded descriptor. */
  assetVersion: string;
}
