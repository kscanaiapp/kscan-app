/**
 * Coalesces rapid same-key mutation intents into one in-flight call plus at
 * most one trailing call carrying the latest payload.
 */
type Runner<P> = (payload: P, isSuperseded: () => boolean) => Promise<void>;

type QueueEntry<P> = {
  inFlight: boolean;
  pending: P | null;
  run: Runner<P> | null;
};

export type LatestIntentQueue<P> = {
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
          // Callers own rollback/user-facing errors; the queue owns sequencing.
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
