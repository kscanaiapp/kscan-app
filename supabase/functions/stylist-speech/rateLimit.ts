import { StylistSpeechError } from './types.ts';

export const SPEECH_BURST_LIMIT = 3;
export const SPEECH_BURST_WINDOW_MS = 60_000;
export const SPEECH_DAILY_LIMIT = 50;

type DailyCounter = { day: string; count: number };

export class StylistSpeechRateLimiter {
  private readonly burstByActor = new Map<string, number[]>();
  private readonly dailyByActor = new Map<string, DailyCounter>();
  private readonly inFlight = new Set<string>();

  begin(actorId: string, operationKey: string, nowMs = Date.now()): () => void {
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
    this.inFlight.add(operationKey);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.delete(operationKey);
    };
  }

  resetForTests(): void {
    this.burstByActor.clear();
    this.dailyByActor.clear();
    this.inFlight.clear();
  }
}
