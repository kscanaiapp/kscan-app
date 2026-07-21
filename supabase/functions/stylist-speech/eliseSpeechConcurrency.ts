import { StylistSpeechError } from './types.ts';

export const SPEECH_GLOBAL_CONCURRENCY = 8;
export const SPEECH_PER_ACTOR_CONCURRENCY = 2;
export const SPEECH_QUEUE_CAPACITY = 16;
export const SPEECH_QUEUE_TIMEOUT_MS = 3_000;

type QueueEntry = {
  actorId: string;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  enqueuedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Bounded speech concurrency admission.
 * Distinguishes global provider capacity from per-actor fairness.
 * Text generation must never call this gate.
 */
export class SpeechConcurrencyGate {
  private globalInFlight = 0;
  private readonly actorInFlight = new Map<string, number>();
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly globalLimit = SPEECH_GLOBAL_CONCURRENCY,
    private readonly perActorLimit = SPEECH_PER_ACTOR_CONCURRENCY,
    private readonly queueCapacity = SPEECH_QUEUE_CAPACITY,
    private readonly queueTimeoutMs = SPEECH_QUEUE_TIMEOUT_MS,
  ) {}

  async admit(actorId: string, nowMs = Date.now()): Promise<() => void> {
    this.drainExpired(nowMs);
    if (this.canAdmitImmediately(actorId)) {
      return this.acquire(actorId);
    }
    if (this.queue.length >= this.queueCapacity) {
      throw new StylistSpeechError(
        429,
        'BURST_LIMIT',
        'Speech generation is temporarily limited.',
      );
    }

    return await new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        actorId,
        resolve,
        reject,
        enqueuedAtMs: nowMs,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new StylistSpeechError(
            504,
            'PROVIDER_TIMEOUT',
            'Speech generation timed out.',
          ));
        }, this.queueTimeoutMs),
      };
      this.queue.push(entry);
    });
  }

  private canAdmitImmediately(actorId: string): boolean {
    const actorCount = this.actorInFlight.get(actorId) ?? 0;
    return this.globalInFlight < this.globalLimit && actorCount < this.perActorLimit;
  }

  private acquire(actorId: string): () => void {
    this.globalInFlight += 1;
    this.actorInFlight.set(actorId, (this.actorInFlight.get(actorId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalInFlight = Math.max(0, this.globalInFlight - 1);
      const nextActor = (this.actorInFlight.get(actorId) ?? 1) - 1;
      if (nextActor <= 0) this.actorInFlight.delete(actorId);
      else this.actorInFlight.set(actorId, nextActor);
      this.pump();
    };
  }

  private drainExpired(nowMs: number): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (nowMs - head.enqueuedAtMs < this.queueTimeoutMs) break;
      this.queue.shift();
      clearTimeout(head.timer);
      head.reject(new StylistSpeechError(
        504,
        'PROVIDER_TIMEOUT',
        'Speech generation timed out.',
      ));
    }
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (!this.canAdmitImmediately(head.actorId)) {
        // Fairness: if head cannot proceed, try later entries that can (skip monopolizing head
        // only when head is at per-actor cap but global capacity remains).
        let advanced = false;
        for (let i = 1; i < this.queue.length; i += 1) {
          const candidate = this.queue[i]!;
          if (this.canAdmitImmediately(candidate.actorId)) {
            this.queue.splice(i, 1);
            clearTimeout(candidate.timer);
            candidate.resolve(this.acquire(candidate.actorId));
            advanced = true;
            break;
          }
        }
        if (!advanced) break;
        continue;
      }
      this.queue.shift();
      clearTimeout(head.timer);
      head.resolve(this.acquire(head.actorId));
    }
  }

  /** Cancel queued work for an actor (account switch / stale). */
  cancelActor(actorId: string): number {
    let count = 0;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const entry = this.queue[i]!;
      if (entry.actorId !== actorId) continue;
      this.queue.splice(i, 1);
      clearTimeout(entry.timer);
      entry.reject(new StylistSpeechError(
        409,
        'DUPLICATE_REQUEST',
        'Speech request was cancelled.',
      ));
      count += 1;
    }
    return count;
  }

  snapshot(): { globalInFlight: number; queueLength: number; actors: number } {
    return {
      globalInFlight: this.globalInFlight,
      queueLength: this.queue.length,
      actors: this.actorInFlight.size,
    };
  }

  resetForTests(): void {
    for (const entry of this.queue) clearTimeout(entry.timer);
    this.queue.length = 0;
    this.globalInFlight = 0;
    this.actorInFlight.clear();
  }
}
