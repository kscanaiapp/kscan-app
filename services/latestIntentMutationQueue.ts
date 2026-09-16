/**
 * Coalesces rapid same-key mutation intents into a bounded call sequence.
 *
 * A tap that arrives while a mutation for the same key is already in flight
 * must not start a second network call immediately (that produces a mutation
 * storm) and must not be dropped either (that reads as an unresponsive
 * control). Instead it overwrites what the trailing call will send once the
 * in-flight one finishes, so N rapid taps on one key produce at most two
 * calls total — the one already running, plus one trailing call carrying
 * whatever was the LAST payload by the time it starts. That trailing call is
 * always launched with the latest intent, never an intermediate one.
 *
 * The runner decides for itself whether a completion is still authoritative
 * by calling `isSuperseded()` — true once a newer payload has been queued
 * behind it — so a caller can skip reconciling/rolling back a result that a
 * later tap has already made moot.
 */

type Runner<P> = (payload: P, isSuperseded: () => boolean) => Promise<void>;

type QueueEntry<P> = {
  inFlight: boolean;
  pending: P | null;
  // The runner to use for the NEXT drain iteration. Always the one passed to
  // the most recent submit(), so a trailing flush call runs with the caller's
  // freshest closure rather than whichever one happened to start the drain.
  run: Runner<P> | null;
};

export type LatestIntentQueue<P> = {
  /** Records the latest payload for `key` and ensures exactly one runner drains it. */
  submit(key: string, payload: P, run: Runner<P>): void;
  isInFlight(key: string): boolean;
};

export function createLatestIntentQueue<P>(): LatestIntentQueue<P> {
  const entries = new Map<string, QueueEntry<P>>();

  function getEntry(key: string): QueueEntry<P> {
    let entry = entries.get(key);
    if (!entry) {
      entry = { inFlight: false, pending: null, run: null };
      entries.set(key, entry);
    }
    return entry;
  }

  async function drain(key: string): Promise<void> {
    const entry = getEntry(key);
    entry.inFlight = true;
    try {
      while (entry.pending !== null) {
        const payload = entry.pending;
        const run = entry.run;
        entry.pending = null;
        if (!run) break;
        try {
          await run(payload, () => entry.pending !== null);
        } catch {
          // The runner owns its own error handling (rollback, user-facing
          // messaging); the queue only owns call sequencing.
        }
      }
    } finally {
      entry.inFlight = false;
    }
  }

  function submit(key: string, payload: P, run: Runner<P>): void {
    const entry = getEntry(key);
    entry.pending = payload;
    entry.run = run;
    if (entry.inFlight) return;
    void drain(key);
  }

  function isInFlight(key: string): boolean {
    return entries.get(key)?.inFlight ?? false;
  }

  return { submit, isInFlight };
}
