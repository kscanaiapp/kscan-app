import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Fail closed until the asynchronous native query resolves. Otherwise an
// enabled voice preference can start automatic speech during the first-render
// window before a running screen reader has been detected.
let screenReaderEnabled = true;
let screenReaderReady = false;
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null;

function emit() {
  listeners.forEach((cb) => cb());
}

function setValue(value: boolean) {
  const becameReady = !screenReaderReady;
  const enabledChanged = value !== screenReaderEnabled;
  screenReaderEnabled = value;
  screenReaderReady = true;
  if (becameReady || enabledChanged) emit();
}

function ensureSubscribed() {
  if (subscription) return;
  subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setValue);
  AccessibilityInfo.isScreenReaderEnabled()
    .then(setValue)
    .catch(() => {
      // Probe failure still unblocks speech eligibility; keep fail-closed enabled.
      setValue(true);
    });
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

function getEnabledSnapshot(): boolean {
  return screenReaderEnabled;
}

function getReadySnapshot(): boolean {
  return screenReaderReady;
}

function getServerSnapshot(): boolean {
  return true;
}

function getServerReadySnapshot(): boolean {
  return false;
}

/**
 * Returns true when a screen reader is active.
 *
 * Automatic greeting speech must be suppressed while a screen reader is enabled.
 */
export function useScreenReaderEnabled(): boolean {
  return useSyncExternalStore(subscribe, getEnabledSnapshot, getServerSnapshot);
}

/**
 * Returns true once the native screen-reader probe has settled.
 *
 * Greeting speech must wait for this so the fail-closed default cannot
 * permanently skip a newly inserted welcome utterance.
 */
export function useScreenReaderReady(): boolean {
  return useSyncExternalStore(subscribe, getReadySnapshot, getServerReadySnapshot);
}

/** Test-only reset for isolated module evaluation. */
export function resetScreenReaderStateForTests(): void {
  screenReaderEnabled = true;
  screenReaderReady = false;
  if (subscription) {
    subscription.remove();
    subscription = null;
  }
  listeners.clear();
}
