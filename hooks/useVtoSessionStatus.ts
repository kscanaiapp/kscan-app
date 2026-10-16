/**
 * Read-only view of the VTO session, for surfaces that must OBSERVE a running
 * try-on without owning it.
 *
 * WHY THIS IS NOT `useVirtualTryOn`. That hook is the operator: it reattaches
 * the session photo to its own garment on mount and calls `leaveVtoSurface` on
 * unmount. Exactly one live surface may do that at a time. The minimized pill
 * needs the same status but must claim none of that authority -- mounting it
 * must not reattach anything, and unmounting it must not tear down the
 * generation it is reporting on.
 *
 * So this is `useSyncExternalStore` and nothing else: one subscription, zero
 * effects, no writes. It cannot cancel, supersede, or reassign a request.
 */

import { useSyncExternalStore } from 'react';

import {
  getVtoActorBoundaryEpoch,
  getVtoSnapshot,
  subscribeToVto,
  type VtoSnapshot,
} from '../services/vto/vtoRequestStore';

export function useVtoSessionStatus(): VtoSnapshot {
  return useSyncExternalStore(subscribeToVto, getVtoSnapshot, getVtoSnapshot);
}

/**
 * Advances when the ACTOR changes (sign-out, account switch), never for the
 * customer's own "start over". Read-only, same as the hook above.
 */
export function useVtoActorBoundaryEpoch(): number {
  return useSyncExternalStore(subscribeToVto, getVtoActorBoundaryEpoch, getVtoActorBoundaryEpoch);
}
