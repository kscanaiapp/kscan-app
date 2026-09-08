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

/**
 * RP-06A.1 — the two governed backend authority roles.
 *
 * These tests were written when every checkout in the repository was a mobile
 * integration line, so they asserted the non-authoritative contract
 * unconditionally. `rebuild/backend-authority-v2` is deliberately the other
 * role, and a test that demands it fail merely for being authoritative is
 * measuring the wrong thing.
 *
 * The contract is now graded by the role the checkout DECLARES, read from
 * config/backend-authority.json rather than inferred from a branch name (the
 * deploy guard reads that same field, so the tests and the guard cannot
 * disagree). Neither role is skipped and neither passes vacuously: an unknown
 * role fails closed, and each role must satisfy its own positive invariants.
 */
const GOVERNED_ROLES = ['integration-convergence-non-authoritative', 'backend-deployment-authority'];
const AUTHORITY_IS_DEPLOYMENT_ROLE = AUTHORITY.role === 'backend-deployment-authority';

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

test('canonical-branch resolvability is graded by the checkout ROLE, not universally', () => {
  // RP-06A.1. This assertion used to hardcode "this tree is non-authoritative",
  // which was true of every checkout that existed when it was written. It is
  // false on rebuild/backend-authority-v2, which is deliberately authoritative.
  // The invariant it was actually protecting is role-dependent, so it is now
  // graded per role rather than relaxed for the new one:
  //
  //   non-authoritative -> an unresolvable canonical branch is a repository
  //     condition the checkout cannot fix, so it must stay a WARNING and name
  //     the owner action. (The original regression: raising it to ERROR turned
  //     a pre-existing condition into a red build on every fresh clone.)
  //   authoritative     -> the checkout IS the deployment authority, so the
  //     branch it names must genuinely resolve. Unresolvable is fatal here,
  //     and the verifier must say so rather than warn.
  const { findings, info } = verify();

  if (!AUTHORITY_IS_DEPLOYMENT_ROLE) {
    assert.equal(info.declaresDeploymentAuthority, false, 'non-authoritative role must not claim authority');
    for (const code of ['CANONICAL_BRANCH_UNRESOLVABLE', 'CANONICAL_BRANCH_LOCAL_ONLY']) {
      const finding = findings.find((f) => f.code === code);
      if (finding) {
        assert.equal(finding.severity, 'warning', `${code} must not block a non-authoritative tree`);
        assert.match(finding.message, /owner action/, 'it must name the owner action');
      }
    }
    return;
  }

  // Authoritative checkout: the declared authority must be real and reachable.
  assert.equal(info.declaresDeploymentAuthority, true, 'authority role must declare authority');
  assert.ok(info.canonicalBranchRemoteSha, 'an authoritative checkout must publish its canonical branch');
  assert.match(info.canonicalBranchRemoteSha, /^[0-9a-f]{40}$/);
  assert.equal(info.headDescendsFromCanonical, true, 'HEAD must descend from the canonical authority lineage');
  assert.equal(
    findings.find((f) => f.code === 'AUTHORITY_REF_UNVERIFIABLE'),
    undefined,
    'an authoritative checkout must never be left unverifiable',
  );
  assert.equal(
    findings.find((f) => f.code === 'AUTHORITY_REF_MISMATCH'),
    undefined,
    'an authoritative checkout must be on its own canonical lineage',
  );
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

test('the declared authority role is one of the two governed roles, and nothing else', () => {
  // Fail closed on an unknown or malformed role. Neither branch of the
  // role-aware contract below may be reached by a typo, and a third role
  // cannot be introduced without a deliberate decision here.
  assert.ok(
    GOVERNED_ROLES.includes(AUTHORITY.role),
    `unknown backend authority role ${JSON.stringify(AUTHORITY.role)} -- ` +
      `expected one of ${GOVERNED_ROLES.join(' | ')}`,
  );
});

test('this checkout satisfies the contract for the role it declares', () => {
  // RP-06A.1. Previously this asserted `role === integration-convergence-
  // non-authoritative` unconditionally, which the canonical authority branch
  // cannot satisfy by construction. Both roles are now protected explicitly;
  // neither is skipped, and neither passes vacuously.
  const guard = read('scripts', 'deploy-edge-functions.js');

  // The deploy preflight is mandatory for BOTH roles -- it is the mechanism
  // that makes a non-authoritative tree refuse, so it must exist regardless of
  // which role this particular checkout happens to declare.
  assert.match(guard, /role !== 'backend-deployment-authority'/);
  assert.match(guard, /ABORTED {2}Nothing was deployed\./);

  if (!AUTHORITY_IS_DEPLOYMENT_ROLE) {
    // Non-authoritative: must not claim authority, and must be refused.
    assert.equal(AUTHORITY.role, 'integration-convergence-non-authoritative');
    const { info } = verify();
    assert.equal(info.declaresDeploymentAuthority, false);
    return;
  }

  // Authoritative: the claim must be backed by real, checkable lineage.
  assert.equal(AUTHORITY.role, 'backend-deployment-authority');
  assert.ok(AUTHORITY.canonicalBranch, 'an authority checkout must name its canonical branch');

  const { info, findings } = verify();
  assert.equal(info.declaresDeploymentAuthority, true);
  assert.equal(info.canonicalBranch, AUTHORITY.canonicalBranch);
  assert.ok(info.canonicalBranchRemoteSha, 'the canonical branch must resolve on origin');
  assert.equal(info.headDescendsFromCanonical, true);
  assert.equal(info.governedCount, info.sourceCount, 'governed count must match the source inventory');
  assert.equal(
    info.workingTreeClean,
    true,
    'an authority checkout must be clean: what would be deployed must be attributable to a commit',
  );
  assert.match(info.manifestDigest ?? '', /^[0-9a-f]{64}$/, 'the manifest digest must be bound');
  assert.deepEqual(
    findings.filter((f) => f.severity === 'error').map((f) => f.code),
    [],
    'an authority checkout must carry no ERROR-level authority finding',
  );
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
  // Pin the CONTENT of the script, not its exact string: CI-APPLICABILITY-001
  // added checkApplicability.test.js to the same runner, and pinning the literal
  // made a legitimate addition look like a regression.
  const testSecurity = pkg.scripts['test:security'];
  assert.match(testSecurity, /^node --test /);
  assert.match(
    testSecurity,
    /__tests__\/security\/baselineComparison\.test\.js/,
    'the baseline comparison must remain in the required runner',
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
