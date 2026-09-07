'use strict';
/**
 * STRUCTURAL PERFORMANCE MODEL.
 *
 * This is NOT production pipeline execution. It never calls K Scan code, never
 * calls a provider, never opens a socket. It evaluates a DAG whose SHAPE is
 * bound to production source (see authority/source-bindings.json) and whose
 * DURATIONS are a mixture of PROVEN constants, OBSERVED bands and MODELED
 * sweep points.
 *
 * What it is good for: reasoning about critical paths, fan-in behaviour,
 * timeout exposure, retry cost, network sensitivity, and whether progressive
 * delivery could move work off the first-result path.
 *
 * What it cannot do: prove that a parallelisation is CORRECT. A faster number
 * out of this evaluator is a statement about structure, never about safety.
 */

const { analyze } = require('./graph');
const { combineEvidence } = require('./evidence');
const { scanRequestPayloadBytes, uploadTimeMs, downloadTimeMs } = require('./network');

class ModelError extends Error {
  constructor(message) { super(message); this.name = 'ModelError'; }
}

/**
 * Resolve one stage's duration under a parameter set.
 *
 * Every branch returns an evidence class alongside the number, and the class
 * travels with the number for the rest of the evaluation. A PROVEN floor
 * (MIN_DISPLAY_MS) stays PROVEN; anything reading a swept parameter becomes
 * whatever that parameter is declared to be.
 */
function resolveDuration(stage, params, context) {
  const spec = stage.duration;
  if (!spec || typeof spec !== 'object') {
    throw new ModelError(`stage "${stage.id}" has no duration spec`);
  }

  let raw;
  let evidence;

  switch (spec.kind) {
    case 'zero':
      // A proven no-op. sanitizeImageBeforeUpload is literally `return input`.
      raw = 0;
      evidence = 'PROVEN';
      break;

    case 'fixed':
      if (typeof spec.ms !== 'number') throw new ModelError(`stage "${stage.id}" fixed duration must be a number`);
      raw = spec.ms;
      evidence = spec.evidence_class || 'PROVEN';
      break;

    case 'param': {
      if (!(spec.param in params)) {
        throw new ModelError(
          `stage "${stage.id}" needs parameter "${spec.param}" which the sweep point does not supply. ` +
            'Unknown quantities must be declared in the assumptions register, never defaulted silently.',
        );
      }
      const p = params[spec.param];
      raw = typeof p === 'object' ? p.value : p;
      evidence = (typeof p === 'object' && p.evidence_class) || spec.evidence_class || 'MODELED';
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new ModelError(`parameter "${spec.param}" is not a finite number`);
      }
      break;
    }

    case 'upload': {
      const t = uploadTimeMs({
        bytes: context.payload.request_body_bytes,
        uplinkMbps: numberOf(params, 'uplink_mbps'),
        rttMs: numberOf(params, 'rtt_ms'),
        setupRoundTrips: spec.setup_round_trips ?? 2,
      });
      raw = t.total_ms;
      evidence = 'MODELED';
      break;
    }

    case 'upload_small': {
      // MODE B carries no image. PROHIBITED_IMAGE_KEYS makes an image-shaped
      // field a rejected request, so this body cannot silently grow.
      const t = uploadTimeMs({
        bytes: spec.bytes ?? 2048,
        uplinkMbps: numberOf(params, 'uplink_mbps'),
        rttMs: numberOf(params, 'rtt_ms'),
        setupRoundTrips: spec.setup_round_trips ?? 0,
      });
      raw = t.total_ms;
      evidence = 'MODELED';
      break;
    }

    case 'download': {
      const t = downloadTimeMs({
        bytes: spec.bytes ?? 24_000,
        downlinkMbps: numberOf(params, 'downlink_mbps'),
        rttMs: numberOf(params, 'rtt_ms'),
      });
      raw = t.total_ms;
      evidence = 'MODELED';
      break;
    }

    case 'fanin': {
      // A bounded fan-in: the group finishes when its children finish, when an
      // early-success threshold is met, or at the deadline — whichever is
      // first. Children are supplied as parameter names so a sweep can move
      // one provider without moving the others.
      const childMs = (spec.children || []).map((c) => numberOf(params, c));
      if (childMs.length === 0) throw new ModelError(`fanin stage "${stage.id}" has no children`);
      const sorted = [...childMs].sort((a, b) => a - b);
      const sufficientAt = spec.sufficient_after_children;
      let candidate;
      if (spec.concurrent === false) {
        // Serial fan-out: the group costs the SUM, not the max.
        candidate = childMs.reduce((a, b) => a + b, 0);
      } else if (Number.isInteger(sufficientAt) && sufficientAt > 0 && sufficientAt <= sorted.length) {
        // Early exit once `sufficientAt` children have delivered.
        candidate = sorted[sufficientAt - 1];
      } else {
        // Blocking fan-in: the slowest child gates the group.
        candidate = sorted[sorted.length - 1];
      }
      raw = candidate;
      evidence = combineEvidence(
        (spec.children || []).map((c) => evidenceOf(params, c)),
      );
      break;
    }

    default:
      throw new ModelError(`stage "${stage.id}" has unknown duration kind "${spec.kind}"`);
  }

  // ── Retry cost ────────────────────────────────────────────────────────────
  // Modelled as (attempts-1) extra failed attempts plus backoff. Applied
  // BEFORE the timeout clamp, because in production the timeout wraps the
  // whole attempt loop (index.ts:2770 arms one AbortController for all
  // attempts), so retries eat the same budget rather than extending it.
  let retried = raw;
  let retryDetail = null;
  if (stage.retry && (params.retry_attempts_extra ?? 0) > 0) {
    const extra = Math.min(params.retry_attempts_extra, (stage.retry.max_attempts || 1) - 1);
    if (extra > 0) {
      const failedCost = extra * (numberOf(params, stage.retry.failed_attempt_param) || 0);
      const backoff = sumBackoff(extra, stage.retry.base_delay_ms, stage.retry.max_delay_ms);
      retried = raw + failedCost + backoff;
      retryDetail = { extra_attempts: extra, failed_attempt_cost_ms: failedCost, backoff_ms: backoff };
      evidence = combineEvidence([evidence, 'MODELED']);
    }
  }

  // ── Timeout clamp ─────────────────────────────────────────────────────────
  let outcome = 'ok';
  let effective = retried;
  if (typeof stage.timeout_ms === 'number' && retried > stage.timeout_ms) {
    effective = stage.timeout_ms;
    outcome = 'timeout';
  }

  return { ms: effective, evidence_class: evidence, raw_ms: raw, outcome, retry: retryDetail };
}

function sumBackoff(extraAttempts, baseDelayMs = 250, maxDelayMs = 2000) {
  let total = 0;
  for (let i = 1; i <= extraAttempts; i += 1) {
    total += Math.min(baseDelayMs * 2 ** (i - 1), maxDelayMs);
  }
  return total;
}

function numberOf(params, name) {
  if (!(name in params)) {
    throw new ModelError(`missing parameter "${name}" — declare it in the assumptions register`);
  }
  const p = params[name];
  return typeof p === 'object' ? p.value : p;
}

function evidenceOf(params, name) {
  const p = params[name];
  if (typeof p === 'object' && p.evidence_class) return p.evidence_class;
  return 'MODELED';
}

/**
 * Run one scenario at one point in parameter space.
 *
 * `payload` is computed once and shared, so the same fixture geometry drives
 * both the upload stage and the reported byte counts.
 */
function runScenario(scenario, params, { payload } = {}) {
  if (!scenario || !Array.isArray(scenario.stages)) {
    throw new ModelError('scenario requires a stages array');
  }
  if (!scenario.first_result_terminal || !scenario.completion_terminal) {
    throw new ModelError(
      'scenario must declare BOTH first_result_terminal and completion_terminal — ' +
        'collapsing them is exactly the mistake this lane exists to avoid',
    );
  }
  const resolvedPayload = payload || scanRequestPayloadBytes({
    compressedImageBytes: numberOf(params, 'compressed_image_bytes'),
    envelopeBytes: params.envelope_bytes ? numberOf(params, 'envelope_bytes') : 320,
  });

  const perStage = new Map();
  const durationOf = (stage) => {
    const d = resolveDuration(stage, params, { payload: resolvedPayload });
    perStage.set(stage.id, d);
    return d;
  };

  const result = analyze(scenario.stages, durationOf, {
    firstResultTerminal: scenario.first_result_terminal,
    completionTerminal: scenario.completion_terminal,
  });

  const timedOut = [...perStage.entries()]
    .filter(([, d]) => d.outcome === 'timeout')
    .map(([id, d]) => ({ stage: id, timeout_ms: d.raw_ms, clamped_to: d.ms }));

  return {
    scenario_id: scenario.scenario_id,
    scenario_version: scenario.scenario_version,
    payload: resolvedPayload,
    first_result: {
      ...result.first_result,
      chain_detail: result.first_result.chain_detail.map((t) => ({
        stage: t.id, start_ms: round(t.start), duration_ms: round(t.duration),
        finish_ms: round(t.finish), evidence_class: t.evidence_class,
      })),
      total_ms: round(result.first_result.total_ms),
    },
    complete_response: {
      ...result.complete_response,
      chain_detail: result.complete_response.chain_detail.map((t) => ({
        stage: t.id, start_ms: round(t.start), duration_ms: round(t.duration),
        finish_ms: round(t.finish), evidence_class: t.evidence_class,
      })),
      total_ms: round(result.complete_response.total_ms),
    },
    timed_out_stages: timedOut,
    stage_timings: Object.fromEntries(
      [...result.times.entries()].map(([id, t]) => [id, {
        start_ms: round(t.start), duration_ms: round(t.duration), finish_ms: round(t.finish),
        evidence_class: t.evidence_class, outcome: perStage.get(id).outcome,
      }]),
    ),
  };
}

function round(n) { return Math.round(n * 100) / 100; }

/**
 * Sweep one parameter across a range and report how the two critical paths
 * respond. §22: a sweep, never a single fabricated point estimate.
 */
function sweepScenario(scenario, baseParams, paramName, values, opts = {}) {
  return values.map((v) => {
    const params = { ...baseParams, [paramName]: v };
    const run = runScenario(scenario, params, opts);
    return {
      [paramName]: typeof v === 'object' ? v.value : v,
      first_result_ms: run.first_result.total_ms,
      complete_response_ms: run.complete_response.total_ms,
      first_result_chain: run.first_result.chain,
      evidence_class: run.first_result.evidence_class,
      timed_out: run.timed_out_stages.map((t) => t.stage),
    };
  });
}

module.exports = { ModelError, resolveDuration, runScenario, sweepScenario, sumBackoff };
