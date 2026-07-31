'use strict';

/**
 * Provider-attempt accounting and latency capture (Phase 1 repairs F-5 and F-6).
 *
 * WHY THIS EXISTS
 *
 * The runner reserved budget with `budget.consume(plan.plannedCallCount)` once
 * per case, BEFORE the executor ran, and reported that number as
 * `executedCallCount`. Three things were therefore wrong at once:
 *
 *   1. Retries and fallback attempts were invisible. The certified route allows
 *      `SCANNER_MAX_ATTEMPTS = 2` per logical call, so provider attempts can be
 *      twice the governed one-input-per-case plan. A ceiling enforced against
 *      planned calls does not bound provider attempts at all.
 *   2. A logical call and a provider attempt were conflated, so the required
 *      separate counts — model-route invocations, provider invocations, fallback
 *      attempts, retries, completed, failed — could not be produced.
 *   3. Budget was consumed for work that had not happened, so a case that failed
 *      before its first attempt still spent ceiling.
 *
 * This module counts what actually happened, at the granularity the provider
 * bills at, and treats the ceiling as a pre-attempt gate.
 *
 * A MOCK ROUTE INVOCATION IS NOT A PROVIDER CALL. `recordRouteInvocation` and
 * `recordProviderAttempt` are deliberately separate entry points so a
 * deterministic mock run reports zero provider attempts and zero cost while
 * still exercising the route.
 */

class AttemptCeilingExceeded extends Error {
  constructor(ceiling, attempted) {
    super(`hard provider-attempt ceiling reached: ${attempted} would exceed ${ceiling}`);
    this.name = 'AttemptCeilingExceeded';
    this.ceiling = ceiling;
    this.attempted = attempted;
  }
}

/** Terminal outcomes for one provider attempt. */
const OUTCOMES = Object.freeze(['ok', 'failed_retryable', 'failed_permanent']);

class ProviderAccount {
  /**
   * @param {{ maxAttempts: number }} options hard ceiling on PROVIDER ATTEMPTS
   */
  constructor(options = {}) {
    const { maxAttempts } = options;
    if (maxAttempts == null) {
      throw new Error(
        'a provider-attempt ceiling is required. A missing ceiling fails closed rather than defaulting to unbounded.'
      );
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
      throw new Error(`provider-attempt ceiling must be a non-negative integer, received ${String(maxAttempts)}`);
    }
    this.maxAttempts = maxAttempts;
    this.counters = {
      routeInvocations: 0,
      providerAttempts: 0,
      primaryAttempts: 0,
      fallbackAttempts: 0,
      retries: 0,
      completedCalls: 0,
      failedCalls: 0,
      mockRouteInvocations: 0,
      unexpectedNetworkAttempts: 0,
    };
    this.attempts = [];
    this.latenciesMs = [];
  }

  /** A logical identification through the adapter. Not billable on its own. */
  recordRouteInvocation({ mock = false } = {}) {
    this.counters.routeInvocations += 1;
    if (mock) this.counters.mockRouteInvocations += 1;
    return this.counters.routeInvocations;
  }

  /**
   * Gate one provider attempt BEFORE it is made.
   * Throws rather than allowing the ceiling to be crossed.
   */
  authorizeAttempt() {
    const next = this.counters.providerAttempts + 1;
    if (next > this.maxAttempts) throw new AttemptCeilingExceeded(this.maxAttempts, next);
    return { attemptIndex: next, remaining: this.maxAttempts - next };
  }

  /**
   * Record one attempt that actually reached the provider.
   *
   * @param {{ model: string, attemptIndex: number, isFallback: boolean,
   *           isRetry?: boolean, outcome: string, latencyMs: number,
   *           caseId?: string, imageRef?: string }} attempt
   */
  recordProviderAttempt(attempt) {
    if (!OUTCOMES.includes(attempt.outcome)) {
      throw new Error(`unknown provider attempt outcome ${attempt.outcome}; expected ${OUTCOMES.join(', ')}`);
    }
    if (!Number.isFinite(attempt.latencyMs) || attempt.latencyMs < 0) {
      throw new Error(`latencyMs must be a non-negative finite number, received ${String(attempt.latencyMs)}`);
    }
    this.counters.providerAttempts += 1;
    if (attempt.isFallback) this.counters.fallbackAttempts += 1;
    else this.counters.primaryAttempts += 1;
    if (attempt.isRetry) this.counters.retries += 1;
    this.latenciesMs.push(attempt.latencyMs);
    // The record carries operation metadata only — never a prompt, image bytes,
    // base64 payload, token or credential.
    this.attempts.push({
      caseId: attempt.caseId || null,
      imageRef: attempt.imageRef || null,
      model: attempt.model,
      attemptIndex: attempt.attemptIndex,
      isFallback: Boolean(attempt.isFallback),
      isRetry: Boolean(attempt.isRetry),
      outcome: attempt.outcome,
      latencyMs: attempt.latencyMs,
    });
    return this.counters.providerAttempts;
  }

  recordCallOutcome(ok) {
    if (ok) this.counters.completedCalls += 1;
    else this.counters.failedCalls += 1;
  }

  /** Any request to a host the run did not authorize is an emergency-stop signal. */
  recordUnexpectedNetworkAttempt() {
    this.counters.unexpectedNetworkAttempts += 1;
    return this.counters.unexpectedNetworkAttempts;
  }

  remainingAttempts() {
    return Math.max(0, this.maxAttempts - this.counters.providerAttempts);
  }

  /** Fallback rate over logical calls, with the denominator stated. */
  fallbackRate() {
    const denominator = this.counters.routeInvocations;
    return {
      fallbackAttempts: this.counters.fallbackAttempts,
      denominator,
      rate: denominator === 0 ? null : this.counters.fallbackAttempts / denominator,
    };
  }

  latencyDistribution() {
    if (this.latenciesMs.length === 0) {
      return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null };
    }
    const sorted = this.latenciesMs.slice().sort((a, b) => a - b);
    const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
      count: sorted.length,
      minMs: sorted[0],
      p50Ms: quantile(0.5),
      p95Ms: quantile(0.95),
      maxMs: sorted[sorted.length - 1],
      meanMs: Number((sum / sorted.length).toFixed(1)),
    };
  }

  summary() {
    return {
      ...this.counters,
      attemptCeiling: this.maxAttempts,
      remainingAttempts: this.remainingAttempts(),
      fallback: this.fallbackRate(),
      latency: this.latencyDistribution(),
    };
  }
}

module.exports = {
  OUTCOMES,
  AttemptCeilingExceeded,
  ProviderAccount,
};
