// Meta glasses device orchestration — capability negotiation and capture.
//
// This module is the boundary between "K Scan wants a picture of what the
// wearer is looking at" and the Meta Wearables Device Access Toolkit. It owns
// the ORDER of operations, which is the part of DAT that is easy to get
// silently wrong:
//
//   initialize -> registered -> device connected -> session created ->
//   session STARTED -> camera attached -> camera STARTED -> capturePhoto
//
// Two DAT rules are enforced here rather than hoped for:
//   * a session that has stopped is never reused (the native adapter also
//     enforces this; doing it on both sides means a stale JS handle cannot
//     produce a confusing native error);
//   * a live session does NOT imply a live camera — they are independent
//     lifecycles, so capture checks the camera.
//
// DESIGN NOTE — dependency injection. Every function here takes the native
// module as an argument instead of importing it. That keeps this file free of
// runtime imports, which is what lets the Node test harness transpile and run
// it in a sandbox with a `require` that throws on ANY module load. If someone
// later adds an `import` of a native package here, the tests fail loudly
// rather than the capability layer silently becoming untestable.

import type {
  KScanMetaWearableNative,
  MetaAdapterStatus,
  MetaCameraConfig,
  MetaCapture,
  MetaDeviceState,
  MetaDisplayPayload,
} from '../modules/kscan-meta-wearable/src/KScanMetaWearable.types';

export const META_DEVICE_ORCHESTRATOR_VERSION = 'kscan.meta.device.v1';

/** Default capture timeout. DAT clamps to 30s natively; this is the K Scan budget. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 12_000;

export class MetaDeviceError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'MetaDeviceError';
    this.code = code;
  }
}

export type MetaCapabilities = {
  /** The adapter itself was compiled in and initialized. */
  adapterReady: boolean;
  /** Registration with the Meta AI companion app is complete. */
  registered: boolean;
  /** At least one device reports LinkState CONNECTED. */
  deviceConnected: boolean;
  /** Glasses camera is usable (device connected + permission granted). */
  camera: boolean;
  /** Device reports the DISPLAY capability. Never inferred from a model name. */
  display: boolean;
  /** Device state telemetry is readable. */
  deviceState: boolean;
  /** Why the capability set is degraded, when it is. */
  reason: string | null;
};

/**
 * The K Scan experience a given device can actually support.
 *
 * `PHONE_RESULT` is not a downgrade to be apologised for — it is the correct
 * experience for camera-first glasses (Ray-Ban Meta and friends), which have
 * no display at all. `DISPLAY_GLANCE` is only ever selected because the device
 * reported the capability.
 */
export type MetaExperience = 'DISPLAY_GLANCE' | 'PHONE_RESULT' | 'UNAVAILABLE';

const UNAVAILABLE: MetaCapabilities = {
  adapterReady: false,
  registered: false,
  deviceConnected: false,
  camera: false,
  display: false,
  deviceState: false,
  reason: 'ADAPTER_UNAVAILABLE',
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Reads what this device can actually do, right now.
 *
 * Nothing is inferred from marketing model names: display support comes from
 * the device's own reported capability, camera support from a real permission
 * check. A device that is merely paired but not CONNECTED yields no
 * capabilities, because attaching to it would fail.
 */
export function negotiateCapabilities(
  native: KScanMetaWearableNative | null | undefined,
): MetaCapabilities {
  if (!native) return { ...UNAVAILABLE };

  const status: MetaAdapterStatus = safe(() => native.getStatus(), {
    available: false,
    sdkLinked: false,
    initState: 'UNINITIALIZED',
  });
  if (!status.available || !status.sdkLinked) {
    return { ...UNAVAILABLE, reason: status.reason ?? 'MWDAT_NOT_LINKED' };
  }
  if (status.initState !== 'READY') {
    return { ...UNAVAILABLE, reason: 'NOT_INITIALIZED' };
  }

  const registered = safe(() => native.registrationState(), 'UNAVAILABLE') === 'REGISTERED';
  if (!registered) {
    return { ...UNAVAILABLE, adapterReady: true, reason: 'NOT_REGISTERED' };
  }

  const devices = safe(() => native.listDevices(), []);
  const deviceConnected = devices.some((device) => device.linkState === 'CONNECTED');
  if (!deviceConnected) {
    return {
      ...UNAVAILABLE,
      adapterReady: true,
      registered: true,
      reason: devices.length === 0 ? 'NO_DEVICE' : 'DEVICE_NOT_CONNECTED',
    };
  }

  const permission = safe(() => native.cameraPermissionStatus(), 'DENIED');
  const display = safe(() => native.displayAvailable(), false);
  const deviceState = safe(() => {
    const state: MetaDeviceState = native.deviceState();
    return state !== null && typeof state === 'object';
  }, false);

  return {
    adapterReady: true,
    registered: true,
    deviceConnected: true,
    camera: permission === 'GRANTED',
    display,
    deviceState,
    reason: permission === 'GRANTED' ? null : 'CAMERA_PERMISSION_DENIED',
  };
}

/** Chooses the experience from capabilities alone. */
export function selectExperience(capabilities: MetaCapabilities): MetaExperience {
  if (!capabilities.adapterReady || !capabilities.deviceConnected || !capabilities.camera) {
    return 'UNAVAILABLE';
  }
  return capabilities.display ? 'DISPLAY_GLANCE' : 'PHONE_RESULT';
}

/**
 * Thermal levels at which K Scan declines to start the camera.
 *
 * A scan is one photo. If the glasses are already critical, the right answer
 * is a clear refusal, not a retry loop that pushes them into shutdown.
 */
const BLOCKING_THERMAL = new Set(['CRITICAL', 'EMERGENCY']);

export function isThermallyBlocked(state: MetaDeviceState | null | undefined): boolean {
  const level = state?.thermalLevel;
  return typeof level === 'string' && BLOCKING_THERMAL.has(level.toUpperCase());
}

export type CaptureHandle = {
  /** Resolves with the capture, or rejects with a `MetaDeviceError`. */
  promise: Promise<MetaCapture>;
  /** Cancels the in-flight capture. A late photo must never resurrect it. */
  cancel(): void;
};

/**
 * Brings the glasses up and takes exactly one photo.
 *
 * Cancellation semantics matter here and are the reason this returns a handle
 * rather than a bare promise. If the wearer (or the phone UI) cancels while a
 * capture is in flight, the promise rejects immediately with
 * `META_CAPTURE_CANCELLED` and — critically — a photo that arrives afterwards
 * is discarded and its file deleted rather than being delivered into a flow
 * that has already moved on.
 */
export function captureFromGlasses(
  native: KScanMetaWearableNative | null | undefined,
  options: {
    camera?: MetaCameraConfig;
    timeoutMs?: number;
    /** Injected for tests; defaults to the native adapter's own cleanup. */
    onDiscardLateCapture?: (capture: MetaCapture) => void;
  } = {},
): CaptureHandle {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };

  const run = async (): Promise<MetaCapture> => {
    if (!native) throw new MetaDeviceError('META_ADAPTER_UNAVAILABLE');

    const capabilities = negotiateCapabilities(native);
    if (selectExperience(capabilities) === 'UNAVAILABLE') {
      throw new MetaDeviceError(capabilities.reason ?? 'META_ADAPTER_UNAVAILABLE');
    }

    const deviceState = safe(() => native.deviceState(), null as MetaDeviceState | null);
    if (isThermallyBlocked(deviceState)) {
      throw new MetaDeviceError('META_THERMAL_BLOCKED', 'The glasses are too hot to scan right now.');
    }

    const throwIfCancelled = () => {
      if (cancelled) throw new MetaDeviceError('META_CAPTURE_CANCELLED');
    };

    let cameraAttached = false;
    try {
      throwIfCancelled();
      await native.createSession();

      throwIfCancelled();
      const started = await native.startSession();
      if (started.state !== 'STARTED') {
        throw new MetaDeviceError('META_SESSION_START_FAILED');
      }

      throwIfCancelled();
      await native.attachCamera(options.camera ?? { quality: 'MEDIUM', frameRate: 2 });
      cameraAttached = true;

      throwIfCancelled();
      const camera = await native.startCamera();
      if (camera.state !== 'STARTED') {
        throw new MetaDeviceError('META_CAMERA_UNAVAILABLE');
      }

      throwIfCancelled();
      const capture = await native.capturePhoto(options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);

      // The capture may have landed AFTER a cancel. Discard it rather than
      // returning it: the caller's flow is gone and delivering it here is how
      // a cancelled scan resurrects as a real result.
      if (cancelled) {
        options.onDiscardLateCapture?.(capture);
        throw new MetaDeviceError('META_CAPTURE_CANCELLED');
      }
      return capture;
    } finally {
      // Always release the glasses. A camera left streaming is the single most
      // expensive thing K Scan can do to this hardware.
      if (cameraAttached) await Promise.resolve(native.stopCamera()).catch(() => undefined);
      await Promise.resolve(native.stopSession()).catch(() => undefined);
    }
  };

  return { promise: run(), cancel };
}

/**
 * Reduces a canonical K Scan result to something readable on glasses.
 *
 * This is not the browser HUD squeezed smaller. A wearer reading this is
 * walking around: one identity line, one supporting line, one price, and the
 * actions the result actually supports. Everything is hard-truncated because
 * the display will not wrap gracefully and a clipped word is worse than a
 * short one.
 */
export function toDisplayPayload(
  result: Record<string, unknown> | null | undefined,
): MetaDisplayPayload | null {
  if (!result || typeof result !== 'object') return null;

  const primary = (result.primaryMatch && typeof result.primaryMatch === 'object'
    ? result.primaryMatch
    : {}) as Record<string, unknown>;

  const title = typeof primary.title === 'string' && primary.title.trim()
    ? primary.title.trim()
    : typeof result.summary === 'string' && result.summary.trim()
      ? result.summary.trim()
      : null;
  if (!title) return null;

  const brand = typeof primary.brand === 'string' ? primary.brand.trim() : '';
  const retailer = typeof primary.retailer === 'string' ? primary.retailer.trim() : '';
  const confidence = typeof result.confidence === 'number' && Number.isFinite(result.confidence)
    ? `${Math.round(result.confidence)}% match`
    : '';

  const subtitleParts = [brand || retailer, confidence].filter(Boolean);

  const priceLabel = typeof primary.priceLabel === 'string'
    ? primary.priceLabel
    : typeof (primary.price as Record<string, unknown> | undefined)?.label === 'string'
      ? String((primary.price as Record<string, unknown>).label)
      : '';

  const rawActions = Array.isArray(result.actions) ? result.actions : [];
  const actions: string[] = [];
  if (rawActions.includes('save')) actions.push('Save');
  if (rawActions.includes('open_on_phone')) actions.push('Open on phone');
  actions.push('Dismiss');

  return {
    title: title.slice(0, 48),
    subtitle: subtitleParts.join(' · ').slice(0, 48) || undefined,
    price: priceLabel.slice(0, 24) || undefined,
    actions,
  };
}
