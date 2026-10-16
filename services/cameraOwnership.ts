/**
 * Which surface owns the device camera right now.
 *
 * WHY THIS EXISTS. The Scanner (expo-camera) and Live VTO (CameraX in the
 * native module) share Android's process-wide CameraX provider, and each one
 * calls `unbindAll()` on it (expo-camera 17.0.10 when it binds and when its view
 * detaches). Two surfaces holding a camera at once means whichever acquires
 * second silently switches the first one off, and whichever releases first
 * switches the survivor off. That cannot be fixed inside either library; it is
 * prevented by never letting both own a camera.
 *
 * THIS IS BOOKKEEPING, NOT A CAMERA AUTHORITY. It opens no camera, binds no
 * use case and replaces nothing in expo-camera or the native module. It only
 * answers "may this surface take the camera now?" and tells the loser to let go.
 *
 * POLICY (explicit, because both choices have a cost):
 *   - The Scanner PREEMPTS Live. The Scanner is the core flow and its camera is
 *     mounted by navigation, which Live cannot veto; Live is a modal the
 *     customer can restart in one tap.
 *   - Live is REFUSED while the Scanner camera is mounted. It never takes the
 *     camera out from under the Scanner.
 *   - A stale release never releases a newer owner: leases are identity-checked.
 */

export type CameraSurface = 'scanner' | 'live_vto';

export interface CameraLease {
  readonly surface: CameraSurface;
  /** Idempotent. Releasing a lease that was preempted or already released is a no-op. */
  release(): void;
}

interface Holder {
  lease: CameraLease;
  onPreempted: () => void;
}

let holder: Holder | null = null;

/** The surface that currently owns the camera, or null. */
export function currentCameraOwner(): CameraSurface | null {
  return holder?.lease.surface ?? null;
}

/**
 * Try to take the camera for `surface`. Returns null when the policy refuses
 * (Live while the Scanner holds it). `onPreempted` is called, once, if a
 * higher-priority surface takes the camera later; it must stop using the camera.
 */
export function acquireCameraLease(
  surface: CameraSurface,
  onPreempted: () => void = () => {},
): CameraLease | null {
  const existing = holder;
  if (existing && existing.lease.surface !== surface) {
    if (surface === 'live_vto') return null; // never take the Scanner's camera
    // The Scanner takes over: tell Live to let go first, then own it.
    holder = null;
    try {
      existing.onPreempted();
    } catch {
      // A misbehaving holder must not keep the camera or block the Scanner.
    }
  } else if (existing) {
    // Same surface acquiring again (a remount): the newer lease supersedes the
    // older one, whose release must then be a no-op.
    holder = null;
  }

  const lease: CameraLease = {
    surface,
    release() {
      if (holder && holder.lease === lease) holder = null;
    },
  };
  holder = { lease, onPreempted };
  return lease;
}

export function resetCameraOwnershipForTests(): void {
  holder = null;
}
