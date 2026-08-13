#!/usr/bin/env node
'use strict';

/**
 * Classify the staging Supabase Auth leaked-password (HaveIBeenPwned) control.
 *
 * WHY THIS EXISTS. The certification job used to collapse every non-enabled
 * outcome into BLOCKED. That is correct when the control is available and
 * someone left it off, and wrong when the project's plan does not sell the
 * feature at all: no change to any release candidate can clear it, so the gate
 * became permanently unreachable while telling us nothing about the candidate.
 *
 * WHAT IT DOES NOT DO. It does not turn failures into waivers. Exactly one
 * observation earns NOT_APPLICABLE_PLAN_LIMIT: a targeted Management API
 * entitlement probe that answered HTTP 402 Payment Required. Every other
 * outcome - an unreachable API, a timeout, a 401/403, an unparseable body, a
 * 500, or a status nobody anticipated - is UNKNOWN and blocks. Failing closed
 * is the whole point: "we could not tell" must never read as "not required".
 *
 * The classification is deliberately a pure function of observed evidence so
 * the decision table is unit-testable without a network.
 */

/** Verdicts this classifier may return. */
const VERDICTS = Object.freeze({
  PASS: 'PASS',
  BLOCKED: 'BLOCKED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  NOT_APPLICABLE_PLAN_LIMIT: 'NOT_APPLICABLE_PLAN_LIMIT',
});

/**
 * The single HTTP status that positively identifies a plan/entitlement limit.
 * Supabase answers a config write for a feature the subscription does not
 * include with 402 Payment Required. A 403 is NOT accepted here: that is an
 * authorization outcome and could equally mean a bad or under-scoped token.
 */
const PLAN_ENTITLEMENT_STATUS = 402;

function outcome(verdict, reason, extra = {}) {
  return {
    verdict,
    reason,
    blocking: verdict === VERDICTS.BLOCKED,
    planUpgradeRequired: verdict === VERDICTS.NOT_APPLICABLE_PLAN_LIMIT,
    ...extra,
  };
}

/**
 * @param {object} evidence
 * @param {string}  [evidence.releaseClass]      RUNTIME_RELEASE | CONTROL_PLANE_CHANGE
 * @param {boolean} [evidence.accessTokenPresent]
 * @param {object}  [evidence.read]              the GET /config/auth observation
 * @param {number|null} [evidence.read.status]   HTTP status, or null if the call never completed
 * @param {boolean|null}[evidence.read.hibpEnabled]
 * @param {string|null} [evidence.read.transportError] 'TIMEOUT' | 'NETWORK' | ...
 * @param {object}  [evidence.entitlementProbe]  the targeted PATCH observation
 * @param {number|null} [evidence.entitlementProbe.status]
 * @param {string|null} [evidence.entitlementProbe.transportError]
 * @param {boolean|null}[evidence.entitlementProbe.confirmedEnabled] re-read after a 200 PATCH
 */
function classifyLeakedPasswordProtection(evidence = {}) {
  const releaseClass = String(evidence.releaseClass || '').toUpperCase();

  // A control-plane change deploys no runtime; the environment control is out
  // of scope for it. This mirrors the pre-existing certification behavior.
  if (releaseClass === 'CONTROL_PLANE_CHANGE') {
    return outcome(VERDICTS.NOT_APPLICABLE, 'CONTROL_PLANE_CHANGE_OUT_OF_SCOPE');
  }

  if (evidence.accessTokenPresent === false) {
    return outcome(VERDICTS.BLOCKED, 'UNKNOWN_MISSING_MANAGEMENT_CREDENTIAL');
  }

  const read = evidence.read || {};
  if (read.transportError) {
    return outcome(VERDICTS.BLOCKED, `UNKNOWN_READ_${String(read.transportError).toUpperCase()}`);
  }
  if (read.status === 401 || read.status === 403) {
    return outcome(VERDICTS.BLOCKED, 'UNKNOWN_READ_NOT_AUTHORIZED');
  }
  if (read.status !== 200) {
    return outcome(VERDICTS.BLOCKED, `UNKNOWN_READ_HTTP_${read.status === null || read.status === undefined ? 'NONE' : read.status}`);
  }

  // The control is on. Nothing else to establish.
  if (read.hibpEnabled === true) {
    return outcome(VERDICTS.PASS, 'FEATURE_AVAILABLE_AND_ENABLED');
  }
  if (read.hibpEnabled !== false) {
    // A 200 whose body did not carry a usable boolean is not evidence of
    // anything. Fail closed rather than guess.
    return outcome(VERDICTS.BLOCKED, 'UNKNOWN_READ_BODY_UNUSABLE');
  }

  // Disabled. The remaining question is WHY: withheld by plan, or simply off.
  // Only a targeted entitlement probe can answer that, and its absence is not
  // an answer.
  const probe = evidence.entitlementProbe;
  if (!probe) {
    return outcome(VERDICTS.BLOCKED, 'UNKNOWN_NO_ENTITLEMENT_EVIDENCE');
  }
  if (probe.transportError) {
    return outcome(VERDICTS.BLOCKED, `UNKNOWN_PROBE_${String(probe.transportError).toUpperCase()}`);
  }
  if (probe.status === PLAN_ENTITLEMENT_STATUS) {
    return outcome(VERDICTS.NOT_APPLICABLE_PLAN_LIMIT, 'PLAN_ENTITLEMENT_HTTP_402');
  }
  if (probe.status === 401 || probe.status === 403) {
    return outcome(VERDICTS.BLOCKED, 'UNKNOWN_PROBE_NOT_AUTHORIZED');
  }
  if (probe.status === 200) {
    // The plan does sell the feature - the probe just enabled it. Only a
    // confirming re-read may report PASS; an unconfirmed write may not.
    return probe.confirmedEnabled === true
      ? outcome(VERDICTS.PASS, 'FEATURE_AVAILABLE_ENABLED_BY_PROBE')
      : outcome(VERDICTS.BLOCKED, 'UNKNOWN_PROBE_WRITE_UNCONFIRMED');
  }
  return outcome(
    VERDICTS.BLOCKED,
    `UNKNOWN_PROBE_HTTP_${probe.status === null || probe.status === undefined ? 'NONE' : probe.status}`,
  );
}

module.exports = {
  PLAN_ENTITLEMENT_STATUS,
  VERDICTS,
  classifyLeakedPasswordProtection,
};

if (require.main === module) {
  // Reads one JSON evidence object on argv[2] and prints the classification.
  // The workflow uses this so the decision table lives in exactly one place.
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write('Usage: classify-leaked-password-protection.js \'<evidence json>\'\n');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unreadable evidence blob is itself an unknown, and must block.
    process.stdout.write(`${JSON.stringify(outcome(VERDICTS.BLOCKED, 'UNKNOWN_EVIDENCE_UNPARSEABLE'))}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify(classifyLeakedPasswordProtection(parsed))}\n`);
}
