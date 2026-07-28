export type EliseVisualPreparationJob = {
  actorKey: string;
  sessionId: string;
  entryId: string;
  rawUri: string;
  revision: number;
  /**
   * Elise V2 rollout flag, latched once for the whole selection (Phase 2B.3).
   *
   * Carried ON THE JOB rather than read inside the worker: a six-image selection
   * queues six jobs that run over several seconds at concurrency 2, and a worker
   * that re-read the flag could identify the first two images under one contract
   * and the rest under another inside a single attachment operation.
   *
   * Typed loosely to keep this queue free of a dependency on the adapter module.
   */
  sessionFlag?: { readonly enabled: boolean };
};

type QueueOptions = {
  run: (job: EliseVisualPreparationJob) => Promise<void>;
  isCurrent: (job: EliseVisualPreparationJob) => boolean;
  maxConcurrency?: number;
};

function jobKey(job: EliseVisualPreparationJob): string {
  return `${job.actorKey}:${job.sessionId}:${job.entryId}:${job.revision}`;
}

/** FIFO local preparation queue with bounded concurrency and stale-job pruning. */
export function createEliseVisualContextQueue({
  run,
  isCurrent,
  maxConcurrency = 2,
}: QueueOptions) {
  const pending: EliseVisualPreparationJob[] = [];
  const active = new Set<string>();
  const limit = Math.max(1, Math.floor(maxConcurrency));

  const pump = () => {
    while (active.size < limit && pending.length > 0) {
      const job = pending.shift();
      if (!job || !isCurrent(job)) continue;
      const key = jobKey(job);
      if (active.has(key)) continue;
      active.add(key);
      void Promise.resolve(run(job))
        .catch(() => undefined)
        .finally(() => {
          active.delete(key);
          pump();
        });
    }
  };

  return {
    enqueue(job: EliseVisualPreparationJob): boolean {
      const key = jobKey(job);
      if (active.has(key) || pending.some((queued) => jobKey(queued) === key)) return false;
      pending.push(job);
      pump();
      return true;
    },
    cancelEntry(actorKey: string, sessionId: string, entryId: string): void {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const job = pending[index];
        if (job.actorKey === actorKey && job.sessionId === sessionId && job.entryId === entryId) {
          pending.splice(index, 1);
        }
      }
    },
    cancelScope(actorKey: string, sessionId: string): void {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const job = pending[index];
        if (job.actorKey === actorKey && job.sessionId === sessionId) pending.splice(index, 1);
      }
    },
    snapshot(): { active: number; pending: EliseVisualPreparationJob[] } {
      return { active: active.size, pending: [...pending] };
    },
  };
}
