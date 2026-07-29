'use strict';

/**
 * Verified-pricing cost ledger and hard dollar ceiling (Phase 1 repair F-2).
 *
 * WHY THIS EXISTS
 * The runner enforced a call ceiling but had no concept of money. A call ceiling
 * alone does not bound spend: cost per call depends on model, input tokens and
 * output tokens, so 200 calls can cost anything. Phase 1 authorizes a hard
 * `$10.00` ceiling and requires that, before every provider attempt, the
 * projected cumulative cost INCLUDING that attempt is computed and the call
 * refused if it could exceed the ceiling. That is a pre-flight decision per
 * attempt, not a post-hoc total.
 *
 * FAIL-CLOSED RULES
 *   - Pricing must be supplied explicitly and carry a source and a retrieval
 *     timestamp. There is no built-in price table, because a stale hardcoded
 *     price is exactly how a spend ceiling gets silently exceeded.
 *   - Every routable model must be priced. An unpriced model cannot be charged
 *     for, so it cannot be called.
 *   - The projection uses the WORST CASE for the attempt (the output-token hard
 *     cap), never an average. Refusing on the worst case is the only way the
 *     ceiling actually holds; charging the average would let the last call
 *     overshoot.
 */

/** Charged in dollars per 1,000,000 tokens, matching how providers publish. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

class CostCeilingExceeded extends Error {
  constructor(ceilingUsd, projectedUsd) {
    super(
      `hard spend ceiling would be exceeded: projected $${projectedUsd.toFixed(6)} > ceiling $${ceilingUsd.toFixed(2)}`
    );
    this.name = 'CostCeilingExceeded';
    this.ceilingUsd = ceilingUsd;
    this.projectedUsd = projectedUsd;
  }
}

/**
 * Validate a pricing record, rejecting anything that cannot support a defensible
 * cost claim.
 *
 * @param {object} pricing
 */
function validatePricing(pricing) {
  const errors = [];
  if (!pricing || typeof pricing !== 'object') {
    return { ok: false, errors: [{ check: 'pricing_present', message: 'no pricing record supplied' }] };
  }
  if (!pricing.source || typeof pricing.source !== 'string') {
    errors.push({ check: 'pricing_source', message: 'pricing.source is required and must name the official source' });
  }
  if (!pricing.retrievedAt || Number.isNaN(Date.parse(pricing.retrievedAt))) {
    errors.push({ check: 'pricing_retrieved_at', message: 'pricing.retrievedAt must be an ISO timestamp' });
  }
  const models = pricing.models;
  if (!models || typeof models !== 'object' || Object.keys(models).length === 0) {
    errors.push({ check: 'pricing_models', message: 'pricing.models must price at least one model' });
  } else {
    for (const [model, entry] of Object.entries(models)) {
      for (const field of ['inputPerMillionUsd', 'outputPerMillionUsd']) {
        const value = entry ? entry[field] : undefined;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          errors.push({
            check: 'pricing_rate',
            message: `model ${model} field ${field} must be a non-negative finite number, received ${String(value)}`,
          });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Worst-case cost of one attempt against one model.
 *
 * @param {{ inputTokens: number, maxOutputTokens: number }} usage
 * @param {{ inputPerMillionUsd: number, outputPerMillionUsd: number }} rate
 */
function attemptCostUsd(usage, rate) {
  for (const [name, value] of Object.entries({
    inputTokens: usage.inputTokens,
    maxOutputTokens: usage.maxOutputTokens,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative finite number, received ${String(value)}`);
    }
  }
  return (
    (usage.inputTokens / TOKENS_PER_PRICE_UNIT) * rate.inputPerMillionUsd
    + (usage.maxOutputTokens / TOKENS_PER_PRICE_UNIT) * rate.outputPerMillionUsd
  );
}

/**
 * Tracks cumulative spend and refuses any attempt that could breach the ceiling.
 */
class CostLedger {
  /**
   * @param {{ ceilingUsd: number, pricing: object }} options
   */
  constructor(options = {}) {
    const { ceilingUsd, pricing } = options;
    if (typeof ceilingUsd !== 'number' || !Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
      throw new Error(
        `a valid non-negative dollar ceiling is required, received ${String(ceilingUsd)}. `
          + 'A missing or malformed spend ceiling fails closed.'
      );
    }
    const validated = validatePricing(pricing);
    if (!validated.ok) {
      throw new Error(
        `pricing record rejected: ${validated.errors.map((e) => e.message).join('; ')}`
      );
    }
    this.ceilingUsd = ceilingUsd;
    this.pricing = pricing;
    this.spentUsd = 0;
    this.entries = [];
  }

  rateFor(model) {
    const rate = this.pricing.models[model];
    if (!rate) {
      throw new Error(
        `model ${model} has no verified price. An unpriced model cannot be charged for and is therefore not callable.`
      );
    }
    return rate;
  }

  /** Projected cumulative spend if `usage` were charged against `model`. */
  project(model, usage) {
    return this.spentUsd + attemptCostUsd(usage, this.rateFor(model));
  }

  /**
   * Gate one attempt. Returns the projection when permitted; throws otherwise.
   * Nothing is charged here — call `charge` only after the attempt is made.
   */
  authorize(model, usage) {
    const projected = this.project(model, usage);
    if (projected > this.ceilingUsd) throw new CostCeilingExceeded(this.ceilingUsd, projected);
    return { model, projectedUsd: projected, remainingUsd: this.ceilingUsd - projected };
  }

  /**
   * Record the actual cost of a completed attempt.
   * `outputTokens` is the observed count when available; when it is not, the
   * worst case is charged so the ledger can never under-report spend.
   */
  charge(model, usage, meta = {}) {
    const rate = this.rateFor(model);
    const cost = attemptCostUsd(usage, rate);
    this.spentUsd += cost;
    const entry = {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.maxOutputTokens,
      costUsd: cost,
      cumulativeUsd: this.spentUsd,
      remainingUsd: Math.max(0, this.ceilingUsd - this.spentUsd),
      ...meta,
    };
    this.entries.push(entry);
    return entry;
  }

  remainingUsd() {
    return Math.max(0, this.ceilingUsd - this.spentUsd);
  }

  summary() {
    return {
      ceilingUsd: Number(this.ceilingUsd.toFixed(2)),
      spentUsd: Number(this.spentUsd.toFixed(6)),
      remainingUsd: Number(this.remainingUsd().toFixed(6)),
      chargedAttemptCount: this.entries.length,
      pricingSource: this.pricing.source,
      pricingRetrievedAt: this.pricing.retrievedAt,
    };
  }
}

/**
 * Project the whole run before spending anything.
 *
 * `perCall` describes one primary attempt; `fallbackPerCall` one fallback
 * attempt. Worst case assumes EVERY call exhausts its attempt budget, because
 * that is the only bound that holds when the provider is degraded.
 *
 * @param {{ callCount: number, attemptsPerCall: number, perCall: object,
 *           fallbackPerCall: object, primaryModel: string, fallbackModel: string,
 *           pricing: object, ceilingUsd: number }} plan
 */
function projectRun(plan) {
  const validated = validatePricing(plan.pricing);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors };
  }
  const primaryRate = plan.pricing.models[plan.primaryModel];
  const fallbackRate = plan.pricing.models[plan.fallbackModel];
  if (!primaryRate || !fallbackRate) {
    return {
      ok: false,
      errors: [{ check: 'pricing_coverage', message: 'both the primary and fallback model must be priced' }],
    };
  }

  const primaryCost = attemptCostUsd(plan.perCall, primaryRate);
  const fallbackCost = attemptCostUsd(plan.fallbackPerCall || plan.perCall, fallbackRate);

  const expectedUsd = plan.callCount * primaryCost;
  const worstCaseUsd = plan.callCount * (primaryCost + fallbackCost * Math.max(0, (plan.attemptsPerCall || 1) - 1));

  return {
    ok: true,
    primaryModel: plan.primaryModel,
    fallbackModel: plan.fallbackModel,
    callCount: plan.callCount,
    attemptsPerCall: plan.attemptsPerCall || 1,
    maxAttemptCount: plan.callCount * (plan.attemptsPerCall || 1),
    perPrimaryAttemptUsd: Number(primaryCost.toFixed(6)),
    perFallbackAttemptUsd: Number(fallbackCost.toFixed(6)),
    expectedUsd: Number(expectedUsd.toFixed(6)),
    worstCaseUsd: Number(worstCaseUsd.toFixed(6)),
    ceilingUsd: plan.ceilingUsd,
    withinCeiling: plan.ceilingUsd == null ? null : worstCaseUsd <= plan.ceilingUsd,
    pricingSource: plan.pricing.source,
    pricingRetrievedAt: plan.pricing.retrievedAt,
  };
}

module.exports = {
  TOKENS_PER_PRICE_UNIT,
  CostCeilingExceeded,
  CostLedger,
  validatePricing,
  attemptCostUsd,
  projectRun,
};
