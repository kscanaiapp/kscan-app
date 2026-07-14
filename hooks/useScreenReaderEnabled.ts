import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Fail closed until the asynchronous native query resolves. Otherwise an
// enabled voice preference can start automatic speech during the first-render
// window before a running screen reader has been detected.
let screenReaderEnabled = true;
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null;

function emit() {
  listeners.forEach((cb) => cb());
}

function setValue(value: boolean) {
  if (value === screenReaderEnabled) return;
  screenReaderEnabled = value;
  emit();
}

function ensureSubscribed() {
  if (subscription) return;
  subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setValue);
  AccessibilityInfo.isScreenReaderEnabled().then(setValue).catch(() => {});
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
  return screenReaderEnabled;
}

function getServerSnapshot(): boolean {
  return true;
}

/**
 * Returns true when a screen reader is active.
 *
 * Automatic greeting speech must be suppressed while a screen reader is enabled.
 */
export function useScreenReaderEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
