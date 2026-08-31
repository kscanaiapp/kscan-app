// GOV-KPLUS-001 — the backend deployment authority must be verifiable, and
// REG-KPLUS-002 — the security baseline comparison must actually run and block.
//
// GOV-KPLUS-001: "which tree may deploy the backend" rested on one mutable JSON
// field. deploy-edge-functions.js read `role` out of config/backend-authority.json
// and proceeded on its say-so, never checking the checked-out ref; the declared
// canonicalBranch was not resolvable from a fresh clone; and governedFunctionCount
// had silently drifted to 19 against 20 governed functions.
//
// REG-KPLUS-002 was found ALREADY REPAIRED on this authority and is NOT rebuilt
// here. These tests pin that repair so it cannot silently regress, and they
// deliberately do NOT touch security/baselines/security-findings-baseline.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const {
  verify,
  governedFunctionsFromLib,
  sourceFunctionDirs,
} = require('../scripts/verify-backend-authority.js');

const AUTHORITY = JSON.parse(read('config', 'backend-authority.json'));

// ── GOV-KPLUS-001 ────────────────────────────────────────────────────────────

test('the governed count agrees with the manifest library', () => {
  const governed = governedFunctionsFromLib();
  assert.ok(governed.length > 0, 'the manifest library must declare governed functions');
  assert.equal(
    AUTHORITY.governedFunctionCount,
    governed.length,
    'config/backend-authority.json must not claim a different governed count',
  );
});

test('governed functions and source directories agree in BOTH directions', () => {
  const governed = new Set(governedFunctionsFromLib());
  const sources = new Set(sourceFunctionDirs());
  const missing = [...governed].filter((n) => !sources.has(n));
  const unexpected = [...sources].filter((n) => !governed.has(n));
  assert.deepEqual(missing, [], 'governed but absent from source');
  assert.deepEqual(unexpected, [], 'present in source but ungoverned (no manifest digest)');
});

test('the verifier reports no ERROR-level discrepancy on this checkout', () => {
  // Environment-independent on purpose. Whether the canonical branch resolves
  // depends on WHERE this runs -- it exists as a local ref in some checkouts and
  // nowhere in a fresh CI clone -- and that is a repository-level owner action,
  // not something this tree can fix. It is therefore a WARNING, and this test
  // asserts the things that must hold in EVERY environment.
  const result = verify();
  const errors = result.findings.filter((f) => f.severity === 'error');
  assert.deepEqual(
    errors.map((e) => e.code),
    [],
    `unexpected authority errors: ${JSON.stringify(errors)}`,
  );
});

test('an unpublished canonical branch never blocks a NON-authoritative checkout', () => {
  // Regression guard for a bug this repair's own CI run caught: the unresolvable
  // branch was first raised as an ERROR, which turned a pre-existing repository
  // condition into a red build on every fresh clone.
  const { findings, info } = verify();
  assert.equal(info.declaresDeploymentAuthority, false, 'this tree is non-authoritative');
  for (const code of ['CANONICAL_BRANCH_UNRESOLVABLE', 'CANONICAL_BRANCH_LOCAL_ONLY']) {
    const finding = findings.find((f) => f.code === code);
    if (finding) {
      assert.equal(finding.severity, 'warning', `${code} must not block a non-authoritative tree`);
      assert.match(finding.message, /owner action/, 'it must name the owner action');
    }
  }
});

test('the verifier binds its answer to a git SHA and the manifest digest', () => {
  const { info } = verify();
  assert.match(info.headSha ?? '', /^[0-9a-f]{40}$/, 'HEAD must be a resolved SHA');
  assert.match(info.manifestDigest ?? '', /^[0-9a-f]{64}$/, 'manifest digest must be computed');
  assert.equal(typeof info.governedCount, 'number');
  assert.equal(typeof info.sourceCount, 'number');
});

test('an unresolvable canonical branch is SURFACED, not hidden', () => {
  // The declared branch currently exists only as a local ref, so a fresh clone
  // cannot verify the deployment authority at all. The verifier must say so.
  const { findings, info } = verify();
  assert.ok(info.canonicalBranch, 'a canonicalBranch must be declared');
  const resolvable = Boolean(info.canonicalBranchRemoteSha || info.canonicalBranchLocalSha);
  if (!info.canonicalBranchRemoteSha) {
    const codes = findings.map((f) => f.code);
    assert.ok(
      codes.includes('CANONICAL_BRANCH_LOCAL_ONLY') || codes.includes('CANONICAL_BRANCH_UNRESOLVABLE'),
      'a canonical branch that origin cannot resolve must produce a finding',
    );
  }
  assert.ok(resolvable || findings.some((f) => f.code === 'CANONICAL_BRANCH_UNRESOLVABLE'));
});

test('this integration checkout is still explicitly NON-authoritative', () => {
  // Preserved negative: the Build 34 convergence tree must never be treated as
  // the backend deployment authority.
  assert.notEqual(AUTHORITY.role, 'backend-deployment-authority');
  assert.equal(AUTHORITY.role, 'integration-convergence-non-authoritative');
  const guard = read('scripts', 'deploy-edge-functions.js');
  assert.match(guard, /role !== 'backend-deployment-authority'/);
  assert.match(guard, /ABORTED {2}Nothing was deployed\./);
});

test('the approved project ref is staging, never production', () => {
  assert.equal(AUTHORITY.approvedProjectRef, 'yzqjvdfgefveprobvvyw');
  assert.notEqual(AUTHORITY.approvedProjectRef, 'wyyuqfdxucjksghsmhry');
});

// ── REG-KPLUS-002 (preserved, not rebuilt) ───────────────────────────────────

const BASELINE_PATH = path.join(ROOT, 'security', 'baselines', 'security-findings-baseline.json');
const BASELINE = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

test('the ACCEPTED security baseline resolves and is not re-bootstrapped', () => {
  assert.equal(BASELINE.version, '2026-08-03-ci-bootstrap');
  assert.ok(Array.isArray(BASELINE.findings) && BASELINE.findings.length > 0);
  assert.equal(
    BASELINE.findings.length,
    153,
    'the accepted baseline must not be regenerated from current findings',
  );
});

test('baseline policy blocks new secrets and new critical/high, and fails closed', () => {
  assert.equal(BASELINE.policy.blockingNewSecret, true);
  assert.equal(BASELINE.policy.blockingNewCriticalHighRuntime, true);
  assert.equal(BASELINE.policy.blockScannerFailure, true, 'a scanner failure must fail closed');
  assert.equal(BASELINE.policy.blockMalformedReport, true, 'a corrupt artifact must fail closed');
  assert.equal(BASELINE.policy.reportExistingBaseline, true, 'accepted findings stay visible');
});

test('the baseline comparison actually RUNS in a required CI job', () => {
  // The audit's finding was that no job produced a 'Security baseline comparison'
  // check-run, so requiring that name could never block. It was closed by running
  // the real test inside 'Project checks', which IS required.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(
    pkg.scripts['test:security'],
    'node --test __tests__/security/baselineComparison.test.js',
  );
  const workflow = read('.github', 'workflows', 'security-code.yml');
  assert.match(workflow, /run: npm run test:security/, 'CI must invoke the comparison');
  assert.ok(
    fs.existsSync(path.join(ROOT, '__tests__', 'security', 'baselineComparison.test.js')),
    'the comparison test must exist',
  );
});

test('the promotion gate does not require a check name nothing produces', () => {
  const gate = read('security', 'scripts', 'evaluate-promotion-gate.js');
  // 'Security baseline comparison' must be in DROPPED_CHECKS, not in the
  // required set — requiring an unproduced name is an unblockable gate.
  const dropped = gate.slice(gate.indexOf('const DROPPED_CHECKS'));
  assert.match(dropped, /'Security baseline comparison'/);
});
