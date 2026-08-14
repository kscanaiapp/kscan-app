import { useSyncExternalStore } from 'react';
import {
  getAvatarAppForegroundSnapshot,
  subscribeToAvatarAppForeground,
} from '../services/avatarSpeechLifecycle';

/**
 * True while the app is foregrounded.
 *
 * Continuous avatar motion must not keep running once the app is backgrounded
 * or interrupted: the animation is invisible there and would otherwise burn
 * battery and leave the avatar mid-pose on return. Subscribing reuses the
 * single service-owned AppState listener rather than adding another one.
 */
export function useAvatarAppForeground(): boolean {
  return useSyncExternalStore(
    subscribeToAvatarAppForeground,
    getAvatarAppForegroundSnapshot,
    getAvatarAppForegroundSnapshot,
  );
}
