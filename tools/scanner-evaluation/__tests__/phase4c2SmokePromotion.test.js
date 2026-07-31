'use strict';

/**
 * Phase 4C.2 — smoke promotion. Zero provider calls.
 *
 * The cap arithmetic this protects: a throwaway smoke plus a full development
 * run is 41 governed generation executions, up to 164 countTokens requests, and
 * one development case paid for twice. The 160 cap assumes exactly 40 cases.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sp = require('../lib/smokePromotion');
const gs = require('../lib/governedStorage');

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(gs.ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json'), 'utf8')
);
const HOLDOUT = new Set(MANIFEST.split.holdout);
const DEVELOPMENT_IDS = MANIFEST.cases.map((c) => c.caseId).filter((id) => !HOLDOUT.has(id));

const BASELINE_CONFIG = Object.freeze({
  datasetVersion: '0.3.1',
  manifestSha256: '5b2db5b9',
  selectionContractSha256: '2a3b84e8',
  certifiedSnapshotSha256: 'f3eb6e60',
  adapterCommit: 'e9e1f9d',
  primaryModel: 'gemini-3.6-flash',
  fallbackModel: 'gemini-3.5-flash-lite',
  generationConfigSha256: 'cfg',
  promptSha256: 'prompt',
  systemInstructionSha256: 'sys',
  pricingRecordSha256: 'pricing',
  scoringContractVersion: '0.3.0',
  errorTaxonomyVersion: '1.0.0',
  storageRootId: 'governed',
  runId: 'run-baseline-001',
  spendCeilingUsd: '10',
  attemptCeiling: '200',
});

const passingSmoke = (over = {}) => ({
  caseId: DEVELOPMENT_IDS[0],
  runId: BASELINE_CONFIG.runId,
  gatesPassed: true,
  terminalStatus: 'provider_success',
  config: { ...BASELINE_CONFIG },
  ...over,
});

test('a governed development smoke under the final run id is promotable', () => {
  const result = sp.evaluatePromotion({
    developmentCaseIds: DEVELOPMENT_IDS,
    smoke: passingSmoke(),
    baselineConfig: BASELINE_CONFIG,
  });
  assert.strictEqual(result.promotable, true, JSON.stringify(result.reasons));
});

test('promotion keeps the governed totals and the derived cap intact', () => {
  const plan = sp.executionPlan({ governedCaseCount: 40, developmentCaseCount: 33, promoted: true });
  assert.strictEqual(plan.governedCases, 40);
  assert.strictEqual(plan.primaryGenerationInputs, 40);
  assert.strictEqual(plan.remainingDevelopmentCases, 32);
  assert.strictEqual(plan.countTokensRequestCap, 160);
  assert.strictEqual(plan.duplicatePaidCases, 0);
  assert.strictEqual(plan.ownerAuthorizationRequired, false);
});

test('refusing promotion is what breaks the cap, and the plan says so', () => {
  const plan = sp.executionPlan({ governedCaseCount: 40, developmentCaseCount: 33, promoted: false });
  assert.strictEqual(plan.generationExecutions, 41);
  assert.strictEqual(plan.countTokensRequestCap, 164);
  assert.strictEqual(plan.duplicatePaidCases, 1);
  assert.strictEqual(plan.ownerAuthorizationRequired, true);
});

test('a holdout case may never be promoted into the development baseline', () => {
  const holdoutId = MANIFEST.split.holdout[0];
  const result = sp.evaluatePromotion({
    developmentCaseIds: DEVELOPMENT_IDS,
    smoke: passingSmoke({ caseId: holdoutId }),
    baselineConfig: BASELINE_CONFIG,
  });
  assert.strictEqual(result.promotable, false);
  assert.ok(result.reasons.some((r) => r.check === 'development_membership'));
});

test('a smoke run under a different run id is not promotable', () => {
  const result = sp.evaluatePromotion({
    developmentCaseIds: DEVELOPMENT_IDS,
    smoke: passingSmoke({ runId: 'run-smoke-only' }),
    baselineConfig: BASELINE_CONFIG,
  });
  assert.strictEqual(result.promotable, false);
  assert.ok(result.reasons.some((r) => r.check === 'run_id'));
});

test('a smoke that failed a gate is not promotable', () => {
  const result = sp.evaluatePromotion({
    developmentCaseIds: DEVELOPMENT_IDS,
    smoke: passingSmoke({ gatesPassed: false }),
    baselineConfig: BASELINE_CONFIG,
  });
  assert.strictEqual(result.promotable, false);
  assert.ok(result.reasons.some((r) => r.check === 'gates'));
});

test('a non-scorable terminal status is not promotable', () => {
  for (const status of ['provider_output_invalid', 'provider_timeout', 'provider_server_error', 'cost_ceiling']) {
    const result = sp.evaluatePromotion({
      developmentCaseIds: DEVELOPMENT_IDS,
      smoke: passingSmoke({ terminalStatus: status }),
      baselineConfig: BASELINE_CONFIG,
    });
    assert.strictEqual(result.promotable, false, status);
    assert.ok(result.reasons.some((r) => r.check === 'terminal_status'));
  }
});

test('ANY governing value changing after the smoke blocks promotion, and is named', () => {
  for (const field of sp.GOVERNING_FIELDS) {
    if (field === 'runId') continue; // covered by its own dedicated check
    const smoke = passingSmoke({ config: { ...BASELINE_CONFIG, [field]: `${BASELINE_CONFIG[field]}-moved` } });
    const result = sp.evaluatePromotion({
      developmentCaseIds: DEVELOPMENT_IDS,
      smoke,
      baselineConfig: BASELINE_CONFIG,
    });
    assert.strictEqual(result.promotable, false, `${field} must block promotion`);
    const reason = result.reasons.find((r) => r.check === 'governing_fingerprint');
    assert.ok(reason, `${field} must be reported as a fingerprint change`);
    assert.ok(reason.changed.includes(field), `${field} must be named in the diff`);
  }
});

test('an incomplete governing configuration is refused, never treated as a wildcard', () => {
  for (const field of sp.GOVERNING_FIELDS) {
    const partial = { ...BASELINE_CONFIG };
    delete partial[field];
    assert.throws(() => sp.governingFingerprint(partial), /incomplete/);
  }
});

test('the fingerprint is stable for identical configurations', () => {
  assert.strictEqual(
    sp.governingFingerprint(BASELINE_CONFIG),
    sp.governingFingerprint({ ...BASELINE_CONFIG })
  );
});

test('the governed development membership is the real 33', () => {
  assert.strictEqual(DEVELOPMENT_IDS.length, 33);
  assert.strictEqual(MANIFEST.split.holdout.length, 7);
});

// ── countTokens billing status ─────────────────────────────────────────────

test('countTokens billing status is recorded as not explicitly documented', () => {
  const record = JSON.parse(
    fs.readFileSync(path.join(gs.ROOT, 'evals/scanner-accuracy/pricing/counttokens-billing-status.json'), 'utf8')
  );
  assert.strictEqual(record.countTokensBillingMode, 'NOT_EXPLICITLY_DOCUMENTED');
  assert.strictEqual(record.conservativeHandling, 'billable_unless_verified');
  // The agent must not claim to have retrieved the source itself.
  assert.strictEqual(record.verification.agentIndependentlyRetrieved, false);
  assert.ok(record.surfaceConfusionToAvoid.why_it_does_not_apply.length > 0);
});
