import { StylistSpeechError } from './types.ts';
import type { EliseSpeechCircuitState, EliseSpeechErrorClass } from './eliseSpeechTypes.ts';

export type SpeechRetryClass = EliseSpeechErrorClass;

export interface SpeechCircuitSnapshot {
  state: EliseSpeechCircuitState;
  failures: number;
  openedUntilMs: number;
  halfOpenProbeActive: boolean;
}

interface InternalCircuitState {
  state: EliseSpeechCircuitState;
  failures: number;
  openedUntilMs: number;
  halfOpenProbeActive: boolean;
}

/**
 * Provider-scoped circuit breaker with explicit closed / open / half_open states.
 * One half-open probe at a time. Actor-local invalid requests must not call recordFailure.
 */
export class SpeechCircuitBreaker {
  private readonly stateByProvider = new Map<string, InternalCircuitState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options?: { failureThreshold?: number; cooldownMs?: number }) {
    this.failureThreshold = options?.failureThreshold ?? 3;
    this.cooldownMs = options?.cooldownMs ?? 60_000;
  }

  getState(provider: string, nowMs = Date.now()): EliseSpeechCircuitState {
    return this.snapshot(provider, nowMs).state;
  }

  snapshot(provider: string, nowMs = Date.now()): SpeechCircuitSnapshot {
    const state = this.ensureTransition(provider, nowMs);
    if (!state) {
      return { state: 'closed', failures: 0, openedUntilMs: 0, halfOpenProbeActive: false };
    }
    return {
      state: state.state,
      failures: state.failures,
      openedUntilMs: state.openedUntilMs,
      halfOpenProbeActive: state.halfOpenProbeActive,
    };
  }

  canAttempt(provider: string, nowMs = Date.now()): boolean {
    const state = this.ensureTransition(provider, nowMs);
    if (!state || state.state === 'closed') return true;
    if (state.state === 'open') return false;
    // half_open: only one probe
    return !state.halfOpenProbeActive;
  }

  /** Reserve the single half-open probe slot. Returns false if another probe is active. */
  beginProbe(provider: string, nowMs = Date.now()): boolean {
    const state = this.ensureTransition(provider, nowMs);
    if (!state || state.state === 'closed') return true;
    if (state.state === 'open') return false;
    if (state.halfOpenProbeActive) return false;
    state.halfOpenProbeActive = true;
    return true;
  }

  recordSuccess(provider: string): void {
    this.stateByProvider.delete(provider);
  }

  recordFailure(provider: string, nowMs = Date.now(), cooldownMs = this.cooldownMs): void {
    const prior = this.stateByProvider.get(provider) ?? {
      state: 'closed' as const,
      failures: 0,
      openedUntilMs: 0,
      halfOpenProbeActive: false,
    };

    if (prior.state === 'half_open') {
      this.stateByProvider.set(provider, {
        state: 'open',
        failures: prior.failures + 1,
        openedUntilMs: nowMs + cooldownMs,
        halfOpenProbeActive: false,
      });
      return;
    }

    const failures = prior.failures + 1;
    if (failures >= this.failureThreshold) {
      this.stateByProvider.set(provider, {
        state: 'open',
        failures,
        openedUntilMs: nowMs + cooldownMs,
        halfOpenProbeActive: false,
      });
      return;
    }

    this.stateByProvider.set(provider, {
      state: 'closed',
      failures,
      openedUntilMs: 0,
      halfOpenProbeActive: false,
    });
  }

  private ensureTransition(provider: string, nowMs: number): InternalCircuitState | null {
    const state = this.stateByProvider.get(provider);
    if (!state) return null;
    if (state.state === 'open' && state.openedUntilMs <= nowMs) {
      const halfOpen: InternalCircuitState = {
        state: 'half_open',
        failures: state.failures,
        openedUntilMs: 0,
        halfOpenProbeActive: false,
      };
      this.stateByProvider.set(provider, halfOpen);
      return halfOpen;
    }
    return state;
  }

  resetForTests(): void {
    this.stateByProvider.clear();
  }
}

export function stableClassForSpeechError(error: unknown): SpeechRetryClass {
  if (!(error instanceof StylistSpeechError)) return 'UNKNOWN_PROVIDER_ERROR';
  if (error.code === 'PROVIDER_TIMEOUT') return 'PROVIDER_TIMEOUT';
  if (error.code === 'PROVIDER_RATE_LIMIT') return 'RATE_LIMIT';
  if (error.code === 'PROVIDER_QUOTA_EXCEEDED') return 'QUOTA_EXHAUSTED';
  if (error.code === 'PROVIDER_AUTH_FAILED') return 'AUTHENTICATION_FAILURE';
  if (error.code === 'PROVIDER_VOICE_UNAVAILABLE') return 'VOICE_NOT_FOUND';
  if (error.code === 'PROVIDER_MODEL_UNAVAILABLE') return 'MODEL_NOT_AVAILABLE';
  if (error.code === 'PROVIDER_INVALID_REQUEST') return 'INVALID_REQUEST';
  if (error.code === 'PROVIDER_RESPONSE_INVALID') return 'MALFORMED_AUDIO';
  if (error.code === 'PROVIDER_UNAVAILABLE') return 'PROVIDER_BUSY';
  if (error.code === 'DUPLICATE_REQUEST') return 'OPERATION_CANCELLED';
  if (
    error.code === 'INVALID_REQUEST' ||
    error.code === 'MESSAGE_INELIGIBLE' ||
    error.code === 'STYLIST_UNSUPPORTED' ||
    error.code === 'STYLIST_SILENT' ||
    error.code === 'STYLIST_MISMATCH' ||
    error.code === 'SESSION_NOT_FOUND' ||
    error.code === 'MESSAGE_NOT_FOUND' ||
    error.code === 'BURST_LIMIT' ||
    error.code === 'DAILY_LIMIT' ||
    error.code === 'NOT_AUTHENTICATED' ||
    error.code === 'ACCOUNT_UNAVAILABLE'
  ) return 'INVALID_REQUEST';
  return 'UNKNOWN_PROVIDER_ERROR';
}

export function shouldRetrySpeechError(input: {
  error: unknown;
  retryCount: number;
  retryAfterSeconds?: number | null;
  remainingBudgetMs: number;
}): boolean {
  if (input.retryCount >= 1 || input.remainingBudgetMs <= 250) return false;
  const stableClass = stableClassForSpeechError(input.error);
  if (
    stableClass === 'QUOTA_EXHAUSTED' ||
    stableClass === 'AUTHENTICATION_FAILURE' ||
    stableClass === 'VOICE_NOT_FOUND' ||
    stableClass === 'MODEL_NOT_AVAILABLE' ||
    stableClass === 'INVALID_REQUEST' ||
    stableClass === 'MALFORMED_AUDIO' ||
    stableClass === 'EMPTY_AUDIO' ||
    stableClass === 'ALIGNMENT_INVALID' ||
    stableClass === 'OPERATION_CANCELLED' ||
    stableClass === 'OPERATION_STALE'
  ) return false;
  if (stableClass === 'RATE_LIMIT' || stableClass === 'CONCURRENCY_LIMIT') {
    return input.retryAfterSeconds != null &&
      input.retryAfterSeconds * 1000 < input.remainingBudgetMs;
  }
  return stableClass === 'PROVIDER_BUSY' ||
    stableClass === 'PROVIDER_TIMEOUT' ||
    stableClass === 'NETWORK_FAILURE';
}

/**
 * Only provider-infrastructure failures advance the shared circuit breaker.
 * Actor-local / request-shape / voice-specific errors must never disable speech globally.
 */
export function shouldRecordSpeechCircuitFailure(error: unknown): boolean {
  const stableClass = stableClassForSpeechError(error);
  return (
    stableClass === 'PROVIDER_BUSY' ||
    stableClass === 'PROVIDER_TIMEOUT' ||
    stableClass === 'NETWORK_FAILURE' ||
    stableClass === 'RATE_LIMIT' ||
    stableClass === 'CONCURRENCY_LIMIT' ||
    stableClass === 'QUOTA_EXHAUSTED' ||
    stableClass === 'AUTHENTICATION_FAILURE' ||
    stableClass === 'UNKNOWN_PROVIDER_ERROR'
  );
}
