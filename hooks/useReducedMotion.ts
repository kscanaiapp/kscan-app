import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

let reducedMotion = false;
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null;

function emit() {
  listeners.forEach((cb) => cb());
}

function setValue(value: boolean) {
  if (value === reducedMotion) return;
  reducedMotion = value;
  emit();
}

function ensureSubscribed() {
  if (subscription) return;
  subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setValue);
  // Seed the cached value asynchronously without forcing consumers to wait.
  AccessibilityInfo.isReduceMotionEnabled().then(setValue).catch(() => {});
}

function subscribe(callback: () => void) {
  ensureSubscribed();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && subscription) {
      subscription.remove();
      subscription = null;
    }
  };
}

function getSnapshot(): boolean {
  return reducedMotion;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the user has enabled Reduce Motion.
 *
 * Reduced motion disables visual animation only; it must not disable manual
 * audio playback or greeting text.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
