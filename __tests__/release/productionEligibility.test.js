#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { generateReleaseManifest } = require('../../security/release/generate-release-manifest');
const { BLOCKER_CODES, evaluateEligibility } = require('../../security/release/production-eligibility');
const {
  CURRENT_LAST_KNOWN_GOOD,
  REQUIRED_RELEASE_STATE,
  LastKnownGoodError,
  validateLastKnownGood,
  createLastKnownGood,
} = require('../../security/release/last-known-good');
const { STAGING_REF } = require('../../security/scripts/lib/environment-authority');

const REPO_ROOT = path.join(__dirname, '..', '..');

const manifest = () => generateReleaseManifest({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-eligibility-test',
  sourceSha: '7d7c73bd4065ad9a25349e42f347418117d91867',
  sourceTreeSha: 'tree-abc123',
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});

const evaluate = (m, extra = {}) => evaluateEligibility({ manifest: m, repoRoot: REPO_ROOT, ...extra });

const codes = (result) => result.blockers.map((b) => b.code);

// ---- headline Phase 2A assertions ----

test('current known state: staging control plane eligible, production promotion NOT eligible', () => {
  const result = evaluate(manifest());
  assert.equal(result.stagingControlPlaneEligible, true);
  assert.equal(result.productionPromotionEligible, false);
});

test('unresolved production migration reconciliation blocks production but permits staging manifest creation', () => {
  const m = manifest();
  // The manifest itself was created successfully despite unresolved reconciliation.
  assert.equal(m.productionMigrationReconciliation.status, 'PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED');
  const result = evaluate(m);
  assert.ok(codes(result).includes(BLOCKER_CODES.PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED));
  assert.equal(result.stagingControlPlaneEligible, true);
});

test('unknown Last Known Good is a production blocker', () => {
  assert.equal(CURRENT_LAST_KNOWN_GOOD.status, 'UNKNOWN');
  assert.ok(codes(evaluate(manifest())).includes(BLOCKER_CODES.LAST_KNOWN_GOOD_UNKNOWN));
});

test('unknown production source provenance is a production blocker', () => {
  assert.ok(codes(evaluate(manifest())).includes(BLOCKER_CODES.PRODUCTION_SOURCE_PROVENANCE_UNKNOWN));
});

// ---- migration risk classes under the verified no-PITR state ----

test('DATA_TRANSFORMING is blocked for production while PITR is unavailable', () => {
  const m = manifest();
  m.riskClassification.includedRiskClasses = ['DATA_TRANSFORMING'];
  assert.ok(codes(evaluate(m)).includes(BLOCKER_CODES.PITR_REQUIRED_FOR_RISK_CLASS));
});

test('DESTRUCTIVE is blocked for production outright', () => {
  const m = manifest();
  m.riskClassification.includedRiskClasses = ['DESTRUCTIVE'];
  assert.ok(codes(evaluate(m)).includes(BLOCKER_CODES.DESTRUCTIVE_MIGRATION_PROHIBITED));
});

test('FORWARD_FIX_ONLY requires a reviewed recovery plan', () => {
  const m = manifest();
  m.riskClassification.includedRiskClasses = ['FORWARD_FIX_ONLY'];
  assert.ok(codes(evaluate(m)).includes(BLOCKER_CODES.REVIEWED_RECOVERY_PLAN_REQUIRED));
});

test('REVERSIBLE requires a tested explicit recovery path', () => {
  const m = manifest();
  m.riskClassification.includedRiskClasses = ['REVERSIBLE'];
  assert.ok(codes(evaluate(m)).includes(BLOCKER_CODES.RECOVERY_PLAN_REQUIRED_FOR_RISK_CLASS));
});

test('EXPANSION_SAFE alone contributes no risk-class blocker', () => {
  const m = manifest();
  m.riskClassification.includedRiskClasses = ['EXPANSION_SAFE'];
  const riskBlockers = codes(evaluate(m)).filter((c) => [
    BLOCKER_CODES.PITR_REQUIRED_FOR_RISK_CLASS,
    BLOCKER_CODES.DESTRUCTIVE_MIGRATION_PROHIBITED,
    BLOCKER_CODES.REVIEWED_RECOVERY_PLAN_REQUIRED,
    BLOCKER_CODES.RECOVERY_PLAN_REQUIRED_FOR_RISK_CLASS,
  ].includes(c));
  assert.deepEqual(riskBlockers, []);
});

test('an unclassified migration in the release blocks production promotion', () => {
  const m = manifest();
  m.migrations.push({ name: 'brand_new_thing', version: '20260812000000', sourceHash: 'x', classificationStatus: 'UNCLASSIFIED_NEW', riskClassification: null });
  assert.ok(codes(evaluate(m)).includes(BLOCKER_CODES.UNCLASSIFIED_MIGRATION_IN_RELEASE));
});

test('even with every other blocker cleared, production stays blocked while reconciliation is unresolved', () => {
  const m = manifest();
  m.status = 'STAGING_VERIFIED';
  m.riskClassification.includedRiskClasses = ['EXPANSION_SAFE'];
  const result = evaluate(m, {
    lastKnownGood: { status: 'KNOWN' },
    productionProvenance: { sourceShaKnown: true, migrationLevelKnown: true, edgeFunctionAttribution: 'FULL', configFingerprintAvailable: true },
  });
  assert.equal(result.productionPromotionEligible, false);
  assert.deepEqual(codes(result), [BLOCKER_CODES.PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED]);
});

test('the validator never exposes a deploy/mutate entry point', () => {
  const mod = require('../../security/release/production-eligibility');
  const exported = Object.keys(mod);
  for (const name of exported) {
    assert.ok(
      !/deploy|apply|migrate|promote|execute|mutate/i.test(name),
      `production-eligibility must remain a pure validator; unexpected export: ${name}`,
    );
  }
  assert.deepEqual(exported.sort(), ['BLOCKER_CODES', 'PRODUCTION_SOURCE_PROVENANCE', 'evaluateEligibility']);
});

// ---- Last Known Good ----

test('current LKG state is UNKNOWN and no LKG record is committed to the repository', () => {
  assert.equal(CURRENT_LAST_KNOWN_GOOD.status, 'UNKNOWN');
  const lkgDir = path.join(REPO_ROOT, 'security', 'release', 'lkg');
  assert.ok(!fs.existsSync(lkgDir), 'no fabricated Last Known Good record may be committed in Phase 2A');
});

test('an incomplete LKG record is rejected', () => {
  const { valid, errors } = validateLastKnownGood({ releaseId: 'rel-1', sourceSha: 'abc' });
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.includes('verificationEvidence')));
});

test('a release that is not PRODUCTION_VERIFIED cannot become LKG', () => {
  const m = manifest();
  for (const state of ['DRAFT', 'FROZEN', 'STAGING_VERIFIED', 'PRODUCTION_VERIFYING', undefined]) {
    assert.throws(
      () => createLastKnownGood({
        release: m,
        releaseState: state,
        verificationEvidence: { verdict: 'PASS', source: 'test' },
        verificationTimestamp: '2026-08-12T00:00:00.000Z',
        deploymentTimestamp: '2026-08-12T00:00:00.000Z',
      }),
      (err) => err instanceof LastKnownGoodError && err.code === 'RELEASE_NOT_PRODUCTION_VERIFIED',
      `state ${state} must not mint an LKG`,
    );
  }
  assert.equal(REQUIRED_RELEASE_STATE, 'PRODUCTION_VERIFIED');
});

test('a PRODUCTION_VERIFIED release with missing evidence still cannot become LKG', () => {
  assert.throws(
    () => createLastKnownGood({
      release: manifest(),
      releaseState: 'PRODUCTION_VERIFIED',
      verificationEvidence: null,
      verificationTimestamp: null,
      deploymentTimestamp: null,
    }),
    (err) => err instanceof LastKnownGoodError && err.code === 'INCOMPLETE_LKG',
  );
});

test('verification evidence that does not assert PASS is rejected', () => {
  assert.throws(
    () => createLastKnownGood({
      release: manifest(),
      releaseState: 'PRODUCTION_VERIFIED',
      verificationEvidence: { verdict: 'BLOCKED', source: 'staging-certification' },
      verificationTimestamp: '2026-08-12T00:00:00.000Z',
      deploymentTimestamp: '2026-08-12T00:00:00.000Z',
    }),
    (err) => err.code === 'INCOMPLETE_LKG' && /verdict must be PASS/.test(err.message),
  );
});

test('a complete, production-verified release does produce a valid LKG record', () => {
  const record = createLastKnownGood({
    release: manifest(),
    releaseState: 'PRODUCTION_VERIFIED',
    verificationEvidence: { verdict: 'PASS', source: 'hypothetical-future-production-verification', runId: '123' },
    verificationTimestamp: '2026-08-12T01:00:00.000Z',
    deploymentTimestamp: '2026-08-12T00:30:00.000Z',
  });
  assert.equal(validateLastKnownGood(record).valid, true);
  assert.equal(record.releaseId, 'rel-eligibility-test');
  assert.ok(record.edgeFunctionManifestDigest);
});

test('a bare commit SHA is never accepted as an LKG', () => {
  assert.throws(
    () => createLastKnownGood({
      release: { sourceSha: 'fdb2c0fada410abb3b8ebee6413116204f49e1aa' },
      releaseState: 'PRODUCTION_VERIFIED',
      verificationEvidence: { verdict: 'PASS', source: 'wishful thinking' },
      verificationTimestamp: '2026-08-12T00:00:00.000Z',
      deploymentTimestamp: '2026-08-12T00:00:00.000Z',
    }),
    (err) => err.code === 'INCOMPLETE_LKG',
  );
});
