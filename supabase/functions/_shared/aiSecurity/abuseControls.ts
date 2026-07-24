/**
 * Objective abuse controls for schema-invalid / unauthorized model-action bursts.
 * Never suspend a user solely because their text resembles prompt injection.
 */

export type AbuseCategory =
  | 'schema_invalid'
  | 'unsupported_action'
  | 'cross_user'
  | 'forbidden_executable'
  | 'oversized_payload'
  | 'malformed_payload'
  | 'delimiter_breakout';

export type AbuseDecision =
  | { throttled: false; count: number }
  | { throttled: true; count: number; retryAfterSeconds: number; category: AbuseCategory };

type AbuseBucket = {
  count: number;
  windowStartedAt: number;
  category: AbuseCategory;
};

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_THRESHOLD = 8;
const DEFAULT_RETRY_SECONDS = 60;

const buckets = new Map<string, AbuseBucket>();

function bucketKey(actorRef: string, entryPoint: string, category: AbuseCategory): string {
  return `${entryPoint}:${actorRef}:${category}`;
}

export function recordObjectiveAbuse(input: {
  actorRef: string;
  entryPoint: 'elise' | 'typechat';
  category: AbuseCategory;
  nowMs?: number;
  windowMs?: number;
  threshold?: number;
  retryAfterSeconds?: number;
}): AbuseDecision {
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const retryAfterSeconds = input.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
  const key = bucketKey(input.actorRef, input.entryPoint, input.category);
  const existing = buckets.get(key);

  if (!existing || nowMs - existing.windowStartedAt > windowMs) {
    buckets.set(key, {
      count: 1,
      windowStartedAt: nowMs,
      category: input.category,
    });
    return { throttled: false, count: 1 };
  }

  existing.count += 1;
  buckets.set(key, existing);
  if (existing.count > threshold) {
    return {
      throttled: true,
      count: existing.count,
      retryAfterSeconds,
      category: input.category,
    };
  }
  return { throttled: false, count: existing.count };
}

/** Test helper — clears in-memory buckets. */
export function resetAbuseControlsForTests(): void {
  buckets.clear();
}
