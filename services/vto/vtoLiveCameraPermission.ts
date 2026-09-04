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
 * NO PERMISSION LOOP. A denial is remembered for the life of the process and
 * `ensureLiveCameraPermission` will not re-prompt after the OS says the
 * customer cannot be asked again. Re-asking on every tap is the loop this
 * guard exists to prevent -- and a denial is not an error state anyway: Live
 * simply is not available, and AI Photo remains usable exactly as before.
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-camera');
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

export function resetLiveCameraPermissionMemory(): void {
  blockedFromAsking = false;
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
