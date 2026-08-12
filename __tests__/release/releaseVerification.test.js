#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { generateReleaseManifest, freezeManifest, verifyFreeze } = require('../../security/release/generate-release-manifest');
const { STAGING_REF, PRODUCTION_REF } = require('../../security/scripts/lib/environment-authority');
const {
  CandidateBindingError,
  validateDeploymentDelta,
  findWorkingTreeDivergence,
  resolveCandidate,
  bindCandidate,
} = require('../../security/release/candidate-binding');
const {
  RECEIPT_SCHEMA_VERSION,
  createReceipt,
  finalizeReceipt,
  nextAttempt,
  validateReceipt,
  verifyReceiptIntegrity,
} = require('../../security/release/deployment-receipt');
const {
  RESULT,
  ATTESTATION,
  attestComponents,
  verifyExactCandidate,
} = require('../../security/release/verify-exact-candidate');
const { mintVerifiedBaseline } = require('../../security/release/verified-baseline');
const {
  STATUS,
  loadPolicy,
  normalizeCertification,
  buildReleaseEvidence,
  canEnterStagingVerified,
} = require('../../security/release/build-release-evidence');
const { CATEGORIES, runReleaseSmoke } = require('../../security/release/run-release-smoke');
const { findEmbeddedSecrets } = require('../../security/scripts/lib/secret-shape-guard');

const REPO_ROOT = path.join(__dirname, '..', '..');

const BASE = Object.freeze({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-2b-test',
  sourceSha: 'a'.repeat(40),
  sourceTreeSha: 'b'.repeat(40),
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});
const manifest = (o = {}) => generateReleaseManifest({ ...BASE, ...o });

// ── staging-health governance ────────────────────────────────────────────────

test('staging-health is GOVERNED and release-included', () => {
  const entry = manifest().edgeFunctions.find((f) => f.name === 'staging-health');
  assert.equal(entry.class, 'GOVERNED');
  assert.equal(entry.releaseIncluded, true);
});

test('quarantine and heritage classifications are unchanged by Phase 2B', () => {
  const m = manifest({ liveFunctionNames: ['product-match', 'privacy-controls', 'public-sale-share-opt-out'] });
  const by = Object.fromEntries(m.edgeFunctions.map((f) => [f.name, f]));
  assert.equal(by['product-match'].class, 'QUARANTINED');
  assert.equal(by['privacy-controls'].class, 'HERITAGE_UNMANAGED');
  assert.equal(by['public-sale-share-opt-out'].class, 'HERITAGE_UNMANAGED');
  for (const name of ['product-match', 'privacy-controls', 'public-sale-share-opt-out']) {
    assert.equal(by[name].releaseIncluded, false);
  }
});

test('staging-health source change invalidates the freeze', () => {
  const sandbox = makeSandbox();
  const frozen = freezeManifest(manifest({ repoRoot: sandbox }));
  fs.appendFileSync(path.join(sandbox, 'supabase', 'functions', 'staging-health', 'index.ts'), '\n// probe\n');
  const result = verifyFreeze(frozen, manifest({ repoRoot: sandbox }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('IDENTITY_DIGEST_CHANGED'));
});

test('health contract v1 is identity material', () => {
  assert.equal(manifest().healthContractVersion, 'health-contract-v1');
});

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-2b-'));
  const copy = (rel) => {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src)) return;
    fs.cpSync(src, path.join(root, rel), { recursive: true });
  };
  copy(path.join('supabase', 'functions'));
  copy(path.join('supabase', 'migrations'));
  copy(path.join('security', 'release'));
  copy('constants');
  fs.mkdirSync(path.join(root, 'supabase'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'supabase', 'config.toml'), path.join(root, 'supabase', 'config.toml'));
  return root;
}

// ── health contract surface ──────────────────────────────────────────────────

const HEALTH_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'supabase', 'functions', 'staging-health', 'index.ts'), 'utf8',
);

test('liveness is cheap: no database, storage or provider call in its handler', () => {
  const handler = HEALTH_SRC.slice(HEALTH_SRC.indexOf('function handleLive'), HEALTH_SRC.indexOf('async function handleReady'));
  assert.ok(!/fetch\(/.test(handler), 'liveness must not make a network call');
  assert.ok(!/checkDatabase|checkCoreTables|checkMigrationHistory/.test(handler), 'liveness must not run dependency checks');
});

test('readiness is bounded and makes no provider call', () => {
  const handler = HEALTH_SRC.slice(HEALTH_SRC.indexOf('async function handleReady'), HEALTH_SRC.indexOf('function handleVersion'));
  assert.ok(/withTimeout\(/.test(handler), 'readiness checks must be timeout-bounded');
  assert.ok(!/gemini|openrouter|generateContent/i.test(handler), 'readiness must not call an AI provider');
});

test('version exposes only safe release identity fields', () => {
  const handler = HEALTH_SRC.slice(HEALTH_SRC.indexOf('function handleVersion'), HEALTH_SRC.indexOf('async function handleLegacyRoot'));
  for (const forbidden of ['SERVICE_ROLE', 'ANON_KEY', 'apikey', 'Authorization']) {
    assert.ok(!handler.includes(forbidden), `/version must not reference ${forbidden}`);
  }
  assert.ok(handler.includes('releaseIdentityState'), '/version must report whether identity is verifiable');
});

test('the health surface filters credential-shaped values defensively', () => {
  assert.ok(HEALTH_SRC.includes('CREDENTIAL_SHAPES'), 'publicly reachable surface must filter credential shapes');
  assert.ok(HEALTH_SRC.includes('REDACTED_CREDENTIAL_SHAPED_VALUE'));
});

test('the legacy root response is preserved for the existing CI gate', () => {
  // staging-controlled-deploy.yml curls the function root and asserts
  // status == "healthy" and environment == "staging".
  const handler = HEALTH_SRC.slice(HEALTH_SRC.indexOf('async function handleLegacyRoot'));
  assert.match(handler, /status,/);
  assert.match(handler, /environment: 'staging'/);
});

test('every response hardcodes its environment as a literal', () => {
  // A shared constant could be repointed in a single edit; inlining means each
  // response independently asserts staging. stagingDeployPipeline.test.js
  // enforces the same property from the security side.
  assert.ok(!/const ENVIRONMENT\s*=/.test(HEALTH_SRC), 'environment must not be a single shared binding');
  const literals = HEALTH_SRC.match(/environment: 'staging'/g) || [];
  assert.ok(literals.length >= 4, `expected each response to hardcode staging, found ${literals.length}`);
});

// ── candidate binding ────────────────────────────────────────────────────────

test('deployment delta must be a subset of the governed manifest', () => {
  const m = manifest();
  assert.equal(validateDeploymentDelta({ manifest: m, functions: ['scan-identify'] }).ok, true);

  const unknown = validateDeploymentDelta({ manifest: m, functions: ['not-a-real-function'] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.violations[0].code, 'UNKNOWN_COMPONENT');
});

test('quarantined and heritage components are rejected from a deployment delta', () => {
  const m = manifest({ liveFunctionNames: ['product-match', 'privacy-controls'] });
  assert.equal(validateDeploymentDelta({ manifest: m, functions: ['product-match'] }).violations[0].code, 'QUARANTINED_COMPONENT');
  assert.equal(validateDeploymentDelta({ manifest: m, functions: ['privacy-controls'] }).violations[0].code, 'HERITAGE_COMPONENT');
});

test('a migration outside the frozen candidate is rejected', () => {
  const result = validateDeploymentDelta({ manifest: manifest(), migrations: ['not_in_this_candidate'] });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, 'MIGRATION_NOT_IN_MANIFEST');
});

test('an unresolvable candidate ref is rejected', () => {
  assert.throws(
    () => resolveCandidate(REPO_ROOT, 'definitely-not-a-real-ref-2b'),
    (e) => e instanceof CandidateBindingError && e.code === 'CANDIDATE_NOT_FOUND',
  );
  assert.throws(() => resolveCandidate(REPO_ROOT, ''), { code: 'MISSING_CANDIDATE' });
});

test('binding fails closed when the environment does not resolve to staging', () => {
  assert.throws(
    () => bindCandidate({
      repoRoot: REPO_ROOT, candidateRef: 'HEAD', frozen: {}, manifest: manifest(),
      expectedEnvironment: 'staging', projectRef: PRODUCTION_REF,
    }),
    { code: 'ENVIRONMENT_MISMATCH' },
  );
});

test('a dirty release-relevant working tree is detected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-dirty-'));
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'Gate');
  fs.mkdirSync(path.join(root, 'supabase', 'functions', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'supabase', 'functions', 'x', 'index.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  assert.deepEqual(findWorkingTreeDivergence(root, sha), [], 'clean tree has no divergence');

  fs.appendFileSync(path.join(root, 'supabase', 'functions', 'x', 'index.ts'), '// local edit\n');
  const diverged = findWorkingTreeDivergence(root, sha);
  assert.ok(diverged.includes('supabase/functions/x/index.ts'), `expected divergence, got ${diverged.join(',')}`);

  fs.rmSync(root, { recursive: true, force: true });
});

// ── deployment receipt ───────────────────────────────────────────────────────

const binding = () => ({
  releaseId: 'rel-2b-test',
  candidateSha: 'a'.repeat(40),
  candidateTreeSha: 'b'.repeat(40),
  manifestDigest: 'c'.repeat(64),
  environment: 'staging',
  projectRef: STAGING_REF,
  deploymentDelta: { functions: ['scan-identify'], migrations: [] },
  candidateSourceHashes: { 'scan-identify': 'd'.repeat(64) },
  healthContractVersion: 'health-contract-v1',
  configFingerprint: 'e'.repeat(64),
});

test('a valid receipt finalizes, carries a digest and is immutable', () => {
  const receipt = createReceipt({ binding: binding(), deploymentRunId: 'run-1', startedAt: '2026-08-12T00:00:00.000Z' });
  const final = finalizeReceipt(receipt, {
    completedAt: '2026-08-12T00:05:00.000Z', status: 'PASS', functionsDeployed: ['scan-identify'],
  });
  assert.equal(final.schemaVersion, RECEIPT_SCHEMA_VERSION);
  assert.match(final.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(verifyReceiptIntegrity(final).valid, true);
  assert.ok(Object.isFrozen(final));
});

test('tampering with a finalized receipt is detectable', () => {
  const final = finalizeReceipt(
    createReceipt({ binding: binding(), deploymentRunId: 'run-1', startedAt: '2026-08-12T00:00:00.000Z' }),
    { completedAt: '2026-08-12T00:05:00.000Z', status: 'PASS' },
  );
  const tampered = { ...final, candidateSha: 'f'.repeat(40) };
  const result = verifyReceiptIntegrity(tampered);
  assert.equal(result.valid, false);
  assert.match(result.reason, /modified after finalization/);
});

test('a receipt with a missing required field is rejected', () => {
  const receipt = createReceipt({ binding: binding(), deploymentRunId: 'run-1' });
  delete receipt.manifestDigest;
  const { valid, errors } = validateReceipt(receipt);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('manifestDigest')));
});

test('a receipt whose environment and project ref disagree is rejected', () => {
  assert.throws(
    () => createReceipt({ binding: { ...binding(), projectRef: PRODUCTION_REF }, deploymentRunId: 'run-1' }),
    { code: 'ENVIRONMENT_MISMATCH' },
  );
  const mismatched = { ...createReceipt({ binding: binding(), deploymentRunId: 'run-1' }), projectRef: PRODUCTION_REF };
  assert.equal(validateReceipt(mismatched).valid, false);
});

test('a retry produces a new attempt identity rather than editing prior evidence', () => {
  const first = finalizeReceipt(
    createReceipt({ binding: binding(), deploymentRunId: 'run-1', startedAt: '2026-08-12T00:00:00.000Z' }),
    { completedAt: '2026-08-12T00:01:00.000Z', status: 'BLOCKED' },
  );
  const second = nextAttempt(first, { binding: binding(), deploymentRunId: 'run-1' });
  assert.equal(second.deploymentAttempt, 2);
  assert.equal(first.deploymentAttempt, 1, 'the prior receipt must be untouched');
  const secondFinal = finalizeReceipt(second, { completedAt: '2026-08-12T00:06:00.000Z', status: 'PASS' });
  assert.notEqual(secondFinal.receiptDigest, first.receiptDigest);
});

test('a receipt carrying a credential-shaped value is refused', () => {
  const receipt = createReceipt({ binding: binding(), deploymentRunId: 'run-1' });
  receipt.deployResults = [{ note: 'sbp_NOTAREALTOKENONLYATESTSENTINEL' }];
  assert.equal(validateReceipt(receipt).valid, false);
  assert.deepEqual(findEmbeddedSecrets({ ok: 'plain metadata' }), []);
});

// ── exact candidate verification ─────────────────────────────────────────────

/**
 * Mints a baseline the only legitimate way: a full-attestation run where every
 * governed component is EXACTLY_DEPLOYED and the release reaches
 * STAGING_VERIFIED. This is the BOOTSTRAP_FULL_ATTESTATION shape.
 *
 * There is deliberately no shortcut — a manifest alone can no longer produce a
 * baseline (DEF-REL-009).
 */
function mintLegitimateBaseline(overrides = {}) {
  const m = manifest();
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  const allGoverned = m.edgeFunctions.filter((f) => f.releaseIncluded).map((f) => f.name);

  const receipt = finalizeReceipt(
    createReceipt({
      binding: {
        ...binding(),
        candidateSha: frozen.sourceSha,
        candidateTreeSha: frozen.sourceTreeSha,
        manifestDigest: frozen.identityDigest,
      },
      deploymentRunId: 'bootstrap-run',
      startedAt: '2026-08-12T00:00:00.000Z',
    }),
    { completedAt: '2026-08-12T00:05:00.000Z', status: 'PASS', functionsDeployed: allGoverned },
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

  // The evidence must describe THIS run, not the generic fixture: the baseline
  // binds it and consumption cross-checks release id / SHA / tree / manifest /
  // receipt digest, so a mismatched fixture would (correctly) be rejected.
  const evidence = buildReleaseEvidence(evidenceInputs({
    release: {
      releaseId: frozen.releaseId,
      sourceSha: frozen.sourceSha,
      sourceTreeSha: frozen.sourceTreeSha,
      manifestDigest: frozen.identityDigest,
    },
    deployment: {
      deploymentRunId: 'bootstrap-run',
      deploymentAttempt: 1,
      status: 'PASS',
      receiptDigest: receipt.receiptDigest,
      functionsDeployed: allGoverned,
      migrationsApplied: [],
    },
    exactCandidateVerification: verification,
  }));

  return {
    manifest: m,
    frozen,
    receipt,
    verification,
    evidence,
    baseline: mintVerifiedBaseline({
      manifest: m, frozen, receipt,
      exactCandidateVerification: verification,
      releaseEvidence: evidence,
      verifiedAt: '2026-08-12T00:10:00.000Z',
      ...overrides,
    }),
  };
}

function verificationInputs(overrides = {}) {
  const m = manifest();
  const frozen = freezeManifest(m, { frozenAt: '2026-08-12T00:00:00.000Z' });
  const deployed = ['scan-identify'];
  const receipt = finalizeReceipt(
    createReceipt({
      binding: {
        ...binding(),
        candidateSha: frozen.sourceSha,
        candidateTreeSha: frozen.sourceTreeSha,
        manifestDigest: frozen.identityDigest,
      },
      deploymentRunId: 'run-1',
      startedAt: '2026-08-12T00:00:00.000Z',
    }),
    { completedAt: '2026-08-12T00:05:00.000Z', status: 'PASS', functionsDeployed: deployed },
  );
  return {
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
    // Carry-forward now requires the baseline AND its source evidence.
    previousRelease: (() => { const r = mintLegitimateBaseline(); return { baseline: r.baseline, evidence: r.evidence }; })(),
    ...overrides,
  };
}

test('fully corroborated candidate verifies PASS', () => {
  const result = verifyExactCandidate(verificationInputs());
  assert.equal(result.result, RESULT.PASS, JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')));
});

test('a wrong deployed SHA is BLOCKED', () => {
  const inputs = verificationInputs();
  const result = verifyExactCandidate({ ...inputs, frozen: { ...inputs.frozen, sourceSha: 'f'.repeat(40) } });
  assert.equal(result.result, RESULT.BLOCKED);
  assert.ok(result.checks.some((c) => c.id === 'receipt_sha_matches_freeze' && c.status === 'BLOCKED'));
});

test('a wrong manifest digest is BLOCKED', () => {
  const inputs = verificationInputs();
  const result = verifyExactCandidate({ ...inputs, frozen: { ...inputs.frozen, identityDigest: 'f'.repeat(64) } });
  assert.equal(result.result, RESULT.BLOCKED);
});

test('a wrong environment is BLOCKED', () => {
  const result = verifyExactCandidate({ ...verificationInputs(), observedProjectRef: PRODUCTION_REF });
  assert.equal(result.result, RESULT.BLOCKED);
  assert.ok(result.checks.some((c) => c.id === 'environment_matches_expected' && c.status === 'BLOCKED'));
});

test('missing live /version evidence is OPERATIONAL_FAILURE, not a pass', () => {
  const result = verifyExactCandidate({ ...verificationInputs(), liveVersion: null });
  assert.equal(result.result, RESULT.OPERATIONAL_FAILURE);
});

test('a deployment reporting NOT_VERIFIABLE identity is OPERATIONAL_FAILURE', () => {
  const inputs = verificationInputs();
  const result = verifyExactCandidate({ ...inputs, liveVersion: { releaseIdentityState: 'NOT_VERIFIABLE' } });
  assert.equal(result.result, RESULT.OPERATIONAL_FAILURE);
});

test('missing required evidence entirely is OPERATIONAL_FAILURE', () => {
  assert.equal(verifyExactCandidate({ frozen: null, manifest: null, receipt: null }).result, RESULT.OPERATIONAL_FAILURE);
});

test('with no prior verified state, unchanged components are UNATTESTED and the run reports the attestation gap', () => {
  const result = verifyExactCandidate({ ...verificationInputs(), previousRelease: null, previousVerifiedState: null });
  assert.equal(result.result, RESULT.FULL_RUNTIME_ATTESTATION_GAP);
  assert.ok(result.components.some((c) => c.attestation === ATTESTATION.UNATTESTED));
  assert.ok(result.limitations.some((l) => /No previous verified release baseline/.test(l)));
});

test('carried-forward attestation requires a matching prior verified baseline', () => {
  const m = manifest();
  const withPrior = attestComponents({
    manifest: m,
    deployedFunctions: [],
    previousRelease: (() => { const r = mintLegitimateBaseline(); return { baseline: r.baseline, evidence: r.evidence }; })(),
  });
  assert.ok(withPrior.every((c) => c.attestation === ATTESTATION.CARRIED_FORWARD));

  // A bare, uncorroborated object is refused outright now.
  const stale = attestComponents({
    manifest: m,
    deployedFunctions: [],
    previousRelease: { baseline: { releaseId: 'p', componentSourceHashes: { 'scan-identify': 'different' } }, evidence: null },
  });
  assert.ok(stale.every((c) => c.attestation === ATTESTATION.UNATTESTED));
});

test('a deployed component outside the governed set is BLOCKED', () => {
  const inputs = verificationInputs();
  const receipt = { ...inputs.receipt, functionsDeployed: ['product-match'] };
  const result = verifyExactCandidate({ ...inputs, receipt });
  assert.ok(result.checks.some((c) => c.id === 'no_ungoverned_component_deployed' && c.status === 'BLOCKED'));
});

test('the verifier always discloses its byte-level attestation limitation', () => {
  const result = verifyExactCandidate(verificationInputs());
  assert.ok(result.limitations.some((l) => /ezbr_sha256/.test(l)));
});

// ── policy normalization ─────────────────────────────────────────────────────

const policy = loadPolicy(REPO_ROOT);

test('leaked-password protection normalizes to an environment-scoped owner action', () => {
  const norm = normalizeCertification({
    certification: { blocking_findings: ['leaked_password_protection'], final_verdict: 'BLOCKED' },
    policy,
  });
  const finding = norm.normalizedFindings.find((f) => f.id === 'leaked_password_protection');
  assert.equal(finding.scope, 'ENVIRONMENT');
  assert.equal(finding.disposition, 'OWNER_EXTERNAL_ACTION_REQUIRED');
  assert.equal(finding.releaseContentBlocking, false);
  assert.equal(finding.stagingVerifiedBlocking, false);
  assert.equal(finding.productionPromotionBlocking, true);
});

test('an unknown certification finding fails closed', () => {
  const norm = normalizeCertification({
    certification: { blocking_findings: ['some_brand_new_finding'], final_verdict: 'BLOCKED' },
    policy,
  });
  const finding = norm.normalizedFindings[0];
  assert.equal(finding.classified, false);
  assert.equal(finding.stagingVerifiedBlocking, true);
  assert.equal(finding.productionPromotionBlocking, true);
});

test('native UI automation policy is delegated, not reinterpreted', () => {
  assert.equal(policy.findings.native_ui_automation.disposition, 'GOVERNED_BY_EXISTING_POLICY');
  assert.equal(policy.findings.native_ui_automation.delegatedTo, 'security/release/native-ui-automation-policy.json');
  const existing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'security', 'release', 'native-ui-automation-policy.json'), 'utf8'));
  assert.equal(existing.status, 'SUSPENDED');
  assert.equal(existing.required_for_release, false);
  assert.equal(existing.policy_outcome, 'NOT_REQUIRED_BY_CURRENT_POLICY');
});

test('missing certification evidence is an operational failure, not a pass', () => {
  const norm = normalizeCertification({ certification: null, policy });
  assert.equal(norm.available, false);
  assert.equal(norm.operationalFailures.length, 1);
});

// ── release evidence + STAGING_VERIFIED ──────────────────────────────────────

function evidenceInputs(overrides = {}) {
  const allPass = { status: STATUS.PASS };
  return {
    repoRoot: REPO_ROOT,
    release: { releaseId: 'rel-2b-test', sourceSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40), manifestDigest: 'c'.repeat(64) },
    deployment: { deploymentRunId: 'run-1', deploymentAttempt: 1, status: 'PASS', receiptDigest: 'd'.repeat(64), functionsDeployed: ['scan-identify'], migrationsApplied: [] },
    exactCandidateVerification: { result: RESULT.PASS, components: [], limitations: [] },
    health: { live: allPass, ready: allPass, version: allPass },
    smoke: { smoke_auth: allPass, smoke_database_rls_rpc: allPass },
    certification: { blocking_findings: ['leaked_password_protection'], operational_failures: [], report_only_findings: [], final_verdict: 'BLOCKED' },
    controls: { freeze_valid: allPass, candidate_binding: allPass },
    productionEligibility: { productionPromotionEligible: false, blockers: [{ code: 'LAST_KNOWN_GOOD_UNKNOWN' }, { code: 'PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED' }] },
    ...overrides,
  };
}

test('leaked-password protection does NOT make STAGING_VERIFIED unreachable', () => {
  const evidence = buildReleaseEvidence(evidenceInputs());
  assert.equal(evidence.stagingVerifiedEligible, true, JSON.stringify(evidence.blockers));
  assert.equal(canEnterStagingVerified(evidence).allowed, true);
  assert.ok(evidence.environmentExternalActions.some((a) => a.id === 'leaked_password_protection'));
  // ...while the raw certification verdict it consumed remains BLOCKED.
  assert.equal(evidence.certification.rawVerdict, 'BLOCKED');
});

test('STAGING_VERIFIED does not imply production eligibility', () => {
  const evidence = buildReleaseEvidence(evidenceInputs());
  assert.equal(evidence.stagingVerifiedEligible, true);
  assert.equal(evidence.productionPromotionEligible, false);
  assert.ok(evidence.productionBlockers.includes('PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED'));
});

test('an unclassified certification blocker blocks STAGING_VERIFIED', () => {
  const evidence = buildReleaseEvidence(evidenceInputs({
    certification: { blocking_findings: ['mystery_finding'], operational_failures: [], report_only_findings: [], final_verdict: 'BLOCKED' },
  }));
  assert.equal(evidence.stagingVerifiedEligible, false);
  assert.equal(canEnterStagingVerified(evidence).allowed, false);
});

test('a required control failure blocks STAGING_VERIFIED', () => {
  const evidence = buildReleaseEvidence(evidenceInputs({
    smoke: { smoke_auth: { status: STATUS.BLOCKED, detail: 'auth smoke failed' }, smoke_database_rls_rpc: { status: STATUS.PASS } },
  }));
  assert.equal(evidence.stagingVerifiedEligible, false);
  assert.ok(evidence.blockers.some((b) => b.id === 'smoke_auth'));
});

test('a required control reporting NOT_APPLICABLE cannot waive itself', () => {
  const evidence = buildReleaseEvidence(evidenceInputs({
    smoke: { smoke_auth: { status: STATUS.NOT_APPLICABLE }, smoke_database_rls_rpc: { status: STATUS.PASS } },
  }));
  assert.equal(evidence.stagingVerifiedEligible, false);
});

test('an operational failure in a required control blocks STAGING_VERIFIED', () => {
  const evidence = buildReleaseEvidence(evidenceInputs({
    health: { live: { status: STATUS.PASS }, ready: { status: STATUS.OPERATIONAL_FAILURE, detail: 'probe failed' }, version: { status: STATUS.PASS } },
  }));
  assert.equal(evidence.releaseCandidateVerdict, STATUS.OPERATIONAL_FAILURE);
  assert.equal(evidence.stagingVerifiedEligible, false);
});

test('an attestation gap blocks STAGING_VERIFIED rather than silently passing', () => {
  const evidence = buildReleaseEvidence(evidenceInputs({
    exactCandidateVerification: { result: RESULT.FULL_RUNTIME_ATTESTATION_GAP, components: [], limitations: [] },
  }));
  assert.equal(evidence.stagingVerifiedEligible, false);
  assert.ok(evidence.operationalFailures.some((f) => f.id === 'exact_candidate_verification'));
});

test('release evidence carries no credential-shaped values', () => {
  assert.deepEqual(findEmbeddedSecrets(buildReleaseEvidence(evidenceInputs()), 'evidence'), []);
});

test('there is exactly one authoritative release verdict', () => {
  const evidence = buildReleaseEvidence(evidenceInputs());
  assert.ok('releaseCandidateVerdict' in evidence);
  // Certification appears only as a consumed input, never as a rival verdict.
  assert.ok('rawVerdict' in evidence.certification);
  assert.equal(evidence.certification.available, true);
});

// ── smoke orchestration ──────────────────────────────────────────────────────

test('release smoke refuses production by construction', () => {
  assert.throws(
    () => runReleaseSmoke({ repoRoot: REPO_ROOT, projectRef: PRODUCTION_REF, stagingUrl: 'https://x', exec: () => ({ status: 0, output: '' }) }),
    { code: 'ENVIRONMENT_MISMATCH' },
  );
});

test('a failing required smoke category is BLOCKED, and an unsupported optional one is NOT_APPLICABLE', () => {
  const failing = runReleaseSmoke({
    repoRoot: REPO_ROOT, projectRef: STAGING_REF, stagingUrl: 'https://x',
    syntheticAvailable: false,
    exec: () => ({ status: 1, output: 'contract failures' }),
  });
  assert.equal(failing.categories.smoke_database_rls_rpc.status, 'BLOCKED');
  // Optional synthetic categories degrade honestly rather than faking a pass.
  assert.equal(failing.categories.smoke_scanner.status, 'NOT_APPLICABLE');
  assert.ok(failing.categories.smoke_scanner.detail.includes('synthetic staging credentials'));
  assert.ok(failing.requiredFailures.includes('smoke_database_rls_rpc'));
});

test('a required smoke category never silently degrades to NOT_APPLICABLE', () => {
  const result = runReleaseSmoke({
    repoRoot: REPO_ROOT, projectRef: STAGING_REF, stagingUrl: 'https://x',
    syntheticAvailable: false,
    exec: () => ({ status: 0, output: '' }),
  });
  // smoke_auth is required and synthetic-backed; without credentials it must
  // report OPERATIONAL_FAILURE, not NOT_APPLICABLE.
  assert.equal(result.categories.smoke_auth.status, 'OPERATIONAL_FAILURE');
  assert.ok(CATEGORIES.find((c) => c.id === 'smoke_auth').required);
});

test('release smoke records what it does not cover', () => {
  const result = runReleaseSmoke({
    repoRoot: REPO_ROOT, projectRef: STAGING_REF, stagingUrl: 'https://x',
    exec: () => ({ status: 0, output: '' }),
  });
  assert.ok(result.exclusions.some((e) => /account deletion/i.test(e)));
});

test('every required smoke category appears in the policy required-control list', () => {
  const required = CATEGORIES.filter((c) => c.required).map((c) => c.id);
  for (const id of required) {
    assert.ok(policy.requiredReleaseControls.includes(id), `${id} must be a required release control`);
  }
});
