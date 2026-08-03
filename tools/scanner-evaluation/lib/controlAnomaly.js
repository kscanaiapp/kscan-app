'use strict';

/**
 * Mechanism-aware control-baseline anomaly classification.
 *
 * PREREGISTERED. Authored before any fresh Phase 6 control result exists, so
 * the rule cannot be fitted to an outcome. Changing it after a fresh control
 * has run invalidates that control and requires a new run and a new lock.
 *
 * WHY A RATE THRESHOLD ALONE IS THE WRONG DETECTOR
 *
 * The obvious rule — flag the run when its invalid rate moves more than ten
 * percentage points from the historical control — measures the wrong thing.
 * Truncation at the shared generation ceiling is stochastic: the same governed
 * case under the same certified configuration and the same prompt produced
 * 1,737 reasoning + 146 response tokens (valid) in one governed run and
 * 1,963 + 70 (truncated) in another. Identical input; the model's own reasoning
 * varied by 226 tokens and that alone decided validity.
 *
 * With per-case truncation behaving like a weighted coin at the historical
 * p ~ 0.182 over 33 cases, the invalid count carries about 2.2 cases — roughly
 * 6.7 percentage points — of sampling deviation, so two honest runs differ by
 * about 9.4 points on average. A ten-point trigger therefore fires at roughly
 * one sigma of ordinary noise. It would stop good runs constantly while saying
 * nothing about whether anything is actually wrong.
 *
 * WHAT ACTUALLY DISTINGUISHES A BROKEN RUN
 *
 * Not the size of the move — the MECHANISM behind it. A run is trustworthy when
 * every execution identity matches, the same dominant failure mechanism is
 * still present, invalid cases still terminate at the configured ceiling, no
 * new structural failure class has appeared, and the ledger is internally
 * consistent. A run is not trustworthy when an identity drifted, a new dominant
 * failure class appeared, invalid outputs stopped matching the ceiling
 * mechanism, provider behaviour cannot be attributed, or capture disagrees with
 * itself.
 *
 * So the rate delta is COMPUTED AND REPORTED, and never consulted for the
 * verdict. `assertRateDeltaIsNotAVerdictInput()` and its tests exist to keep it
 * that way.
 *
 * The fresh control becomes the locked Phase 6 baseline whenever this returns
 * EXPECTED_STOCHASTIC_VARIATION, regardless of how far its raw invalid count
 * sits from the historical 6/33. Candidate A is compared against that fresh
 * lock, never against the historical count.
 */

const CLASSIFICATION_VERSION = '1.0.0';

const VERDICTS = Object.freeze({
  EXPECTED_STOCHASTIC_VARIATION: 'EXPECTED_STOCHASTIC_VARIATION',
  CONTROL_BASELINE_ANOMALY: 'CONTROL_BASELINE_ANOMALY',
});

/**
 * Execution identities that must match for a run to be comparable at all.
 * Every one of these is something the harness pins deliberately; a mismatch is
 * a configuration fault, not sampling.
 */
const REQUIRED_IDENTITIES = Object.freeze([
  'dataset',
  'prompt',
  'model',
  'generationConfig',
  'requestIdentity',
  'parser',
  'normalizer',
]);

/**
 * The mechanism Phase 6 expects to dominate invalid output, named explicitly so
 * "the dominant class changed" is a checkable statement rather than a judgement.
 */
const EXPECTED_DOMINANT_CAUSE = 'output_budget_exhausted';

/**
 * How close to the configured ceiling a truncated case must land for the
 * ceiling mechanism to be considered confirmed, as a fraction of the ceiling.
 *
 * Expressed as a fraction rather than a token count because `maxOutputTokens`
 * is a certified constant this layer does not own — if it changes, the tolerance
 * should scale with it rather than silently become stricter or looser. At the
 * certified 2,048 this is ~102 tokens; every historical truncation landed
 * within 20.
 */
const CEILING_PROXIMITY_FRACTION = 0.05;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function dominantKey(counts) {
  const entries = Object.entries(counts || {}).filter(([, n]) => isFiniteNumber(n) && n > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return entries[0][0];
}

function sumCounts(counts) {
  return Object.values(counts || {}).reduce((total, n) => total + (isFiniteNumber(n) ? n : 0), 0);
}

/**
 * Guard that the rate delta never reaches the verdict.
 *
 * Exported so a test can assert the property directly rather than trusting that
 * a future edit remembered the rule. It throws if a caller tries to hand a
 * delta-derived flag in as evidence.
 */
function assertRateDeltaIsNotAVerdictInput(input) {
  const forbidden = Object.keys(input || {}).filter((key) =>
    /rateDelta|deltaExceed|rateAnomal|exceedsThreshold|tenPoint/i.test(key));
  if (forbidden.length) {
    throw new Error(
      'invalid-rate delta must not be an input to the anomaly verdict; '
      + `received: ${forbidden.sort().join(', ')}`
    );
  }
  return true;
}

/**
 * Classify a fresh control run.
 *
 * @param {object} input
 * @param {Record<string, {expected: string, observed: string}>} input.identities
 * @param {object} input.fresh
 *   caseCount, completedCount, invalidCount,
 *   invalidOutputCauseCounts, finishReasonCounts,
 *   truncatedCaseCeilingDistances (array of token distances, truncated cases only),
 *   configuredOutputCeiling, accountingConsistent (boolean)
 * @param {object} [input.historical] caseCount, invalidCount — reporting only.
 */
function classifyControlRun(input) {
  assertRateDeltaIsNotAVerdictInput(input);

  const { identities = {}, fresh = {}, historical = null } = input || {};
  const findings = [];

  // ── 1. Execution identity ────────────────────────────────────────────────
  const identityMismatches = [];
  for (const name of REQUIRED_IDENTITIES) {
    const pair = identities[name];
    if (!pair || typeof pair.expected !== 'string' || typeof pair.observed !== 'string') {
      identityMismatches.push(`${name}: not reported`);
      continue;
    }
    if (pair.expected !== pair.observed) identityMismatches.push(`${name}: expected/observed differ`);
  }
  if (identityMismatches.length) {
    findings.push({ check: 'execution_identity', ok: false, detail: identityMismatches.join('; ') });
  } else {
    findings.push({ check: 'execution_identity', ok: true, detail: 'all pinned identities match' });
  }

  // ── 2. Internal consistency of capture ───────────────────────────────────
  // A run that disagrees with itself cannot be trusted regardless of mechanism.
  const causeTotal = sumCounts(fresh.invalidOutputCauseCounts);
  const consistencyProblems = [];
  if (!isFiniteNumber(fresh.caseCount) || !isFiniteNumber(fresh.invalidCount)) {
    consistencyProblems.push('case or invalid count missing');
  }
  if (isFiniteNumber(fresh.completedCount) && isFiniteNumber(fresh.caseCount)
      && fresh.completedCount !== fresh.caseCount) {
    consistencyProblems.push(`completed ${fresh.completedCount} != planned ${fresh.caseCount}`);
  }
  if (isFiniteNumber(fresh.invalidCount) && causeTotal !== fresh.invalidCount) {
    consistencyProblems.push(`invalid causes sum ${causeTotal} != invalid count ${fresh.invalidCount}`);
  }
  if (fresh.accountingConsistent === false) {
    consistencyProblems.push('cost or latency accounting reported inconsistent');
  }
  findings.push(consistencyProblems.length
    ? { check: 'capture_consistency', ok: false, detail: consistencyProblems.join('; ') }
    : { check: 'capture_consistency', ok: true, detail: 'counts and accounting agree' });

  // ── 3. Provider attributability ──────────────────────────────────────────
  // Zero invalid cases is a clean run, not an unattributable one.
  const causes = fresh.invalidOutputCauseCounts || {};
  const unclassified = isFiniteNumber(causes.unclassified) ? causes.unclassified : 0;
  const hasInvalid = isFiniteNumber(fresh.invalidCount) && fresh.invalidCount > 0;
  if (hasInvalid && unclassified === fresh.invalidCount) {
    findings.push({
      check: 'provider_attribution',
      ok: false,
      detail: 'every invalid case is unclassified; provider exposed no finishReason to attribute',
    });
  } else {
    findings.push({ check: 'provider_attribution', ok: true, detail: hasInvalid ? 'invalid cases carry a finish reason' : 'no invalid cases to attribute' });
  }

  // ── 4. Dominant failure class ────────────────────────────────────────────
  const dominantCause = dominantKey(causes);
  if (!hasInvalid) {
    findings.push({ check: 'dominant_failure_class', ok: true, detail: 'no invalid output in this run' });
  } else if (dominantCause === EXPECTED_DOMINANT_CAUSE) {
    findings.push({ check: 'dominant_failure_class', ok: true, detail: `dominant cause remains ${dominantCause}` });
  } else {
    findings.push({
      check: 'dominant_failure_class',
      ok: false,
      detail: `new dominant failure class ${dominantCause}, expected ${EXPECTED_DOMINANT_CAUSE}`,
    });
  }

  // ── 5. Ceiling mechanism still holds ─────────────────────────────────────
  const distances = Array.isArray(fresh.truncatedCaseCeilingDistances)
    ? fresh.truncatedCaseCeilingDistances.filter(isFiniteNumber)
    : [];
  const truncatedCount = isFiniteNumber(causes[EXPECTED_DOMINANT_CAUSE]) ? causes[EXPECTED_DOMINANT_CAUSE] : 0;
  if (truncatedCount === 0) {
    findings.push({ check: 'ceiling_mechanism', ok: true, detail: 'no truncated cases in this run' });
  } else if (!isFiniteNumber(fresh.configuredOutputCeiling) || distances.length !== truncatedCount) {
    findings.push({
      check: 'ceiling_mechanism',
      ok: false,
      detail: `ceiling distances not reported for all ${truncatedCount} truncated cases`,
    });
  } else {
    const tolerance = fresh.configuredOutputCeiling * CEILING_PROXIMITY_FRACTION;
    const strays = distances.filter((d) => d > tolerance);
    findings.push(strays.length
      ? {
          check: 'ceiling_mechanism',
          ok: false,
          detail: `${strays.length} case(s) labelled truncated terminated more than ${Math.round(tolerance)} tokens below the ceiling`,
        }
      : { check: 'ceiling_mechanism', ok: true, detail: `all ${truncatedCount} truncated case(s) terminated within ${Math.round(tolerance)} tokens of the ceiling` });
  }

  const failed = findings.filter((f) => !f.ok);
  const verdict = failed.length ? VERDICTS.CONTROL_BASELINE_ANOMALY : VERDICTS.EXPECTED_STOCHASTIC_VARIATION;

  // Reporting only. Deliberately computed AFTER the verdict so it is obvious at
  // a glance that nothing above could have consulted it.
  let invalidRateDeltaPp = null;
  if (historical && isFiniteNumber(historical.invalidCount) && isFiniteNumber(historical.caseCount)
      && historical.caseCount > 0 && isFiniteNumber(fresh.invalidCount) && isFiniteNumber(fresh.caseCount)
      && fresh.caseCount > 0) {
    invalidRateDeltaPp = Number((
      (100 * fresh.invalidCount / fresh.caseCount) - (100 * historical.invalidCount / historical.caseCount)
    ).toFixed(1));
  }

  return {
    classificationVersion: CLASSIFICATION_VERSION,
    verdict,
    lockable: verdict === VERDICTS.EXPECTED_STOCHASTIC_VARIATION,
    findings,
    failedChecks: failed.map((f) => f.check),
    reportOnly: {
      invalidRateDeltaPp,
      note: 'Reported for the record. Never an input to the verdict: truncation is '
        + 'stochastic, so a large delta between two honest runs is ordinary.',
    },
  };
}

module.exports = {
  CLASSIFICATION_VERSION,
  VERDICTS,
  REQUIRED_IDENTITIES,
  EXPECTED_DOMINANT_CAUSE,
  CEILING_PROXIMITY_FRACTION,
  classifyControlRun,
  assertRateDeltaIsNotAVerdictInput,
};
