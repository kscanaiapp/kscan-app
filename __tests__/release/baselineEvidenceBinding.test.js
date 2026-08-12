#!/usr/bin/env node
'use strict';

/**
 * DEF-REL-010 — baselineDigest is integrity, not authenticity.
 * DEF-REL-011 — bootstrap staging applicability.
 *
 * The 2B.1 hardening was necessary but overstated what an unkeyed SHA-256
 * proves. A fabricated baseline that simply RECOMPUTES its own digest passes
 * every structural check — so provenance must come from corroboration with the
 * authoritative release evidence, never from the checksum alone.
 *
 *     baselineDigest = INTEGRITY / CONSISTENCY
 *     NOT              AUTHENTICITY / PROVENANCE
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { generateReleaseManifest, freezeManifest } = require('../../security/release/generate-release-manifest');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');
const { createReceipt, finalizeReceipt } = require('../../security/release/deployment-receipt');
const { RESULT, ATTESTATION, attestComponents, verifyExactCandidate } = require('../../security/release/verify-exact-candidate');
const {
  buildReleaseEvidence,
  computeEvidenceDigest,
  verifyEvidenceIntegrity,
  STATUS,
} = require('../../security/release/build-release-evidence');
const {
  BASELINE_SCHEMA_VERSION,
  VerifiedBaselineError,
  mintVerifiedBaseline,
  validateVerifiedBaseline,
  planBootstrapFullAttestation,
  computeBaselineDigest,
  isApplicableToEnvironment,
} = require('../../security/release/verified-baseline');
const { findEmbeddedSecrets } = require('../../security/scripts/lib/secret-shape-guard');

const REPO_ROOT = path.join(__dirname, '..', '..');

const BASE = Object.freeze({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-d10',
  sourceSha: 'a'.repeat(40),
  sourceTreeSha: 'b'.repeat(40),
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});
const manifest = (o = {}) => generateReleaseManifest({ ...BASE, ...o });

/** A complete, legitimate full-attestation run — the only route to a baseline. */
function fullAttestationRun({ deployAll = true } = {}) {
  const m = manifest();
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  const governed = m.edgeFunctions.filter((f) => f.releaseIncluded).map((f) => f.name);
  const deployed = deployAll ? governed : ['scan-identify'];

  const receipt = finalizeReceipt(
    createReceipt({
      binding: {
        releaseId: frozen.releaseId,
        candidateSha: frozen.sourceSha,
        candidateTreeSha: frozen.sourceTreeSha,
        manifestDigest: frozen.identityDigest,
        environment: 'staging',
        projectRef: STAGING_REF,
        deploymentDelta: { functions: deployed, migrations: [] },
        candidateSourceHashes: {},
        healthContractVersion: m.healthContractVersion,
        configFingerprint: m.configFingerprint,
      },
      deploymentRunId: 'run-d10',
      startedAt: '2026-08-12T00:00:00.000Z',
    }),
    { completedAt: '2026-08-12T00:05:00.000Z', status: 'PASS', functionsDeployed: deployed },
  );

  const verification = verifyExactCandidate({
    frozen,
    manifest: m,
    receipt,
    liveVersion: {
      releaseIdentityState: 'VERIFIABLE',
      releaseId: frozen.releaseId,
      sourceSha: frozen.sourceSha,
      manifestDigest: frozen.identityDigest,
      healthContractVersion: m.healthContractVersion,
    },
    liveMigrationNames: m.migrations.map((x) => x.name),
    expectedEnvironment: 'staging',
    observedProjectRef: STAGING_REF,
    previousRelease: null,
  });

  const pass = { status: STATUS.PASS };
  const evidence = buildReleaseEvidence({
    repoRoot: REPO_ROOT,
    release: {
      releaseId: frozen.releaseId,
      sourceSha: frozen.sourceSha,
      sourceTreeSha: frozen.sourceTreeSha,
      manifestDigest: frozen.identityDigest,
    },
    deployment: {
      deploymentRunId: 'run-d10',
      deploymentAttempt: 1,
      status: 'PASS',
      receiptDigest: receipt.receiptDigest,
      functionsDeployed: deployed,
      migrationsApplied: [],
    },
    exactCandidateVerification: verification,
    health: { live: pass, ready: pass, version: pass },
    smoke: { smoke_auth: pass, smoke_database_rls_rpc: pass },
    certification: {
      blocking_findings: ['leaked_password_protection'],
      operational_failures: [], report_only_findings: [], final_verdict: 'BLOCKED',
    },
    controls: { freeze_valid: pass, candidate_binding: pass },
    productionEligibility: { productionPromotionEligible: false, blockers: [{ code: 'LAST_KNOWN_GOOD_UNKNOWN' }] },
  });

  return { manifest: m, frozen, receipt, verification, evidence, governed, deployed };
}

const mint = (run, overrides = {}) => mintVerifiedBaseline({
  manifest: run.manifest,
  frozen: run.frozen,
  receipt: run.receipt,
  exactCandidateVerification: run.verification,
  releaseEvidence: run.evidence,
  verifiedAt: '2026-08-12T00:10:00.000Z',
  ...overrides,
});

const refusalCodes = (fn) => {
  try { fn(); return []; } catch (e) {
    assert.ok(e instanceof VerifiedBaselineError);
    return (e.detail || []).map((d) => d.code);
  }
};

/** Re-signs mutated evidence so only the cross-check, not integrity, can fail. */
function resign(evidence) {
  const copy = { ...evidence };
  delete copy.evidenceDigest;
  return { ...copy, evidenceDigest: computeEvidenceDigest(copy) };
}

/** A fabrication whose baselineDigest is genuinely valid — the real attack. */
function wellFormedForgery() {
  const body = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    releaseId: 'rel-forged',
    sourceSha: 'a'.repeat(40),
    sourceTreeSha: 'b'.repeat(40),
    manifestDigest: 'c'.repeat(64),
    receiptDigest: 'd'.repeat(64),
    releaseEvidenceDigest: 'e'.repeat(64),
    releaseEvidenceSourceRunId: null,
    componentSourceHashes: { 'scan-identify': 'f'.repeat(64) },
    componentAttestations: { 'scan-identify': ATTESTATION.EXACT },
    verifiedAt: '2026-08-12T00:00:00.000Z',
  };
  return { ...body, baselineDigest: computeBaselineDigest(body) };
}

// ── 1-2: the checksum is not provenance ──────────────────────────────────────

test('1. baselineDigest alone is not provenance: a valid checksum over a forgery still fails', () => {
  const result = validateVerifiedBaseline(wellFormedForgery());
  // Structurally impeccable — that is exactly the point of this defect.
  assert.equal(result.structurallyValid, true,
    'a recomputed digest satisfies integrity; integrity is not authenticity');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /PRIOR_RELEASE_EVIDENCE_MISSING/.test(e)));
});

test('2. a forgery with a freshly recomputed digest carries nothing forward', () => {
  const components = attestComponents({
    manifest: manifest(), deployedFunctions: [],
    previousRelease: { baseline: wellFormedForgery(), evidence: null },
  });
  assert.ok(components.every((c) => c.attestation === ATTESTATION.UNATTESTED));
});

// ── 3-4: both artifacts are required ─────────────────────────────────────────

test('3. a genuine baseline with no prior release evidence cannot carry forward', () => {
  const run = fullAttestationRun();
  const components = attestComponents({
    manifest: run.manifest, deployedFunctions: [],
    previousRelease: { baseline: mint(run), evidence: null },
  });
  assert.ok(components.every((c) => c.attestation === ATTESTATION.UNATTESTED),
    'even a real baseline is inert without its evidence');
});

test('4. prior evidence with no baseline cannot carry forward', () => {
  const run = fullAttestationRun();
  const components = attestComponents({
    manifest: run.manifest, deployedFunctions: [],
    previousRelease: { baseline: null, evidence: run.evidence },
  });
  assert.ok(components.every((c) => c.attestation === ATTESTATION.UNATTESTED));
});

// ── 5-10: cross-field corroboration ──────────────────────────────────────────

test('5. a mismatched evidenceDigest rejects the baseline', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  const result = validateVerifiedBaseline(baseline, {
    manifest: run.manifest,
    priorReleaseEvidence: { ...run.evidence, evidenceDigest: 'f'.repeat(64) },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /integrity check|releaseEvidenceDigest/.test(e)));
});

const CROSS_CHECKS = [
  ['6', 'releaseId', (e) => ({ ...e, release: { ...e.release, releaseId: 'rel-other' } })],
  ['7', 'sourceSha', (e) => ({ ...e, release: { ...e.release, sourceSha: 'f'.repeat(40) } })],
  ['8', 'sourceTreeSha', (e) => ({ ...e, release: { ...e.release, sourceTreeSha: 'f'.repeat(40) } })],
  ['9', 'manifestDigest', (e) => ({ ...e, release: { ...e.release, manifestDigest: 'f'.repeat(64) } })],
  ['10', 'receiptDigest', (e) => ({ ...e, deployment: { ...e.deployment, receiptDigest: 'f'.repeat(64) } })],
];

for (const [n, field, mutate] of CROSS_CHECKS) {
  test(`${n}. a mismatched ${field} between baseline and evidence rejects the baseline`, () => {
    const run = fullAttestationRun();
    const baseline = mint(run);
    const mutated = resign(mutate(run.evidence));
    const result = validateVerifiedBaseline(
      { ...baseline, releaseEvidenceDigest: mutated.evidenceDigest },
      { manifest: run.manifest, priorReleaseEvidence: mutated },
    );
    assert.equal(result.valid, false, `${field} mismatch must be rejected`);
  });
}

// ── 11-13: the prior release must actually have been verified ────────────────

test('11. prior evidence with stagingVerifiedEligible=false rejects the baseline', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  const mutated = resign({ ...run.evidence, stagingVerifiedEligible: false });
  const result = validateVerifiedBaseline(
    { ...baseline, releaseEvidenceDigest: mutated.evidenceDigest },
    { manifest: run.manifest, priorReleaseEvidence: mutated },
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /not eligible for STAGING_VERIFIED/.test(e)));
});

test('12. prior evidence whose staging-verified decision is denied rejects the baseline', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  const mutated = resign({ ...run.evidence, blockers: [{ id: 'smoke_auth', detail: 'failed' }] });
  const result = validateVerifiedBaseline(
    { ...baseline, releaseEvidenceDigest: mutated.evidenceDigest },
    { manifest: run.manifest, priorReleaseEvidence: mutated },
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /could not enter STAGING_VERIFIED/.test(e)));
});

test('13. prior exact verification that is not PASS rejects the baseline', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  const mutated = resign({
    ...run.evidence,
    exactCandidateVerification: { ...run.evidence.exactCandidateVerification, result: RESULT.BLOCKED },
  });
  const result = validateVerifiedBaseline(
    { ...baseline, releaseEvidenceDigest: mutated.evidenceDigest },
    { manifest: run.manifest, priorReleaseEvidence: mutated },
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /not PASS/.test(e)));
});

// ── 14: the legitimate path still works ──────────────────────────────────────

test('14. a matching baseline plus matching PASS evidence authorizes carry-forward', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  assert.equal(validateVerifiedBaseline(baseline, {
    manifest: run.manifest, priorReleaseEvidence: run.evidence,
  }).valid, true);

  const components = attestComponents({
    manifest: run.manifest, deployedFunctions: [],
    previousRelease: { baseline, evidence: run.evidence },
  });
  assert.ok(components.length > 0);
  assert.ok(components.every((c) => c.attestation === ATTESTATION.CARRIED_FORWARD));
});

// ── 15-18: evidence digest properties ────────────────────────────────────────

test('15. the release evidence digest is deterministic', () => {
  const a = fullAttestationRun().evidence;
  const b = fullAttestationRun().evidence;
  assert.equal(a.evidenceDigest, b.evidenceDigest);
  assert.match(a.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(verifyEvidenceIntegrity(a).valid, true);
});

test('16. mutating material release evidence changes the evidenceDigest', () => {
  const run = fullAttestationRun();
  const before = run.evidence.evidenceDigest;
  for (const mutate of [
    (e) => ({ ...e, releaseCandidateVerdict: 'BLOCKED' }),
    (e) => ({ ...e, stagingVerifiedEligible: false }),
    (e) => ({ ...e, release: { ...e.release, sourceSha: 'f'.repeat(40) } }),
    (e) => ({ ...e, blockers: [{ id: 'x', detail: 'y' }] }),
    (e) => ({ ...e, operationalFailures: [{ id: 'x', detail: 'y' }] }),
  ]) {
    const mutated = { ...mutate(run.evidence) };
    delete mutated.evidenceDigest;
    assert.notEqual(computeEvidenceDigest(mutated), before);
  }
});

test('17. evidenceDigest is excluded from its own hash', () => {
  const run = fullAttestationRun();
  const { evidenceDigest, ...withoutDigest } = run.evidence;
  assert.equal(computeEvidenceDigest(withoutDigest), evidenceDigest,
    'including the digest in its own input would make it unverifiable');
  assert.equal(computeEvidenceDigest(run.evidence), evidenceDigest);
});

test('18. no credential-shaped values appear in baseline or evidence artifacts', () => {
  const run = fullAttestationRun();
  assert.deepEqual(findEmbeddedSecrets(mint(run), 'baseline'), []);
  assert.deepEqual(findEmbeddedSecrets(run.evidence, 'evidence'), []);
});

// ── 19-22: DEF-REL-011 staging applicability ─────────────────────────────────

function bootstrapArgs(overrides = {}) {
  const m = manifest();
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  return {
    manifest: m,
    frozen,
    environment: 'staging',
    projectRef: STAGING_REF,
    liveFunctionNames: m.edgeFunctions.filter((f) => f.releaseIncluded).map((f) => f.name),
    previousVerifiedState: null,
    freezeValid: true,
    candidateBindingOk: true,
    ...overrides,
  };
}

const syntheticFn = (name, environments) => ({
  name, class: 'GOVERNED', sourcePath: `supabase/functions/${name}`,
  sourceHash: 'a'.repeat(64), sharedDependencyHash: 'b'.repeat(64),
  verifyJwt: true, releaseIncluded: true, environments,
});

const withFn = (extra) => {
  const m = manifest();
  return { ...m, edgeFunctions: [...m.edgeFunctions, extra].sort((a, b) => a.name.localeCompare(b.name)) };
};

test('19. a production-only GOVERNED function is excluded from the staging bootstrap', () => {
  const m = withFn(syntheticFn('prod-only-fn', ['production']));
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  // Deliberately NOT live on staging — a correct planner must not demand it.
  const live = m.edgeFunctions.filter((f) => f.name !== 'prod-only-fn').map((f) => f.name);
  const result = planBootstrapFullAttestation(bootstrapArgs({ manifest: m, frozen, liveFunctionNames: live }));
  assert.equal(result.ok, true, JSON.stringify(result.refusals));
  assert.ok(!result.plan.functions.includes('prod-only-fn'));
  assert.equal(isApplicableToEnvironment(syntheticFn('x', ['production']), 'staging'), false);
});

test('20. a staging-only GOVERNED function IS required by the staging bootstrap', () => {
  const m = withFn(syntheticFn('staging-only-fn', ['staging']));
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  const live = m.edgeFunctions.map((f) => f.name);
  const result = planBootstrapFullAttestation(bootstrapArgs({ manifest: m, frozen, liveFunctionNames: live }));
  assert.equal(result.ok, true, JSON.stringify(result.refusals));
  assert.ok(result.plan.functions.includes('staging-only-fn'));
  assert.ok(result.plan.functions.includes('staging-health'), 'the real staging-only function too');
});

test('21. a shared GOVERNED function with no environments remains staging-applicable', () => {
  assert.equal(isApplicableToEnvironment(syntheticFn('shared', undefined), 'staging'), true);
  assert.equal(isApplicableToEnvironment(syntheticFn('shared', null), 'staging'), true);
  const result = planBootstrapFullAttestation(bootstrapArgs());
  assert.ok(result.plan.functions.includes('scan-identify'), 'scan-identify is shared/unscoped');
});

test('22. quarantined, heritage and excluded stay excluded even when they name staging', () => {
  for (const cls of ['QUARANTINED', 'HERITAGE_UNMANAGED', 'EXCLUDED_WITH_REASON', 'UNKNOWN']) {
    assert.equal(
      isApplicableToEnvironment({ name: 'x', class: cls, releaseIncluded: true, environments: ['staging'] }, 'staging'),
      false,
      `${cls} must never be staging-applicable`,
    );
  }
});

// ── 23-25: unchanged invariants ──────────────────────────────────────────────

test('23. production promotion remains false', () => {
  assert.equal(fullAttestationRun().evidence.productionPromotionEligible, false);
});

test('24. the leaked-password classification is unchanged', () => {
  const finding = fullAttestationRun().evidence.certification.normalizedFindings
    .find((f) => f.id === 'leaked_password_protection');
  assert.equal(finding.disposition, 'OWNER_EXTERNAL_ACTION_REQUIRED');
  assert.equal(finding.stagingVerifiedBlocking, false);
  assert.equal(finding.productionPromotionBlocking, true);
});

test('25. FULL_RUNTIME_ATTESTATION_GAP still cannot mint or corroborate', () => {
  const gap = fullAttestationRun({ deployAll: false });
  assert.equal(gap.verification.result, RESULT.FULL_RUNTIME_ATTESTATION_GAP);
  assert.ok(refusalCodes(() => mint(gap)).includes('EXACT_VERIFICATION_NOT_PASS'));

  // Its evidence cannot corroborate a genuine baseline either.
  const good = fullAttestationRun();
  const baseline = mint(good);
  const result = validateVerifiedBaseline(
    { ...baseline, releaseEvidenceDigest: gap.evidence.evidenceDigest },
    { manifest: good.manifest, priorReleaseEvidence: gap.evidence },
  );
  assert.equal(result.valid, false);
});
