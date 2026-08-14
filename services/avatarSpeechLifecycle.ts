import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

// Service-layer ownership of the app-interruption boundary for avatar speech
// and motion. UI components must never own this lifecycle: a component can
// unmount (or never mount) while native audio keeps playing, so the reset
// authority has to live beside the speech service itself.
//
// V1 background policy: entering the background is a hard interruption.
// Playback stops, the active generation is invalidated, motion returns to
// neutral, and nothing auto-resumes mid-sentence on foreground.

export type AvatarInterruptionReason = 'app-background' | 'app-inactive';

export type AvatarInterruptionHandler = (reason: AvatarInterruptionReason) => void;

/**
 * App states treated as interruptions. `background` covers Android/iOS
 * backgrounding; `inactive` covers the exposed iOS foreground interruptions
 * (incoming call, app switcher) that also pause audible playback focus.
 */
export const AVATAR_SPEECH_INTERRUPTING_APP_STATES: readonly AppStateStatus[] = Object.freeze([
  'background',
  'inactive',
]);

const handlers = new Set<AvatarInterruptionHandler>();
let subscription: NativeEventSubscription | null = null;

// Foreground tracking for continuous motion. Interruption handlers exist to
// tear speech down; motion additionally needs to know when the app comes
// back so idle loops can resume. Both are served by the single AppState
// subscription below — motion never adds a second one.
let appForeground = true;
const foregroundListeners = new Set<() => void>();

function reasonForAppState(state: AppStateStatus): AvatarInterruptionReason {
  return state === 'inactive' ? 'app-inactive' : 'app-background';
}

function setAppForeground(next: boolean): void {
  if (next === appForeground) return;
  appForeground = next;
  for (const listener of [...foregroundListeners]) {
    try {
      listener();
    } catch {
      // A subscriber cannot break foreground propagation for the others.
    }
  }
}

function handleAppStateChange(nextState: AppStateStatus): void {
  if (!AVATAR_SPEECH_INTERRUPTING_APP_STATES.includes(nextState)) {
    setAppForeground(true);
    return;
  }
  setAppForeground(false);
  const reason = reasonForAppState(nextState);
  for (const handler of [...handlers]) {
    try {
      handler(reason);
    } catch {
      // One failing handler must not prevent the others from resetting.
    }
  }
}

/** True while the app is foregrounded. Motion must not run otherwise. */
export function getAvatarAppForegroundSnapshot(): boolean {
  return appForeground;
}

/**
 * Subscribe to foreground/background transitions. Installs the shared
 * AppState listener on first use and releases nothing else; the listener is
 * owned by ensureAvatarSpeechLifecycleListener/teardown as before.
 */
export function subscribeToAvatarAppForeground(listener: () => void): () => void {
  ensureAvatarSpeechLifecycleListener();
  foregroundListeners.add(listener);
  return () => {
    foregroundListeners.delete(listener);
  };
}

/**
 * Register a handler invoked on every app interruption. Registration is
 * idempotent per function identity. Returns an unregister function.
 */
export function registerAvatarInterruptionHandler(
  handler: AvatarInterruptionHandler,
): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Idempotently install the single AppState subscription that drives avatar
 * speech/motion interruption. Safe to call from any service entry point;
 * repeated calls are no-ops while a subscription is retained.
 */
export function ensureAvatarSpeechLifecycleListener(): void {
  if (subscription) return;
  subscription = AppState.addEventListener('change', handleAppStateChange);
}

/**
 * Explicit teardown for tests and hot reload. Removes the retained
 * subscription and clears the handle so a later ensure call installs exactly
 * one new subscription.
 */
export function teardownAvatarSpeechLifecycleListener(): void {
  subscription?.remove();
  subscription = null;
  // A torn-down listener can no longer observe backgrounding, so the cached
  // foreground value must not be trusted afterwards.
  appForeground = true;
}

/** True while an AppState subscription is retained. Exposed for tests. */
export function isAvatarSpeechLifecycleListenerActive(): boolean {
  return subscription !== null;
}

/** Test hook: dispatch an interruption without a native AppState event. */
export function simulateAvatarInterruptionForTests(state: AppStateStatus): void {
  handleAppStateChange(state);
}

/** Test hook: number of registered interruption handlers. */
export function getAvatarInterruptionHandlerCountForTests(): number {
  return handlers.size;
}
