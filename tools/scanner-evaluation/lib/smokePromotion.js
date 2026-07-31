'use strict';

/**
 * Smoke promotion.
 *
 * THE ARITHMETIC THIS EXISTS TO PREVENT
 * Treating the smoke as a throwaway and then running all 33 development cases
 * means 41 governed generation executions, up to 82 initial countTokens calls,
 * up to 164 countTokens requests once each is allowed its two attempts, and one
 * development case paid for twice. The derived cap of 160 assumes exactly 40
 * governed cases, so a separate smoke silently breaks it.
 *
 * THE RULE
 * The smoke runs ONE governed development case under the FINAL baseline run id
 * and the exact frozen baseline configuration. If it passes every gate it is
 * preserved as that case's terminal baseline result, development resumes with
 * the remaining 32, and the totals stay 40 cases / 40 primary inputs / 160
 * countTokens cap.
 *
 * WHY THE FINGERPRINT IS STRICT
 * Promotion is only sound if the smoke was produced by the same measurement
 * system as the rest of the baseline. If any governing value moved after the
 * smoke, the promoted record would describe a different configuration from its
 * 39 peers, and the baseline would silently mix two systems. Every governing
 * value is therefore hashed, and any change demotes the smoke to a separate
 * diagnostic run rather than being reconciled.
 */

const crypto = require('crypto');

const PROMOTION_CONTRACT_VERSION = '1.0.0';

/**
 * Every value that must be identical between the smoke and the full baseline.
 * A missing value is a refusal, never a wildcard.
 */
const GOVERNING_FIELDS = Object.freeze([
  'datasetVersion',
  'manifestSha256',
  'selectionContractSha256',
  'certifiedSnapshotSha256',
  'adapterCommit',
  'primaryModel',
  'fallbackModel',
  'generationConfigSha256',
  'promptSha256',
  'systemInstructionSha256',
  'pricingRecordSha256',
  'scoringContractVersion',
  'errorTaxonomyVersion',
  'storageRootId',
  'runId',
  'spendCeilingUsd',
  'attemptCeiling',
]);

function governingFingerprint(config) {
  const picked = {};
  const missing = [];
  for (const field of GOVERNING_FIELDS) {
    const value = config ? config[field] : undefined;
    if (value == null || String(value).trim() === '') missing.push(field);
    else picked[field] = String(value);
  }
  if (missing.length) {
    throw new Error(`governing configuration is incomplete: ${missing.join(', ')}`);
  }
  return crypto.createHash('sha256').update(JSON.stringify(picked)).digest('hex');
}

/** Field-level diff, so a refusal names what actually moved. */
function governingDifferences(smokeConfig, baselineConfig) {
  const diffs = [];
  for (const field of GOVERNING_FIELDS) {
    const a = smokeConfig ? smokeConfig[field] : undefined;
    const b = baselineConfig ? baselineConfig[field] : undefined;
    if (String(a) !== String(b)) diffs.push({ field, smoke: a == null ? null : String(a), baseline: b == null ? null : String(b) });
  }
  return diffs;
}

/**
 * Decide whether a passed smoke may become the terminal baseline result.
 *
 * @param {object} args
 * @param {string[]} args.developmentCaseIds governed development membership
 * @param {object} args.smoke  { caseId, runId, gatesPassed, terminalStatus, config }
 * @param {object} args.baselineConfig the frozen full-baseline configuration
 */
function evaluatePromotion({ developmentCaseIds, smoke, baselineConfig }) {
  const reasons = [];

  if (!smoke || !smoke.caseId) {
    return { promotable: false, reasons: [{ check: 'smoke_present', message: 'no smoke result supplied' }] };
  }
  if (!developmentCaseIds.includes(smoke.caseId)) {
    reasons.push({ check: 'development_membership', message: 'the smoke case is not a governed development case' });
  }
  if (smoke.gatesPassed !== true) {
    reasons.push({ check: 'gates', message: 'the smoke did not pass every gate' });
  }
  // Only a terminal, certified-valid result may stand in as a baseline result.
  if (smoke.terminalStatus !== 'provider_success') {
    reasons.push({ check: 'terminal_status', message: `smoke terminal status is ${smoke.terminalStatus}, which is not a scorable baseline result` });
  }
  if (!smoke.runId || smoke.runId !== (baselineConfig && baselineConfig.runId)) {
    reasons.push({ check: 'run_id', message: 'the smoke did not run under the final baseline run id' });
  }

  let fingerprintMatch = false;
  try {
    fingerprintMatch = governingFingerprint(smoke.config) === governingFingerprint(baselineConfig);
  } catch (error) {
    reasons.push({ check: 'governing_configuration', message: error.message });
  }
  if (!fingerprintMatch && !reasons.some((r) => r.check === 'governing_configuration')) {
    const diffs = governingDifferences(smoke.config, baselineConfig);
    reasons.push({
      check: 'governing_fingerprint',
      message: 'a governing value changed after the smoke',
      changed: diffs.map((d) => d.field),
    });
  }

  return { promotable: reasons.length === 0, reasons };
}

/**
 * Execution plan and derived caps.
 *
 * `promoted` is the difference between one measurement system and two.
 */
function executionPlan({ governedCaseCount, developmentCaseCount, promoted, modelCount = 2, countTokensAttemptsPerModel = 2 }) {
  if (promoted) {
    return {
      promoted: true,
      governedCases: governedCaseCount,
      primaryGenerationInputs: governedCaseCount,
      remainingDevelopmentCases: developmentCaseCount - 1,
      countTokensRequestCap: governedCaseCount * modelCount * countTokensAttemptsPerModel,
      duplicatePaidCases: 0,
      ownerAuthorizationRequired: false,
      note: 'The smoke is the terminal baseline result for its case; development resumes with the remainder.',
    };
  }
  // A separate smoke is an extra governed execution, and repeating the case is
  // duplicate paid work that only the owner may authorize.
  const executions = governedCaseCount + 1;
  return {
    promoted: false,
    governedCases: governedCaseCount,
    generationExecutions: executions,
    primaryGenerationInputs: executions,
    remainingDevelopmentCases: developmentCaseCount,
    countTokensRequestCap: executions * modelCount * countTokensAttemptsPerModel,
    duplicatePaidCases: 1,
    ownerAuthorizationRequired: true,
    note: 'Smoke closed as a separate diagnostic run. Caps are recalculated and repeating the paid case requires explicit owner authorization.',
  };
}

module.exports = {
  PROMOTION_CONTRACT_VERSION,
  GOVERNING_FIELDS,
  governingFingerprint,
  governingDifferences,
  evaluatePromotion,
  executionPlan,
};
