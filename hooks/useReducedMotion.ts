import { useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

// Remain neutral until the OS preference has been read. Never guess that
// motion is allowed when native accessibility state is unavailable.
let reducedMotion = true;
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof AccessibilityInfo.addEventListener> | null = null;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let queryInFlight = false;
let retryCount = 0;
let subscriptionEpoch = 0;

function emit() {
  listeners.forEach((cb) => cb());
}

function setValue(value: boolean) {
  if (value === reducedMotion) return;
  reducedMotion = value;
  emit();
}

function refreshOsPreference() {
  if (queryInFlight || listeners.size === 0) return;
  queryInFlight = true;
  const epoch = subscriptionEpoch;
  void Promise.resolve()
    .then(() => AccessibilityInfo.isReduceMotionEnabled())
    .then((value) => {
      if (epoch === subscriptionEpoch && typeof value === 'boolean') setValue(value);
    })
    .catch(() => {
      // A one-off early native initialization error previously left every
      // animation permanently OFF for the whole mounted session. Retry once
      // while subscribed; never turn motion on without an OS `false` result.
      if (epoch !== subscriptionEpoch || retryCount >= 1 || listeners.size === 0) return;
      retryCount += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        refreshOsPreference();
      }, 500);
    })
    .finally(() => {
      queryInFlight = false;
    });
}

function ensureSubscribed() {
  if (subscription) return;
  subscriptionEpoch += 1;
  retryCount = 0;
  subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setValue);
  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    // Reconcile OS accessibility state after native audio-focus/app transitions
    // without any continuous polling or animation-specific lifecycle authority.
    retryCount = 0;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    refreshOsPreference();
  });
  refreshOsPreference();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  ensureSubscribed();
  return () => {
    listeners.delete(callback);
    if (listeners.size !== 0) return;
    subscriptionEpoch += 1;
    subscription?.remove();
    subscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
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
 * Returns true when Reduce Motion is enabled or native accessibility state
 * cannot yet be verified. A transient query failure gets one bounded retry
 * and a foreground recheck; user-requested Reduced Motion remains authoritative.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
