/**
 * Minimal single-flight guard for user-initiated network actions.
 *
 * WHY THIS EXISTS (DEF-B29-IOS-02B): the previous Dressing Room safety
 * controls latched an in-flight ref *before* presenting a confirmation
 * `Alert`, and relied on `Alert`'s `onDismiss` option to release it. That
 * option is Android-only (`@platform android` in React Native's
 * `Alert.d.ts`), so on iOS any dismissal that never invoked a button left the
 * latch stuck `true` for the life of the mounted panel — every later tap
 * returned instantly with no confirmation, no error, and no state change.
 *
 * The contract this encodes instead:
 *   * the latch is taken at `run()` time — i.e. immediately before the async
 *     work — never while a dialog is merely visible;
 *   * it is ALWAYS released in a `finally`, so success, failure, and throw all
 *     leave the guard usable;
 *   * a concurrent `run()` is rejected without invoking the operation, so
 *     rapid taps cannot produce duplicate server calls.
 *
 * Cancelling a confirmation therefore releases nothing, because nothing was
 * ever taken. No timers are involved: a timeout-based reset would reintroduce
 * a window where the guard is wrong.
 */
export type SingleFlight = {
  /** True while an operation started through `run` is still pending. */
  readonly isRunning: boolean;
  /**
   * Runs `operation` unless one is already in flight.
   * Returns the operation's value, or `undefined` when it was skipped.
   * Rejections propagate to the caller after the guard is released.
   */
  run<T>(operation: () => Promise<T>): Promise<T | undefined>;
};

export function createSingleFlight(): SingleFlight {
  let inFlight = false;
  return {
    get isRunning() {
      return inFlight;
    },
    async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
      if (inFlight) return undefined;
      inFlight = true;
      try {
        return await operation();
      } finally {
        inFlight = false;
      }
    },
  };
}
