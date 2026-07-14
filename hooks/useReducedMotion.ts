import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Keep motion disabled until the asynchronous native preference is known so a
// Reduce Motion user never sees an animated first frame during hydration.
let reducedMotion = true;
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
  return true;
}

/**
 * Returns true when Reduce Motion is enabled.
 *
 * Visual motion (idle, thinking, lip movement) must stop. Greeting text and
 * manual audio playback remain available.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
