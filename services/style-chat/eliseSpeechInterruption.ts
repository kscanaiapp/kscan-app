// Elise speech interruption from the composer.
//
// The product rule: the moment the user reaches for the composer — focusing it
// or typing into it — Elise stops talking. Interrupting is an ordinary,
// intentional user action, so it is NOT a failure: the reply text stays exactly
// where it is, no error state is entered, and nothing is retried.
//
// This module owns only the DECISION, so it can be tested without a renderer:
//   - was Elise actually audible, for THIS actor and THIS session, right now?
// The stop itself remains avatarSpeech.stopAvatarSpeechPlayback, which is the
// single authoritative teardown (generation bump, player stop, temp-file
// delete, store reset). Nothing here becomes a second speech-lifecycle system.
//
// Why the decision is separate from the stop: stopAvatarSpeechPlayback is a
// scope-safe no-op when nothing matches, so calling it on every keystroke is
// harmless — but firing haptic feedback on every keystroke is not. Feedback
// must confirm an interruption that genuinely happened.

import type { AvatarSpeechState } from '../../stores/avatarSpeechStore';

/** What made the user reach for the composer. */
export type EliseSpeechInterruptionTrigger = 'focus' | 'typing' | 'send';

export type EliseSpeechInterruptionScope = {
  actorId: string | null;
  sessionId: string;
  avatarId: string;
};

/**
 * Phases in which audio is either already audible or imminently will be.
 *
 * 'requesting' and 'ready' are included deliberately: a user who starts typing
 * while the audio is still being fetched must not have it begin a moment later.
 * 'stopping' is excluded — a stop is already under way. 'error' is excluded —
 * there is nothing to interrupt, and buzzing there would report success for a
 * failure the user did not cause.
 */
const INTERRUPTIBLE_PHASES = new Set<AvatarSpeechState['phase']>([
  'requesting',
  'ready',
  'playing',
]);

/**
 * True only when Elise is (or is about to be) audible for exactly this actor,
 * session and stylist. Fails closed: a null actor, a scope mismatch, or an
 * unknown phase all return false.
 */
export function isEliseSpeechInterruptible(
  state: AvatarSpeechState,
  scope: EliseSpeechInterruptionScope,
): boolean {
  if (!scope.actorId || !scope.sessionId || !scope.avatarId) return false;
  if (!INTERRUPTIBLE_PHASES.has(state.phase)) return false;
  return (
    state.actorId === scope.actorId &&
    state.sessionId === scope.sessionId &&
    state.avatarId === scope.avatarId
  );
}

/**
 * Should this composer interaction interrupt Elise, and should it be confirmed
 * with haptic feedback?
 *
 * `interrupt` and `confirm` are separate answers. Typing always requests the
 * stop (cheap and scope-safe), but only an interruption that actually silenced
 * audible speech is confirmed — so a user typing into a silent composer never
 * feels a phantom buzz, and a user who cuts Elise off gets a single
 * acknowledgement rather than one per character.
 */
export function planEliseSpeechInterruption(input: {
  trigger: EliseSpeechInterruptionTrigger;
  state: AvatarSpeechState;
  scope: EliseSpeechInterruptionScope;
  /** Typing only: an empty composer (e.g. backspacing to nothing). */
  isComposerEmpty?: boolean;
}): { interrupt: boolean; confirm: boolean } {
  const audible = isEliseSpeechInterruptible(input.state, input.scope);

  if (input.trigger === 'send') {
    // Sending always clears the way for the next reply, but it is its own
    // acknowledged action; it does not also need an interruption buzz.
    return { interrupt: true, confirm: false };
  }

  if (input.trigger === 'typing' && input.isComposerEmpty) {
    // Backspacing to empty is not reaching for the composer; focus already
    // covered that, and stopping again here would be noise.
    return { interrupt: false, confirm: false };
  }

  return { interrupt: audible, confirm: audible };
}
