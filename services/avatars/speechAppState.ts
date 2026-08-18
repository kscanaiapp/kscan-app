import { AppState, type AppStateStatus } from 'react-native';

/**
 * AppState interruption binding for stylist speech.
 *
 * Ownership sits in the service layer, never in a UI component, so a mounted
 * avatar cannot install a second listener and a background event cannot be
 * missed while no avatar happens to be mounted. The handler this module invokes
 * is the caller's authoritative teardown, not a second one: `avatarSpeech.ts`
 * passes `stopAvatarSpeechPlayback`, so the generation bump, player stop,
 * temp-file delete and store reset stay in exactly one place. Backgrounding
 * therefore leaves the playing state immediately, a late native callback from
 * the interrupted generation is inert, and returning to the foreground never
 * resumes mid-sentence.
 *
 * The module owns no speech state of its own; it is a subscription only.
 */
type InterruptionHandler = () => void;

let handler: InterruptionHandler | null = null;
let subscription: { remove: () => void } | null = null;

function isInterrupted(status: AppStateStatus): boolean {
  // 'inactive' is the iOS transitional state (call sheet, app switcher, Control
  // Centre). It is treated as an interruption because playback is already
  // ducked or stopped by then, and resuming from it mid-sentence is the exact
  // behaviour this binding exists to prevent.
  return status !== 'active';
}

/** Register the single interruption handler. A later call replaces the earlier one. */
export function registerSpeechInterruptionHandler(next: InterruptionHandler | null): void {
  handler = next;
}

/** Idempotently install the AppState subscription. Safe to call on every request. */
export function ensureSpeechAppStateListener(): void {
  if (subscription) return;
  subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
    if (isInterrupted(status)) handler?.();
  });
}

export function resetSpeechAppStateForTests(): void {
  subscription?.remove();
  subscription = null;
  handler = null;
}
