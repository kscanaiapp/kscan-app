import { useSyncExternalStore } from 'react';
import {
  getAvatarMotionSnapshot,
  subscribeToAvatarMotion,
  type AvatarDiscreteMotionSnapshot,
} from '../stores/avatarMotionStore';

/**
 * Discrete avatar motion state for UI. Components using this hook rerender
 * only when a visible field changes (mouth state, phase, scope, generation) —
 * never on raw playback-position ticks, which stay inside the motion layer.
 */
export function useAvatarMotionState(): AvatarDiscreteMotionSnapshot {
  return useSyncExternalStore(
    subscribeToAvatarMotion,
    getAvatarMotionSnapshot,
    getAvatarMotionSnapshot,
  );
}
