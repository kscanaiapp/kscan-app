import { StylistSpeechError } from './types.ts';

export const SPEECH_BURST_LIMIT = 3;
export const SPEECH_BURST_WINDOW_MS = 60_000;
export const SPEECH_DAILY_LIMIT = 50;

type DailyCounter = { day: string; count: number };

export interface SpeechQuotaBeginOptions {
  /**
   * When true (E-3 resilience path), daily quota is reserved and refunded on
   * release unless commitDaily(operationKey) was called after success.
   */
  deferDailyCommit?: boolean;
}

/**
 * Application speech quota + in-flight dedupe.
 * Distinct from provider-account quota (ElevenLabs).
 * Message/text generation never consults this limiter.
 */
export class StylistSpeechRateLimiter {
  private readonly burstByActor = new Map<string, number[]>();
  private readonly dailyByActor = new Map<string, DailyCounter>();
  private readonly inFlight = new Set<string>();
  private readonly pendingDaily = new Map<string, { actorId: string; day: string }>();
  private readonly committedDaily = new Set<string>();

  begin(
    actorId: string,
    operationKey: string,
    nowMs = Date.now(),
    options: SpeechQuotaBeginOptions = {},
  ): () => void {
    if (this.inFlight.has(operationKey)) {
      throw new StylistSpeechError(409, 'DUPLICATE_REQUEST', 'Speech is already being prepared.');
    }

    const burstCutoff = nowMs - SPEECH_BURST_WINDOW_MS;
    const burst = (this.burstByActor.get(actorId) ?? []).filter((value) => value > burstCutoff);
    if (burst.length >= SPEECH_BURST_LIMIT) {
      this.burstByActor.set(actorId, burst);
      throw new StylistSpeechError(429, 'BURST_LIMIT', 'Speech requests are arriving too quickly.');
    }

    const day = new Date(nowMs).toISOString().slice(0, 10);
    const daily = this.dailyByActor.get(actorId);
    const dailyCount = daily?.day === day ? daily.count : 0;
    if (dailyCount >= SPEECH_DAILY_LIMIT) {
      throw new StylistSpeechError(429, 'DAILY_LIMIT', 'The daily speech limit has been reached.');
    }

    burst.push(nowMs);
    this.burstByActor.set(actorId, burst);
    this.dailyByActor.set(actorId, { day, count: dailyCount + 1 });

    if (options.deferDailyCommit === true) {
      this.pendingDaily.set(operationKey, { actorId, day });
    }

    this.inFlight.add(operationKey);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.delete(operationKey);
      const pending = this.pendingDaily.get(operationKey);
      if (pending && !this.committedDaily.has(operationKey)) {
        const current = this.dailyByActor.get(pending.actorId);
        if (current && current.day === pending.day && current.count > 0) {
          this.dailyByActor.set(pending.actorId, { day: pending.day, count: current.count - 1 });
        }
      }
      this.pendingDaily.delete(operationKey);
      this.committedDaily.delete(operationKey);
    };
  }

  /** Permanently consume the reserved daily unit for a deferred reservation. */
  commitDaily(operationKey: string): void {
    if (this.pendingDaily.has(operationKey)) {
      this.committedDaily.add(operationKey);
    }
  }

  resetForTests(): void {
    this.burstByActor.clear();
    this.dailyByActor.clear();
    this.inFlight.clear();
    this.pendingDaily.clear();
    this.committedDaily.clear();
  }
}
