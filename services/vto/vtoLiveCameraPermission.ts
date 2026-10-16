/**
 * Camera permission for Live VTO -- asked at the right moment, and once.
 *
 * WHEN THE PROMPT HAPPENS. Opening Try It On must never trigger it. The
 * existing sheet is the AI Photo surface: it uses the system photo picker,
 * which needs no permission at all (see services/vto/vtoPersonInput.ts on why
 * the media-library gate was removed), and prompting for the camera there
 * would be asking for access to something the customer did not ask to use.
 * The prompt belongs at exactly one place: the customer explicitly selecting
 * or entering LIVE, on a build where Live is otherwise eligible.
 *
 * NO PERMISSION LOOP, INCLUDING A CONCURRENT ONE. A denial is remembered for
 * the life of the process and `ensureLiveCameraPermission` will not re-prompt
 * after the OS says the customer cannot be asked again. Re-asking on every tap
 * is the loop this guard exists to prevent -- and a denial is not an error
 * state anyway: Live simply is not available, and AI Photo remains usable
 * exactly as before.
 *
 * VTO-HA-002. The refusal memo alone was not enough. It is only written after
 * `requestPermissions()` RESOLVES, so two calls that both started while the
 * first dialog was still open each saw `blockedFromAsking === false` and each
 * raised a system dialog -- which is exactly the rapid-double-tap case, since
 * the Live entry button stays enabled for as long as the prompt is up. An
 * in-flight promise is therefore shared: a second caller arriving while a
 * prompt is open awaits the SAME request instead of starting a second one.
 *
 * This module owns no UI and never navigates to Settings on its own.
 */

import type { VtoCameraPermissionState } from './vtoLiveCapability';

interface ExpoPermissionResponse {
  status?: unknown;
  granted?: unknown;
  canAskAgain?: unknown;
}

type PermissionReader = () => Promise<ExpoPermissionResponse>;

/**
 * expo-camera is required lazily. It is already a dependency and already
 * configured, but a static import here would pull the camera module into
 * every bundle that touches VTO capability -- including the AI-Photo-only
 * path, which has no business loading it.
 */
function loadExpoCamera(): {
  getCameraPermissionsAsync?: PermissionReader;
  requestCameraPermissionsAsync?: PermissionReader;
} | null {
  try {
    // N1-F device certification (2026-09-06): expo-camera 17.0.10 does NOT
    // export `getCameraPermissionsAsync`/`requestCameraPermissionsAsync` at
    // the package root -- only `useCameraPermissions` (a hook) and the
    // legacy `Camera` namespace object carry them (expo-camera's own
    // build/index.js: `export const Camera = { getCameraPermissionsAsync,
    // requestCameraPermissionsAsync, ... }`). Reaching for the package root
    // here silently returned `undefined` for both functions, which made
    // every call fail closed to 'unavailable' -- verified on a real Android
    // device: `ensureLiveCameraPermission()` never actually reached
    // `requestCameraPermissionsAsync()` (prompted: false, always). Fixed by
    // reading the `Camera` namespace, which is the one place both functions
    // are genuinely still exported.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-camera')?.Camera ?? null;
  } catch {
    return null;
  }
}

/** Translates an Expo permission response into the router's vocabulary.
 *  Anything unrecognized is 'undetermined', never an optimistic 'granted'. */
export function toVtoCameraPermissionState(
  response: ExpoPermissionResponse | null | undefined,
): VtoCameraPermissionState {
  if (!response || typeof response !== 'object') return 'undetermined';
  if (response.granted === true || response.status === 'granted') return 'granted';
  if (response.status === 'denied') {
    // `canAskAgain: false` is a permanent refusal; either way Live is off, and
    // the distinction only governs whether we may prompt again.
    return 'denied';
  }
  return 'undetermined';
}

/**
 * Reads the current status WITHOUT prompting.
 *
 * This is the only permission call the capability router's inputs are built
 * from, which is what makes "opening Try It On prompts for nothing" a property
 * of the code rather than a convention.
 */
export async function readLiveCameraPermission(
  deps?: { getPermissions?: PermissionReader },
): Promise<VtoCameraPermissionState> {
  const getPermissions = deps?.getPermissions ?? loadExpoCamera()?.getCameraPermissionsAsync;
  if (typeof getPermissions !== 'function') return 'unavailable';
  try {
    return toVtoCameraPermissionState(await getPermissions());
  } catch {
    return 'unavailable';
  }
}

/** Process-scoped memory of a refusal we may not repeat. Not persisted: a
 *  fresh launch may legitimately ask once more, and the OS is the real
 *  authority in any case. */
let blockedFromAsking = false;

/** The prompt currently on screen, if any. Shared so concurrent callers join
 *  one dialog rather than stacking two -- see VTO-HA-002 in the header. */
let inFlightPrompt: Promise<EnsureLiveCameraPermissionResult> | null = null;

export function resetLiveCameraPermissionMemory(): void {
  blockedFromAsking = false;
  inFlightPrompt = null;
}

export interface EnsureLiveCameraPermissionResult {
  state: VtoCameraPermissionState;
  /** Did this call actually put a system dialog on screen? Reported so the
   *  Live entry path can be asserted about in tests: state matrix cases B and
   *  C must show `prompted: false` because they never reach here at all. */
  prompted: boolean;
}

/**
 * Called ONLY from the Live entry path, after the router has already said Live
 * is otherwise available.
 *
 * Prompts at most once per process for a customer who can still be asked.
 * Returns the resulting state; the caller's job on anything but 'granted' is
 * to stay on AI Photo, not to retry.
 */
export async function ensureLiveCameraPermission(
  deps?: {
    getPermissions?: PermissionReader;
    requestPermissions?: PermissionReader;
  },
): Promise<EnsureLiveCameraPermissionResult> {
  // A prompt is already on screen. Await it rather than raising a second one:
  // the OS has one camera dialog and the customer answers it once.
  if (inFlightPrompt) return inFlightPrompt;
  const attempt = runEnsureLiveCameraPermission(deps);
  inFlightPrompt = attempt;
  try {
    return await attempt;
  } finally {
    if (inFlightPrompt === attempt) inFlightPrompt = null;
  }
}

async function runEnsureLiveCameraPermission(
  deps?: {
    getPermissions?: PermissionReader;
    requestPermissions?: PermissionReader;
  },
): Promise<EnsureLiveCameraPermissionResult> {
  const camera = deps?.getPermissions || deps?.requestPermissions ? null : loadExpoCamera();
  const getPermissions = deps?.getPermissions ?? camera?.getCameraPermissionsAsync;
  const requestPermissions = deps?.requestPermissions ?? camera?.requestCameraPermissionsAsync;

  if (typeof getPermissions !== 'function' || typeof requestPermissions !== 'function') {
    return { state: 'unavailable', prompted: false };
  }

  let current: ExpoPermissionResponse | null = null;
  try {
    current = await getPermissions();
  } catch {
    return { state: 'unavailable', prompted: false };
  }

  const currentState = toVtoCameraPermissionState(current);
  if (currentState === 'granted') return { state: 'granted', prompted: false };

  // Already refused in a way the OS will not re-present, or refused once in
  // this process: do not ask again.
  if (blockedFromAsking || current?.canAskAgain === false) {
    blockedFromAsking = true;
    return { state: 'denied', prompted: false };
  }

  let response: ExpoPermissionResponse | null = null;
  try {
    response = await requestPermissions();
  } catch {
    return { state: 'unavailable', prompted: true };
  }

  const nextState = toVtoCameraPermissionState(response);
  if (nextState !== 'granted') blockedFromAsking = true;
  return { state: nextState, prompted: true };
}
