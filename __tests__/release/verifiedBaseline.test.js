#!/usr/bin/env node
'use strict';

/**
 * Verified baseline + BOOTSTRAP_FULL_ATTESTATION (DEF-REL-009).
 *
 * The defect these guard against: a release that FAILED exact attestation could
 * still have its manifest converted into a "previous verified state", letting
 * the next release treat never-verified hashes as trusted carry-forward
 * provenance. Provenance laundering.
 *
 * Two halves matter equally — minting must refuse unverified evidence, AND
 * consumption must refuse a fabricated baseline, because a caller can hand the
 * verifier any object it likes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { generateReleaseManifest, freezeManifest } = require('../../security/release/generate-release-manifest');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');
const { createReceipt, finalizeReceipt } = require('../../security/release/deployment-receipt');
const { RESULT, ATTESTATION, attestComponents, verifyExactCandidate } = require('../../security/release/verify-exact-candidate');
const { buildReleaseEvidence, canEnterStagingVerified, STATUS } = require('../../security/release/build-release-evidence');
const {
  BASELINE_SCHEMA_VERSION,
  RELEASE_MODE,
  VerifiedBaselineError,
  mintVerifiedBaseline,
  validateVerifiedBaseline,
  planBootstrapFullAttestation,
  computeBaselineDigest,
} = require('../../security/release/verified-baseline');
const { findEmbeddedSecrets } = require('../../security/scripts/lib/secret-shape-guard');
const verifyExactCandidateModule = require('../../security/release/verify-exact-candidate');

const REPO_ROOT = path.join(__dirname, '..', '..');

const BASE = Object.freeze({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-baseline-test',
  sourceSha: 'a'.repeat(40),
  sourceTreeSha: 'b'.repeat(40),
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});
const manifest = (o = {}) => generateReleaseManifest({ ...BASE, ...o });

/** A complete, legitimate full-attestation run — the only way to a baseline. */
function fullAttestationRun({ deployAll = true, evidenceOverrides = {} } = {}) {
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
      deploymentRunId: 'run-boot',
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
    previousVerifiedState: null,
  });

  const pass = { status: STATUS.PASS };
  const evidence = buildReleaseEvidence({
    repoRoot: REPO_ROOT,
    release: { releaseId: frozen.releaseId, sourceSha: frozen.sourceSha, sourceTreeSha: frozen.sourceTreeSha, manifestDigest: frozen.identityDigest },
    deployment: { deploymentRunId: 'run-boot', deploymentAttempt: 1, status: 'PASS', receiptDigest: receipt.receiptDigest, functionsDeployed: deployed, migrationsApplied: [] },
    exactCandidateVerification: verification,
    health: { live: pass, ready: pass, version: pass },
    smoke: { smoke_auth: pass, smoke_database_rls_rpc: pass },
    certification: { blocking_findings: ['leaked_password_protection'], operational_failures: [], report_only_findings: [], final_verdict: 'BLOCKED' },
    controls: { freeze_valid: pass, candidate_binding: pass },
    productionEligibility: { productionPromotionEligible: false, blockers: [{ code: 'LAST_KNOWN_GOOD_UNKNOWN' }] },
    ...evidenceOverrides,
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
    assert.ok(e instanceof VerifiedBaselineError, `expected VerifiedBaselineError, got ${e}`);
    assert.equal(e.code, 'VERIFIED_BASELINE_NOT_ELIGIBLE');
    return (e.detail || []).map((d) => d.code);
  }
};

// ── 1-7, 9-12: minting refuses unverified evidence ───────────────────────────

test('1. a manifest alone cannot mint a verified baseline', () => {
  const run = fullAttestationRun();
  // The old laundering entry point is gone entirely.
  assert.equal(verifyExactCandidateModule.buildVerifiedState, undefined,
    'the manifest-only constructor must not exist');
  const codes = refusalCodes(() => mintVerifiedBaseline({ manifest: run.manifest }));
  assert.ok(codes.includes('FROZEN_RELEASE_MISSING'));
  assert.ok(codes.includes('RECEIPT_MISSING'));
  assert.ok(codes.includes('EXACT_VERIFICATION_MISSING'));
  assert.ok(codes.includes('RELEASE_EVIDENCE_MISSING'));
});

test('2. FULL_RUNTIME_ATTESTATION_GAP cannot mint a baseline', () => {
  const run = fullAttestationRun({ deployAll: false });
  assert.equal(run.verification.result, RESULT.FULL_RUNTIME_ATTESTATION_GAP);
  const codes = refusalCodes(() => mint(run));
  assert.ok(codes.includes('EXACT_VERIFICATION_NOT_PASS'));
  assert.ok(codes.includes('UNATTESTED_COMPONENT_PRESENT'));
});

test('3. BLOCKED exact verification cannot mint a baseline', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, {
    exactCandidateVerification: { ...run.verification, result: RESULT.BLOCKED },
  }));
  assert.ok(codes.includes('EXACT_VERIFICATION_NOT_PASS'));
});

test('4. OPERATIONAL_FAILURE cannot mint a baseline', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, {
    exactCandidateVerification: { ...run.verification, result: RESULT.OPERATIONAL_FAILURE },
  }));
  assert.ok(codes.includes('EXACT_VERIFICATION_NOT_PASS'));
});

test('5. missing exact verification cannot mint a baseline', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, { exactCandidateVerification: null }));
  assert.ok(codes.includes('EXACT_VERIFICATION_MISSING'));
});

test('6. stagingVerifiedEligible=false cannot mint a baseline', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, {
    releaseEvidence: { ...run.evidence, stagingVerifiedEligible: false, releaseCandidateVerdict: 'BLOCKED' },
  }));
  assert.ok(codes.includes('STAGING_VERIFIED_NOT_ELIGIBLE'));
});

test('7. canEnterStagingVerified=false cannot mint a baseline', () => {
  const run = fullAttestationRun();
  const poisoned = { ...run.evidence, blockers: [{ id: 'smoke_auth', detail: 'failed' }] };
  assert.equal(canEnterStagingVerified(poisoned).allowed, false);
  const codes = refusalCodes(() => mint(run, { releaseEvidence: poisoned }));
  assert.ok(codes.includes('STAGING_VERIFIED_REFUSED'));
});

test('8. one UNATTESTED governed component prevents baseline creation', () => {
  const run = fullAttestationRun();
  const components = [...run.verification.components];
  components[0] = { ...components[0], attestation: ATTESTATION.UNATTESTED };
  const codes = refusalCodes(() => mint(run, {
    exactCandidateVerification: { ...run.verification, components },
  }));
  assert.ok(codes.includes('UNATTESTED_COMPONENT_PRESENT'));
});

test('9. receipt integrity failure prevents baseline creation', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, {
    receipt: { ...run.receipt, candidateSha: 'f'.repeat(40) },
  }));
  assert.ok(codes.includes('RECEIPT_INTEGRITY_FAILED'));
});

test('10. source SHA mismatch prevents baseline creation', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, { frozen: { ...run.frozen, sourceSha: 'f'.repeat(40) } }));
  assert.ok(codes.includes('SOURCE_SHA_MISMATCH'));
});

test('11. source tree mismatch prevents baseline creation', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, { frozen: { ...run.frozen, sourceTreeSha: 'f'.repeat(40) } }));
  assert.ok(codes.includes('SOURCE_TREE_MISMATCH'));
});

test('12. manifest digest mismatch prevents baseline creation', () => {
  const run = fullAttestationRun();
  const codes = refusalCodes(() => mint(run, { frozen: { ...run.frozen, identityDigest: 'f'.repeat(64) } }));
  assert.ok(codes.includes('MANIFEST_DIGEST_MISMATCH'));
});

test('an unfinalized receipt cannot mint a baseline', () => {
  const run = fullAttestationRun();
  const { receiptDigest, ...unfinalized } = run.receipt;
  const codes = refusalCodes(() => mint(run, { receipt: unfinalized }));
  assert.ok(codes.includes('RECEIPT_NOT_FINALIZED'));
});

// ── 13-14: the legitimate path ───────────────────────────────────────────────

test('13. a fully exact run with valid receipt and eligible evidence mints a baseline', () => {
  const run = fullAttestationRun();
  assert.equal(run.verification.result, RESULT.PASS);
  const baseline = mint(run);
  assert.equal(baseline.schemaVersion, BASELINE_SCHEMA_VERSION);
  assert.equal(validateVerifiedBaseline(baseline, { manifest: run.manifest }).valid, true);
});

test('14. the baseline binds source SHA, tree, manifest, receipt and component hashes', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  assert.equal(baseline.sourceSha, run.frozen.sourceSha);
  assert.equal(baseline.sourceTreeSha, run.frozen.sourceTreeSha);
  assert.equal(baseline.manifestDigest, run.frozen.identityDigest);
  assert.equal(baseline.receiptDigest, run.receipt.receiptDigest);
  assert.equal(Object.keys(baseline.componentSourceHashes).length, run.governed.length);
  for (const name of run.governed) {
    assert.equal(baseline.componentAttestations[name], ATTESTATION.EXACT);
  }
  assert.match(baseline.baselineDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(findEmbeddedSecrets(baseline, 'baseline'), []);
});

// ── 15: consumption validation ───────────────────────────────────────────────

test('15. baseline validation rejects fabricated and incomplete state', () => {
  const run = fullAttestationRun();
  const good = mint(run);

  // Hand-written, manifest-shaped object — the exact laundering artefact.
  const fabricated = {
    schemaVersion: 1,
    releaseId: 'rel-made-up',
    sourceSha: 'a'.repeat(40),
    sourceTreeSha: 'b'.repeat(40),
    manifestDigest: 'c'.repeat(64),
    receiptDigest: 'd'.repeat(64),
    componentSourceHashes: { 'scan-identify': 'e'.repeat(64) },
    componentAttestations: { 'scan-identify': ATTESTATION.EXACT },
    baselineDigest: 'f'.repeat(64),
  };
  const fab = validateVerifiedBaseline(fabricated);
  assert.equal(fab.valid, false);
  assert.ok(fab.errors.some((e) => /fabricated or modified/.test(e)));

  // Incomplete.
  const { receiptDigest, ...incomplete } = good;
  assert.equal(validateVerifiedBaseline(incomplete).valid, false);

  // Tampered after minting.
  const tampered = { ...good, sourceSha: 'f'.repeat(40) };
  assert.equal(validateVerifiedBaseline(tampered).valid, false);

  // Malformed component hash.
  const malformed = { ...good, componentSourceHashes: { ...good.componentSourceHashes, 'scan-identify': 'nope' } };
  assert.equal(validateVerifiedBaseline(malformed).valid, false);
});

test('a baseline claiming a quarantined or unclassified component is rejected', () => {
  const run = fullAttestationRun();
  const good = mint(run);
  const body = {
    ...good,
    componentSourceHashes: { ...good.componentSourceHashes, 'product-match': 'a'.repeat(64) },
    componentAttestations: { ...good.componentAttestations, 'product-match': ATTESTATION.EXACT },
  };
  delete body.baselineDigest;
  const resigned = { ...body, baselineDigest: computeBaselineDigest(body) };

  const m = manifest({ liveFunctionNames: ['product-match'] });
  const result = validateVerifiedBaseline(resigned, { manifest: m });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /QUARANTINED component product-match/.test(e)));
});

test('a baseline recording an UNATTESTED component is rejected on consumption', () => {
  const run = fullAttestationRun();
  const good = mint(run);
  const first = Object.keys(good.componentAttestations)[0];
  const body = { ...good, componentAttestations: { ...good.componentAttestations, [first]: ATTESTATION.UNATTESTED } };
  delete body.baselineDigest;
  const resigned = { ...body, baselineDigest: computeBaselineDigest(body) };
  const result = validateVerifiedBaseline(resigned);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /UNATTESTED component/.test(e)));
});

// ── 16-25: BOOTSTRAP_FULL_ATTESTATION ────────────────────────────────────────

function bootstrapArgs(overrides = {}) {
  const m = manifest();
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  const governed = m.edgeFunctions.filter((f) => f.releaseIncluded).map((f) => f.name);
  return {
    manifest: m,
    frozen,
    environment: 'staging',
    projectRef: STAGING_REF,
    liveFunctionNames: governed,
    previousVerifiedState: null,
    freezeValid: true,
    candidateBindingOk: true,
    ...overrides,
  };
}
const codesOf = (result) => result.refusals.map((r) => r.code);

test('16. bootstrap rejects production', () => {
  const result = planBootstrapFullAttestation(bootstrapArgs({ environment: 'production', projectRef: PRODUCTION_REF }));
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('BOOTSTRAP_STAGING_ONLY'));
  assert.ok(codesOf(result).includes('BOOTSTRAP_UNKNOWN_PROJECT'));
});

test('17. bootstrap rejects an unknown environment/project', () => {
  const result = planBootstrapFullAttestation(bootstrapArgs({ projectRef: 'a'.repeat(20) }));
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('BOOTSTRAP_UNKNOWN_PROJECT'));
});

test('18. bootstrap rejects missing environment identity', () => {
  const missingRef = planBootstrapFullAttestation(bootstrapArgs({ projectRef: null }));
  assert.equal(missingRef.ok, false);
  assert.ok(codesOf(missingRef).includes('BOOTSTRAP_ENVIRONMENT_IDENTITY_MISSING'));

  const missingEnv = planBootstrapFullAttestation(bootstrapArgs({ environment: undefined }));
  assert.equal(missingEnv.ok, false);
  assert.ok(codesOf(missingEnv).includes('BOOTSTRAP_STAGING_ONLY'));
});

test('19. bootstrap rejects when a verified baseline already exists', () => {
  const run = fullAttestationRun();
  const result = planBootstrapFullAttestation(bootstrapArgs({ previousVerifiedState: mint(run) }));
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('BOOTSTRAP_BASELINE_ALREADY_EXISTS'));
});

test('bootstrap rejects an invalid freeze or failed candidate binding', () => {
  assert.ok(codesOf(planBootstrapFullAttestation(bootstrapArgs({ freezeValid: false }))).includes('BOOTSTRAP_FREEZE_INVALID'));
  assert.ok(codesOf(planBootstrapFullAttestation(bootstrapArgs({ candidateBindingOk: false }))).includes('BOOTSTRAP_CANDIDATE_BINDING_FAILED'));
});

test('20. the bootstrap plan contains every already-live staging-applicable GOVERNED function', () => {
  const args = bootstrapArgs();
  const result = planBootstrapFullAttestation(args);
  assert.equal(result.ok, true, JSON.stringify(result.refusals));
  const governed = args.manifest.edgeFunctions.filter((f) => f.releaseIncluded).map((f) => f.name).sort();
  assert.deepEqual(result.plan.functions, governed);
  assert.ok(result.plan.functions.includes('staging-health'));
  assert.equal(result.mode, RELEASE_MODE.BOOTSTRAP_FULL_ATTESTATION);
});

test('21-23. bootstrap excludes QUARANTINED, HERITAGE_UNMANAGED and EXCLUDED_WITH_REASON', () => {
  const m = manifest({ liveFunctionNames: ['product-match', 'privacy-controls', 'public-sale-share-opt-out'] });
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  const live = m.edgeFunctions.map((f) => f.name); // pretend everything is live
  const result = planBootstrapFullAttestation(bootstrapArgs({ manifest: m, frozen, liveFunctionNames: live }));
  assert.equal(result.ok, true, JSON.stringify(result.refusals));
  for (const forbidden of ['product-match', 'privacy-controls', 'public-sale-share-opt-out']) {
    assert.ok(!result.plan.functions.includes(forbidden), `${forbidden} must never be bootstrapped`);
  }
  const excludedClasses = new Set(result.plan.excludedByGovernance.map((e) => e.class));
  assert.ok(excludedClasses.has('QUARANTINED'));
  assert.ok(excludedClasses.has('HERITAGE_UNMANAGED'));
});

test('24. bootstrap stops if a staging-applicable governed function is absent from live staging', () => {
  const args = bootstrapArgs();
  const governed = args.manifest.edgeFunctions.filter((f) => f.releaseIncluded).map((f) => f.name);
  const result = planBootstrapFullAttestation({ ...args, liveFunctionNames: governed.filter((n) => n !== 'staging-health') });
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('BOOTSTRAP_LIVE_INVENTORY_RECONCILIATION_REQUIRED'));
  assert.deepEqual(result.absentGovernedFunctions, ['staging-health']);
  assert.equal(result.plan, null, 'bootstrap must not plan to install a missing function');
});

test('bootstrap refuses when the live inventory is unavailable', () => {
  const result = planBootstrapFullAttestation(bootstrapArgs({ liveFunctionNames: null }));
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('BOOTSTRAP_LIVE_INVENTORY_UNAVAILABLE'));
});

test('25. bootstrap does not reapply migrations for attestation', () => {
  const result = planBootstrapFullAttestation(bootstrapArgs());
  assert.deepEqual(result.plan.migrations, []);
  assert.match(result.plan.migrationsNote, /never replayed/);
});

// ── 26-28: steady-state carry-forward ────────────────────────────────────────

test('26. after a valid baseline, an unchanged component may be CARRIED_FORWARD', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  const components = attestComponents({
    manifest: run.manifest, deployedFunctions: [], previousVerifiedState: baseline,
  });
  assert.ok(components.length > 0);
  assert.ok(components.every((c) => c.attestation === ATTESTATION.CARRIED_FORWARD));
});

test('27. a changed-but-not-deployed component becomes UNATTESTED', () => {
  const run = fullAttestationRun();
  const baseline = mint(run);
  // Simulate the candidate changing a governed component's source.
  const changed = {
    ...run.manifest,
    edgeFunctions: run.manifest.edgeFunctions.map((f) => (
      f.name === 'scan-identify' ? { ...f, sourceHash: 'f'.repeat(64) } : f
    )),
  };
  const components = attestComponents({ manifest: changed, deployedFunctions: [], previousVerifiedState: baseline });
  const scan = components.find((c) => c.name === 'scan-identify');
  assert.equal(scan.attestation, ATTESTATION.UNATTESTED, 'changed code must never be carried forward');
});

test('28. an invalid or fabricated prior baseline cannot authorize CARRIED_FORWARD', () => {
  const run = fullAttestationRun();
  const good = mint(run);
  // Same field names, tampered content — the laundering artefact.
  const fabricated = { ...good, releaseId: 'rel-i-made-this-up' };
  const components = attestComponents({
    manifest: run.manifest, deployedFunctions: [], previousVerifiedState: fabricated,
  });
  assert.ok(components.every((c) => c.attestation === ATTESTATION.UNATTESTED),
    'a rejected baseline must carry nothing forward');
  assert.ok(components[0].basis.includes('rejected'));
});

test('a fabricated baseline cannot rescue a release into exact PASS', () => {
  const run = fullAttestationRun({ deployAll: false });
  const good = mint(fullAttestationRun());
  const fabricated = { ...good, releaseId: 'laundered' };
  const result = verifyExactCandidate({
    frozen: run.frozen,
    manifest: run.manifest,
    receipt: run.receipt,
    liveVersion: {
      releaseIdentityState: 'VERIFIABLE',
      releaseId: run.frozen.releaseId,
      sourceSha: run.frozen.sourceSha,
      manifestDigest: run.frozen.identityDigest,
      healthContractVersion: run.manifest.healthContractVersion,
    },
    liveMigrationNames: run.manifest.migrations.map((x) => x.name),
    expectedEnvironment: 'staging',
    observedProjectRef: STAGING_REF,
    previousVerifiedState: fabricated,
  });
  assert.equal(result.result, RESULT.FULL_RUNTIME_ATTESTATION_GAP);
});

// ── 29-30: unchanged invariants ──────────────────────────────────────────────

test('29. production eligibility remains false', () => {
  const run = fullAttestationRun();
  assert.equal(run.evidence.productionPromotionEligible, false);
  assert.ok(run.evidence.productionBlockers.includes('LAST_KNOWN_GOOD_UNKNOWN'));
  // A minted baseline is a STAGING trust root and must not touch production.
  const baseline = mint(run);
  assert.ok(!('productionPromotionEligible' in baseline));
});

test('30. the leaked-password classification is unchanged by this correction', () => {
  const run = fullAttestationRun();
  const finding = run.evidence.certification.normalizedFindings.find((f) => f.id === 'leaked_password_protection');
  assert.equal(finding.scope, 'ENVIRONMENT');
  assert.equal(finding.disposition, 'OWNER_EXTERNAL_ACTION_REQUIRED');
  assert.equal(finding.stagingVerifiedBlocking, false);
  assert.equal(finding.productionPromotionBlocking, true);
  assert.equal(run.evidence.stagingVerifiedEligible, true);
});
