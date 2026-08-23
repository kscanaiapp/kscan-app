// Typed contract for the native Meta Wearables (DAT) adapter.
//
// These types are the ONLY thing K Scan JavaScript is allowed to know about
// the Meta SDK. The native module never hands back a DAT object, a raw
// exception or an image buffer — only the plain, bounded shapes below.

/** Adapter initialization state. Nothing may be called before `READY`. */
export type MetaInitState = 'UNINITIALIZED' | 'INITIALIZING' | 'READY' | 'FAILED';

/** Mirrors DAT `RegistrationState`. */
export type MetaRegistrationState =
  | 'AVAILABLE'
  | 'REGISTERED'
  | 'REGISTERING'
  | 'UNAVAILABLE'
  | 'UNREGISTERING';

/** Mirrors DAT `LinkState`. */
export type MetaLinkState = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';

/** Mirrors DAT `DeviceSessionState`. */
export type MetaSessionState =
  | 'IDLE'
  | 'STARTING'
  | 'STARTED'
  | 'PAUSED'
  | 'STOPPING'
  | 'STOPPED';

/** Mirrors DAT `Camera` lifecycle states (0.9 replaced the stream states). */
export type MetaCameraState = 'STARTING' | 'STARTED' | 'STOPPING' | 'STOPPED';

export type MetaPermissionStatus = 'GRANTED' | 'DENIED';

export type MetaAdapterStatus = {
  available: boolean;
  sdkLinked: boolean;
  initState: MetaInitState;
  sdkVersion?: string;
  /** Present only when the adapter is unavailable; explains why. */
  reason?: string;
  registrationState?: MetaRegistrationState;
  deviceCount?: number;
  hasSession?: boolean;
  hasCamera?: boolean;
  hasDisplay?: boolean;
  displayAvailable?: boolean;
  mockSupported?: boolean;
};

export type MetaDevice = {
  id: string;
  type: string | null;
  linkState: MetaLinkState | null;
};

export type MetaDeviceState = {
  deviceId?: string;
  thermalLevel?: string | null;
  battery?: number | null;
  charging?: boolean | null;
  worn?: boolean | null;
  sessionState?: MetaSessionState | null;
  cameraState?: MetaCameraState | null;
  available?: boolean;
};

/**
 * A capture handed back by the glasses.
 *
 * Deliberately a file URI, never bytes: the image is written to app-private
 * storage natively and consumed in place by the privacy pipeline, so raw
 * capture data never becomes a JavaScript string that could be logged,
 * serialized into analytics, or retained by an error reporter.
 */
export type MetaCapture = {
  uri: string;
  byteLength: number;
  /** Pixel dimensions, read from the JPEG header natively. 0 when unreadable. */
  width: number;
  height: number;
  capturedAt: number;
};

export type MetaCameraConfig = {
  quality?: 'HIGH' | 'MEDIUM' | 'LOW';
  /** DAT accepts only 2, 7, 15, 24 or 30. K Scan defaults to 2 (photo-first). */
  frameRate?: 2 | 7 | 15 | 24 | 30;
};

/** The glanceable payload rendered on display-capable hardware. */
export type MetaDisplayPayload = {
  title: string;
  subtitle?: string;
  price?: string;
  actions?: string[];
};

export type MetaAdapterEvent = {
  event:
    | 'registrationState'
    | 'registrationError'
    | 'devices'
    | 'sessionState'
    | 'sessionError'
    | 'cameraState'
    | 'streamError'
    | 'capabilitiesInvalidated';
  payload: Record<string, unknown>;
};

/** The native surface, exactly as the Kotlin module exposes it. */
export interface KScanMetaWearableNative {
  getStatus(): MetaAdapterStatus;
  initialize(): Promise<MetaAdapterStatus>;

  startRegistration(): Promise<{ ok: boolean; state: MetaRegistrationState }>;
  registrationState(): MetaRegistrationState;

  listDevices(): MetaDevice[];
  activeDevice(): MetaDevice | null;
  deviceState(): MetaDeviceState;

  cameraPermissionStatus(): MetaPermissionStatus;
  requestCameraPermission(): Promise<MetaPermissionStatus>;

  createSession(): Promise<{ ok: boolean; reused: boolean; state: MetaSessionState }>;
  startSession(): Promise<{ ok: boolean; state: MetaSessionState }>;
  stopSession(): Promise<{ ok: boolean; noop?: boolean }>;

  attachCamera(config: MetaCameraConfig): Promise<{ ok: boolean; reused: boolean; state: MetaCameraState }>;
  startCamera(): Promise<{ ok: boolean; state: MetaCameraState }>;
  capturePhoto(timeoutMs: number): Promise<MetaCapture>;
  stopCamera(): Promise<{ ok: boolean; noop?: boolean }>;

  displayAvailable(): boolean;
  attachDisplay(): Promise<{ ok: boolean; reused: boolean }>;
  renderResult(payload: MetaDisplayPayload): Promise<{ ok: boolean; rendered: boolean }>;
  clearDisplay(): Promise<{ ok: boolean; noop?: boolean }>;

  disconnect(): Promise<{ ok: boolean }>;

  mockSupported(): boolean;
  mockEnable(config: { initiallyRegistered?: boolean; initialPermissionsGranted?: boolean }): Promise<{ ok: boolean }>;
  mockPairGlasses(model: string): Promise<{ ok: boolean; model: string }>;
  mockSetDevicePower(on: boolean): Promise<{ ok: boolean }>;
  mockSetWorn(worn: boolean): Promise<{ ok: boolean }>;
  mockDisconnect(): Promise<{ ok: boolean }>;
  mockDisable(): Promise<{ ok: boolean }>;

  addListener(event: 'onAdapterEvent', listener: (payload: MetaAdapterEvent) => void): { remove(): void };
}
