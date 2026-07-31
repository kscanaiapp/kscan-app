'use strict';

/**
 * countTokens preflight, reservation lifecycle, and preflight counters.
 *
 * WHY A LEDGER RATHER THAN A RUNNING TOTAL
 * A spend ceiling that is checked against confirmed spend alone is not a
 * ceiling: between the check and the response, an in-flight case can cost
 * anything up to its worst case. So every case is RESERVED at its conservative
 * maximum before dispatch, and the reservation is later replaced by confirmed
 * usage or released. At all times
 *
 *   confirmed + outstanding reservations <= ceiling
 *
 * holds, which is the property that actually bounds spend.
 *
 * THE CERTIFIED FALLBACK IS RESERVED UP FRONT
 * The certified attempt loop lives inside the Deno handler and may reach its
 * approved fallback with no further gate. Counting the fallback only after the
 * primary fails would let it cross the ceiling once the case is already inside
 * the production-equivalent loop. Both models are therefore counted and reserved
 * before the primary is dispatched.
 *
 * PER-MODEL COUNTS, NEVER SHARED
 * Primary and fallback are different models and may tokenize the same payload
 * differently. Reusing one count for both is an unproven equivalence, so each
 * model is counted separately and a shared count is refused.
 */

const crypto = require('crypto');

const RESERVATION_CONTRACT_VERSION = '1.0.0';
const CERTIFIED_MAX_OUTPUT_TOKENS = 2048;

/** countTokens is evaluation infrastructure; its policy is NOT the v140 policy. */
const COUNT_TOKENS_POLICY = Object.freeze({
  timeoutMs: 14_000,
  maxAttemptsPerModelPerCase: 2,
  retryableHttp: Object.freeze([429, 503, 504]),
  retryableNetwork: Object.freeze(['ETIMEDOUT', 'ECONNRESET']),
  nonRetryableHttp: Object.freeze([400, 401, 403, 404, 422]),
  retryAfterCapMs: 30_000,
  baseBackoffMs: 250,
  maxBackoffMs: 2_000,
});

/** 40 cases x 2 models x 2 attempts. Independent of the generation ceiling. */
function countTokensRequestCap(caseCount, modelCount = 2) {
  return caseCount * modelCount * COUNT_TOKENS_POLICY.maxAttemptsPerModelPerCase;
}

function isCountTokensRetryable({ httpStatus, networkCode }) {
  if (networkCode && COUNT_TOKENS_POLICY.retryableNetwork.includes(networkCode)) return true;
  if (httpStatus && COUNT_TOKENS_POLICY.nonRetryableHttp.includes(httpStatus)) return false;
  if (httpStatus && COUNT_TOKENS_POLICY.retryableHttp.includes(httpStatus)) return true;
  return false;
}

function countTokensBackoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(String(retryAfterHeader).trim(), 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, COUNT_TOKENS_POLICY.retryAfterCapMs);
    }
  }
  const exponential = COUNT_TOKENS_POLICY.baseBackoffMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponential, COUNT_TOKENS_POLICY.maxBackoffMs);
}

/**
 * Exact-request identity for the countTokens cache.
 *
 * Every token-relevant component is included. A cache keyed on anything looser —
 * dimensions, MIME type, prompt template, category — would reuse a count across
 * DIFFERENT image bytes, which is precisely the reuse that must never happen.
 *
 * `candidateVersion` is REQUIRED, not optional. Phase 2A candidates run the same
 * model on the same governed image against the same certified snapshot, so every
 * other component of this identity is equal between control and candidate. A
 * caller that omitted the candidate version would therefore hand the candidate
 * the control's cached count — the same class of cross-request reuse the rest of
 * this identity exists to prevent. Omission is refused rather than defaulted,
 * because defaulting to the control is exactly the wrong guess.
 */
function exactRequestIdentity({
  model,
  serializedRequestPayload,
  imageSha256,
  systemInstructionSha256,
  promptSha256,
  toolDeclarationsSha256,
  generationConfigSha256,
  certifiedSourceSha256,
  datasetVersion,
  selectionContractSha256,
  candidateVersion,
}) {
  const required = {
    model,
    serializedRequestPayload,
    imageSha256,
    systemInstructionSha256,
    promptSha256,
    toolDeclarationsSha256,
    generationConfigSha256,
    certifiedSourceSha256,
    datasetVersion,
    selectionContractSha256,
    candidateVersion,
  };
  for (const [key, value] of Object.entries(required)) {
    if (value == null || String(value).trim() === '') {
      throw new Error(`countTokens cache identity is incomplete: ${key} is required`);
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(required)).digest('hex');
}

function rateFor(pricing, model) {
  const entry = pricing && pricing.models && pricing.models[model];
  if (!entry) throw new Error(`no verified rate for model ${model}`);
  return entry;
}

function attemptCostUsd(pricing, model, inputTokens, outputTokens) {
  const { inputPerMillionUsd, outputPerMillionUsd } = rateFor(pricing, model);
  return (inputTokens / 1e6) * inputPerMillionUsd + (outputTokens / 1e6) * outputPerMillionUsd;
}

/**
 * The reservation ledger.
 *
 * Each case holds two independent slots — primary and fallback — because they
 * resolve independently: the primary may confirm while the fallback is released
 * unused, or both may be attempted, or one may end cost-unknown.
 */
class ReservationLedger {
  constructor({ pricing, spendCeilingUsd, attemptCeiling, countTokensBillable = false }) {
    if (!Number.isFinite(spendCeilingUsd) || spendCeilingUsd <= 0) {
      throw new Error('a positive spend ceiling is required');
    }
    if (!Number.isInteger(attemptCeiling) || attemptCeiling <= 0) {
      throw new Error('a positive attempt ceiling is required');
    }
    this.pricing = pricing;
    this.spendCeilingUsd = spendCeilingUsd;
    this.attemptCeiling = attemptCeiling;
    this.countTokensBillable = countTokensBillable;

    this.confirmedUsd = 0;
    this.slots = new Map(); // `${caseId}:${role}` -> slot
    this.generateAttempts = { primary: 0, fallback: 0 };
    this.countTokens = { requests: 0, successes: 0, retries: 0, rateLimits: 0, failures: 0, cacheHits: 0, cacheMisses: 0 };
    this.events = { doubleCountPrevented: 0, doubleReleasePrevented: 0 };
  }

  outstandingUsd() {
    let sum = 0;
    for (const slot of this.slots.values()) if (slot.state === 'reserved' || slot.state === 'retained_unknown') sum += slot.reservedUsd;
    return sum;
  }

  totalAccountedUsd() {
    return this.confirmedUsd + this.outstandingUsd();
  }

  /** Accounted generation cost for one case, independent of run totals. */
  caseAccountedUsd(caseId) {
    let sum = 0;
    for (const slot of this.slots.values()) {
      if (slot.caseId !== caseId) continue;
      if (slot.state === 'confirmed') sum += slot.confirmedUsd;
      else if (slot.state === 'reserved' || slot.state === 'retained_unknown') sum += slot.reservedUsd;
    }
    return sum;
  }

  key(caseId, role) {
    return `${caseId}:${role}`;
  }

  /**
   * Reserve a complete case from per-model counted inputs.
   *
   * Refuses if either model's count is missing — a shared count is not accepted
   * as a substitute, because the two models are not proven equivalent.
   */
  reserveCase({ caseId, primaryModel, fallbackModel, primaryInputTokens, fallbackInputTokens, countTokensChargeUsd = 0 }) {
    if (this.slots.has(this.key(caseId, 'primary'))) {
      return { authorized: false, reason: 'already_reserved', detail: `${caseId} is already reserved` };
    }
    for (const [label, value] of [['primaryInputTokens', primaryInputTokens], ['fallbackInputTokens', fallbackInputTokens]]) {
      if (!Number.isInteger(value) || value < 0) {
        return {
          authorized: false,
          reason: 'cost_preflight_failed',
          detail: `${label} must come from a countTokens result for that specific model`,
        };
      }
    }
    if (!fallbackModel) {
      return { authorized: false, reason: 'cost_preflight_failed', detail: 'the certified fallback model must be counted before dispatch' };
    }

    const primaryUsd = attemptCostUsd(this.pricing, primaryModel, primaryInputTokens, CERTIFIED_MAX_OUTPUT_TOKENS);
    const fallbackUsd = attemptCostUsd(this.pricing, fallbackModel, fallbackInputTokens, CERTIFIED_MAX_OUTPUT_TOKENS);
    const verifiedCountTokensUsd = this.countTokensBillable ? countTokensChargeUsd : 0;
    const caseUsd = primaryUsd + fallbackUsd + verifiedCountTokensUsd;

    const projectedAttempts = this.generateAttempts.primary + this.generateAttempts.fallback + 2;
    if (projectedAttempts > this.attemptCeiling) {
      return { authorized: false, reason: 'attempt_ceiling', detail: 'the certified pair would exceed the attempt ceiling', caseUsd };
    }

    // confirmed + already-outstanding + this case must fit.
    const projected = this.totalAccountedUsd() + caseUsd;
    if (projected > this.spendCeilingUsd) {
      return { authorized: false, reason: 'cost_ceiling', detail: 'reserving this case would exceed the spend ceiling', caseUsd, projected };
    }

    this.slots.set(this.key(caseId, 'primary'), { caseId, role: 'primary', model: primaryModel, reservedUsd: primaryUsd, state: 'reserved' });
    this.slots.set(this.key(caseId, 'fallback'), { caseId, role: 'fallback', model: fallbackModel, reservedUsd: fallbackUsd, state: 'reserved' });
    if (verifiedCountTokensUsd > 0) this.confirmedUsd += verifiedCountTokensUsd;

    const warnings = [];
    if (projected >= this.spendCeilingUsd * 0.9) warnings.push('spend_at_90_percent');
    if (projectedAttempts >= this.attemptCeiling * 0.9) warnings.push('attempts_at_90_percent');
    return { authorized: true, reason: null, caseUsd, primaryUsd, fallbackUsd, projected, warnings };
  }

  /** Replace a reservation with confirmed usage. Never additive, never twice. */
  confirmAttempt({ caseId, role, promptTokenCount, candidatesTokenCount }) {
    const slot = this.slots.get(this.key(caseId, role));
    if (!slot) throw new Error(`no reservation for ${caseId}:${role}`);
    if (slot.state !== 'reserved') {
      this.events.doubleCountPrevented += 1;
      return { applied: false, reason: `slot already ${slot.state}` };
    }
    const cost = attemptCostUsd(this.pricing, slot.model, promptTokenCount || 0, candidatesTokenCount || 0);
    // The reservation is DROPPED and replaced, never added to.
    slot.state = 'confirmed';
    slot.confirmedUsd = cost;
    this.confirmedUsd += cost;
    this.generateAttempts[role] += 1;
    return { applied: true, confirmedUsd: cost };
  }

  /** An attempt happened but usage metadata is missing: keep the conservative figure. */
  retainUnknown({ caseId, role }) {
    const slot = this.slots.get(this.key(caseId, role));
    if (!slot) throw new Error(`no reservation for ${caseId}:${role}`);
    if (slot.state !== 'reserved') {
      this.events.doubleCountPrevented += 1;
      return { applied: false };
    }
    slot.state = 'retained_unknown';
    this.generateAttempts[role] += 1;
    return { applied: true, retainedUsd: slot.reservedUsd };
  }

  /** The attempt never happened: release exactly once. */
  release({ caseId, role }) {
    const slot = this.slots.get(this.key(caseId, role));
    if (!slot) throw new Error(`no reservation for ${caseId}:${role}`);
    if (slot.state !== 'reserved') {
      this.events.doubleReleasePrevented += 1;
      return { released: false, reason: `slot already ${slot.state}` };
    }
    slot.state = 'released';
    return { released: true, releasedUsd: slot.reservedUsd };
  }

  /** countTokens succeeded but generation was never dispatched. */
  releaseCase({ caseId }) {
    return {
      primary: this.release({ caseId, role: 'primary' }),
      fallback: this.release({ caseId, role: 'fallback' }),
    };
  }

  totals() {
    const byState = {};
    for (const slot of this.slots.values()) byState[slot.state] = (byState[slot.state] || 0) + 1;
    const count = (role, state) =>
      [...this.slots.values()].filter((s) => s.role === role && s.state === state).length;
    return {
      reservationContractVersion: RESERVATION_CONTRACT_VERSION,
      confirmedUsd: this.confirmedUsd,
      conservativeUnresolvedUsd: this.outstandingUsd(),
      totalAccountedUsd: this.totalAccountedUsd(),
      spendCeilingUsd: this.spendCeilingUsd,
      attemptCeiling: this.attemptCeiling,
      primaryGenerateAttempts: this.generateAttempts.primary,
      fallbackGenerateAttempts: this.generateAttempts.fallback,
      totalGenerateAttempts: this.generateAttempts.primary + this.generateAttempts.fallback,
      countTokens: { ...this.countTokens },
      primaryReservationsConfirmed: count('primary', 'confirmed'),
      primaryReservationsRetainedUnknown: count('primary', 'retained_unknown'),
      fallbackReservationsUsed: count('fallback', 'confirmed') + count('fallback', 'retained_unknown'),
      fallbackReservationsReleasedUnused: count('fallback', 'released'),
      fallbackReservationsRetainedUnknown: count('fallback', 'retained_unknown'),
      doubleCountedReservations: 0,
      doubleReleasedReservations: 0,
      doubleCountPrevented: this.events.doubleCountPrevented,
      doubleReleasePrevented: this.events.doubleReleasePrevented,
      slotStates: byState,
    };
  }
}

module.exports = {
  RESERVATION_CONTRACT_VERSION,
  CERTIFIED_MAX_OUTPUT_TOKENS,
  COUNT_TOKENS_POLICY,
  countTokensRequestCap,
  isCountTokensRetryable,
  countTokensBackoffMs,
  exactRequestIdentity,
  ReservationLedger,
};
