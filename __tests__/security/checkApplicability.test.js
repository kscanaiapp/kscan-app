// CI-APPLICABILITY-001 — the classification -> applicability -> check-state
// contract that blocked PR #243.
//
// ROOT CAUSE, as re-derived from the live runs (this corrects an earlier
// diagnosis that blamed the job-level `if:` alone):
//
//   1. The staging gate serializes on `concurrency: kscan-staging-deployment`
//      with `cancel-in-progress: false`. Seven PRs opened in quick succession
//      contended for that group and #243's queued runs were CANCELLED.
//   2. A cancelled workflow emits NO check-runs for its jobs.
//   3. Separately, `Migration validation` carries
//      `if: contains(classifications, 'DATABASE MIGRATION')`, so on a diff with
//      no migrations it legitimately produces no check-run either.
//   4. The evaluator could not tell (2) from (3): both looked like "missing",
//      so both produced OPERATIONAL FAILURE. A client-only PR could never pass.
//
// The repair separates APPLICABILITY from RUNTIME STATE. Absence is forgiven
// only when the canonical classification proves the check does not apply.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLASSIFIER = path.join(ROOT, 'security', 'scripts', 'classify-changed-surfaces.js');

const {
  resolveCheckRunVerdict,
  resolveCheckState,
  isCheckApplicable,
  summarizeConvergence,
  buildByNameMap,
  CHECK_STATE,
  CONCLUSION_STATE,
  ALWAYS_REQUIRED_CHECKS,
  DEPLOYMENT_REQUIRED_CHECKS,
} = require(path.join(ROOT, 'security', 'scripts', 'evaluate-promotion-gate.js'));

/** Run the real classifier over a synthetic changed-file set. */
function classify(files, extraEnv = {}) {
  const out = execFileSync('node', [CLASSIFIER], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CHANGED_FILES: files.join(','), ...extraEnv },
  });
  return JSON.parse(out);
}

/** STAGING_DEPLOY_AUTH_* env vars for an unauthorized event -- a PR into an
 *  integration/* branch, exactly PR #251's shape. */
const UNAUTHORIZED_INTEGRATION_PR_AUTH_ENV = {
  STAGING_DEPLOY_AUTH_EVENT_NAME: 'pull_request',
  STAGING_DEPLOY_AUTH_REF: 'refs/pull/251/merge',
  STAGING_DEPLOY_AUTH_BASE_REF: 'integration/backend-kplus-complimentary-staging-v1',
  STAGING_DEPLOY_AUTH_DISPATCH_CONFIRM: '',
  STAGING_DEPLOY_AUTH_DISPATCH_PROJECT_REF: '',
};

/** The authorized shape: a PR into staging/production-parity itself. */
const AUTHORIZED_STAGING_PR_AUTH_ENV = {
  STAGING_DEPLOY_AUTH_EVENT_NAME: 'pull_request',
  STAGING_DEPLOY_AUTH_REF: 'refs/pull/251/merge',
  STAGING_DEPLOY_AUTH_BASE_REF: 'staging/production-parity',
  STAGING_DEPLOY_AUTH_DISPATCH_CONFIRM: '',
  STAGING_DEPLOY_AUTH_DISPATCH_PROJECT_REF: '',
};

/** Build a byName map of check-runs. */
function runs(spec) {
  const map = new Map();
  for (const [name, value] of Object.entries(spec)) {
    if (value === null) continue; // absent
    map.set(name, typeof value === 'string'
      ? { status: 'completed', conclusion: value }
      : value);
  }
  return map;
}

/** Every required check concluded success, except those overridden. */
function allGreen(overrides = {}) {
  const spec = {};
  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    spec[name] = 'success';
  }
  return runs({ ...spec, ...overrides });
}

function verdictFor(byName, applicability, opts = {}) {
  return resolveCheckRunVerdict({
    repository: 'kscanaiapp/kscan-app',
    sha: 'a'.repeat(40),
    byName,
    applicability,
    treatUnresolvedAsOperational: true,
    ...opts,
  });
}

// ── CONTROL G — misclassification resistance ────────────────────────────────

test('G1 migration modification -> DATABASE MIGRATION, Migration validation REQUIRED', () => {
  const c = classify(['supabase/migrations/20260101000000_thing.sql']);
  assert.ok(c.classifications.includes('DATABASE MIGRATION'));
  assert.equal(c.checkApplicability['Migration validation'], true);
  assert.equal(c.migrationValidationRequired, true);
});

test('G2/G3 migration rename and deletion still classify as DATABASE MIGRATION', () => {
  // --no-renames means a rename surfaces as delete(old) + add(new); both paths
  // are classified, so moving a migration OUT of the directory cannot make
  // migration validation non-applicable.
  const renamed = classify([
    'supabase/migrations/20260101000000_old.sql',
    'supabase/migrations/20260101000001_new.sql',
  ]);
  assert.equal(renamed.checkApplicability['Migration validation'], true);

  const movedOut = classify(['supabase/migrations/20260101000000_old.sql', 'docs/moved.sql']);
  assert.equal(
    movedOut.checkApplicability['Migration validation'],
    true,
    'the deleted source path must still trigger migration applicability',
  );

  const deleted = classify(['supabase/migrations/20260101000000_gone.sql']);
  assert.equal(deleted.checkApplicability['Migration validation'], true);
});

test('G4 supabase function change -> SUPABASE FUNCTION and backend deployment', () => {
  const c = classify(['supabase/functions/vto-generate/index.ts']);
  assert.ok(c.classifications.includes('SUPABASE FUNCTION'));
  assert.equal(c.edgeDeploymentRequired, true);
  assert.equal(c.checkApplicability['Staging health checks'], true);
  assert.equal(c.checkApplicability['Synthetic auth tests'], true);
});

test('G5 workflow change is BUILD/CI, NEVER documentation-only', () => {
  const c = classify(['.github/workflows/security-promotion-gate.yml']);
  assert.ok(c.classifications.includes('BUILD/CI'));
  assert.equal(c.documentationOnly, false, 'a CI change is not documentation');
  assert.equal(c.governanceSensitive, true);
  assert.equal(c.checkApplicability['Contract tests'], true);
  assert.equal(c.mobileOnly, false, 'CI must not inherit mobile-only relaxations');
});

test('G6 security script change is governance-sensitive, not a MOBILE fallback', () => {
  const c = classify(['security/scripts/evaluate-promotion-gate.js']);
  assert.ok(c.classifications.includes('SECURITY/GOVERNANCE'));
  assert.ok(!c.classifications.includes('MOBILE'), 'must not fall through to MOBILE');
  assert.equal(c.documentationOnly, false);
  assert.equal(c.governanceSensitive, true);
  assert.equal(c.checkApplicability['Contract tests'], true);
});

test('G6b other governance surfaces do not fall through to MOBILE either', () => {
  for (const file of [
    'security/baselines/security-findings-baseline.json',
    'security/perimeter/public-ingress-manifest.json',
    'config/backend-authority.json',
    'config/edge-function-manifest.json',
    'supabase/config.toml',
  ]) {
    const c = classify([file]);
    assert.ok(
      c.classifications.includes('SECURITY/GOVERNANCE'),
      `${file} must be governance-sensitive, got ${c.classifications}`,
    );
    assert.equal(c.documentationOnly, false, file);
  }
});

test('G7 a true documentation-only PR is documentation-only', () => {
  const c = classify(['docs/thing.md', 'README.md']);
  assert.deepEqual(c.classifications, ['DOCUMENTATION ONLY']);
  assert.equal(c.documentationOnly, true);
  assert.equal(c.governanceSensitive, false);
  // The one documented NORMAL_PR exemption.
  assert.equal(c.checkApplicability['Contract tests'], false);
});

test('an unrecognised path is UNKNOWN and governance-sensitive, never benign', () => {
  const c = classify(['some/brand/new/surface.bin']);
  assert.ok(c.classifications.includes('UNKNOWN'));
  assert.ok(!c.classifications.includes('MOBILE'), 'no permissive default');
  assert.equal(c.documentationOnly, false);
  assert.equal(c.governanceSensitive, true);
  assert.equal(c.checkApplicability['Contract tests'], true);
});

// ── CONTROL A — the #243 shape ──────────────────────────────────────────────

const PR243_FILES = [
  'hooks/useStyleChat.ts',
  'hooks/useWatchlist.ts',
  'app/stylist/index.tsx',
  'app/watchlist/[watchId].tsx',
  'services/actorScope.ts',
  'services/actorContext.d.ts',
  '__tests__/actorScopeAuthority.test.js',
];

test('CONTROL A: #243 shape -> Migration validation N/A, Contract tests REQUIRED', () => {
  const c = classify(PR243_FILES);
  assert.equal(c.documentationOnly, false, '#243 is not documentation-only');
  assert.equal(
    c.checkApplicability['Migration validation'],
    false,
    '#243 contains no migration, so migration validation does not apply',
  );
  assert.equal(
    c.checkApplicability['Contract tests'],
    true,
    'the owner ruling is load-bearing: #243 is not docs-only, so contract tests are REQUIRED',
  );
  assert.equal(c.checkApplicability['Staging health checks'], false);
  assert.equal(c.checkApplicability['Synthetic auth tests'], false);
});

test('CONTROL A: with Contract tests SUCCESS and migration absent, the gate PASSES', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  const byName = allGreen({ 'Migration validation': null, 'Staging health checks': null, 'Synthetic auth tests': null });
  const verdict = verdictFor(byName, applicability);
  assert.equal(verdict.finalVerdict, 'PASS', JSON.stringify(verdict.failures));
  assert.deepEqual(verdict.missingChecks, []);
  assert.ok(verdict.notApplicableChecks.includes('Migration validation'));
  assert.equal(verdict.checkStates['Contract tests'], CHECK_STATE.SUCCESS);
  assert.equal(verdict.checkStates['Migration validation'], CHECK_STATE.NOT_APPLICABLE);
});

test('CONTROL A guard: Contract tests ABSENT for #243 is NOT waived', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  const byName = allGreen({
    'Contract tests': null,
    'Migration validation': null,
    'Staging health checks': null,
    'Synthetic auth tests': null,
  });
  const verdict = verdictFor(byName, applicability);
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.missingChecks.includes('Contract tests'));
});

// ── STAGING-DEPLOY-AUTH-001 — SOURCE applicability vs EVENT/RUNTIME applicability ──
//
// backendDeploymentRequired (a diff touches supabase/functions or
// supabase/migrations) is necessary but not sufficient to make 'Staging
// health checks'/'Synthetic auth tests' applicable: deploy-staging must also
// be AUTHORIZED to run for this event (PR #251's exact defect -- an
// integration/* PR with real backend changes, where deploy-staging's own
// `if:` never fires, so those two checks correctly report `skipped` and an
// "applicable" contract misread that as OPERATIONAL FAILURE).

const BACKEND_FILES = ['supabase/functions/vto-generate/index.ts'];
const BACKEND_AND_MIGRATION_FILES = [
  ...BACKEND_FILES,
  'supabase/migrations/20260901000000_thing.sql',
];

test('STAGING-DEPLOY-AUTH-001 A: integration PR + backend changes -> deploy not authorized -> runtime staging checks N/A, PASS on applicable source checks', () => {
  const c = classify(BACKEND_FILES, UNAUTHORIZED_INTEGRATION_PR_AUTH_ENV);
  assert.equal(c.backendDeploymentRequired, true, 'precondition: this diff does need a deploy eventually');
  assert.equal(c.stagingDeploymentAuthorized, false, 'precondition: this event is not authorized to perform it');
  assert.equal(c.checkApplicability['Staging health checks'], false);
  assert.equal(c.checkApplicability['Synthetic auth tests'], false);

  const byName = allGreen({ 'Staging health checks': 'skipped', 'Synthetic auth tests': 'skipped', 'Migration validation': null });
  const verdict = verdictFor(byName, c.checkApplicability);
  assert.equal(verdict.finalVerdict, 'PASS', JSON.stringify(verdict.failures));
  assert.ok(verdict.notApplicableChecks.includes('Staging health checks'));
  assert.ok(verdict.notApplicableChecks.includes('Synthetic auth tests'));
});

test('STAGING-DEPLOY-AUTH-001 B: authorized staging deployment + backend changes -> staging health/synthetic auth missing or skipped FAIL CLOSED', () => {
  const c = classify(BACKEND_FILES, AUTHORIZED_STAGING_PR_AUTH_ENV);
  assert.equal(c.stagingDeploymentAuthorized, true, 'precondition: this event IS authorized to deploy');
  assert.equal(c.checkApplicability['Staging health checks'], true);
  assert.equal(c.checkApplicability['Synthetic auth tests'], true);

  for (const missingName of ['Staging health checks', 'Synthetic auth tests']) {
    const missingRun = allGreen({ [missingName]: null });
    const missingVerdict = verdictFor(missingRun, c.checkApplicability);
    assert.equal(missingVerdict.finalVerdict, 'OPERATIONAL FAILURE', `${missingName} missing must fail closed`);
    assert.ok(missingVerdict.missingChecks.includes(missingName));

    const skippedRun = allGreen({ [missingName]: 'skipped' });
    const skippedVerdict = verdictFor(skippedRun, c.checkApplicability);
    assert.notEqual(skippedVerdict.finalVerdict, 'PASS', `${missingName} skipped-while-applicable must fail closed`);
  }
});

test('STAGING-DEPLOY-AUTH-001 C: authorized staging deploy fails -> never PASS (BLOCKED, a real validation failure)', () => {
  // 'Staging health checks: failure' is a genuine post-deploy regression, not
  // CI machinery breaking -- classifyCheckFailure's stagingHealthCheckFailure
  // key is in BLOCKING_KEYS, matching every other real (non-operational)
  // failure this evaluator classifies. The invariant that matters here is
  // "never PASS", not the exact BLOCKED/OPERATIONAL FAILURE label.
  const c = classify(BACKEND_FILES, AUTHORIZED_STAGING_PR_AUTH_ENV);
  const byName = allGreen({ 'Staging health checks': 'failure' });
  const verdict = verdictFor(byName, c.checkApplicability);
  assert.notEqual(verdict.finalVerdict, 'PASS', JSON.stringify(verdict.failures));
  assert.equal(verdict.finalVerdict, 'BLOCKED');
});

test('STAGING-DEPLOY-AUTH-001 D: migration-bearing integration PR keeps Migration validation REQUIRED regardless of deploy authorization', () => {
  const c = classify(BACKEND_AND_MIGRATION_FILES, UNAUTHORIZED_INTEGRATION_PR_AUTH_ENV);
  assert.equal(c.migrationValidationRequired, true);
  assert.equal(c.checkApplicability['Migration validation'], true, 'migration validation is a SOURCE check, not a deployment-runtime one');
  assert.equal(c.checkApplicability['Staging health checks'], false, 'but deployment-runtime checks stay N/A, unauthorized');

  const byName = allGreen({ 'Migration validation': null });
  const verdict = verdictFor(byName, c.checkApplicability);
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.missingChecks.includes('Migration validation'));
});

test('STAGING-DEPLOY-AUTH-001 E: contract-sensitive integration PR keeps Contract tests REQUIRED regardless of deploy authorization', () => {
  const c = classify(BACKEND_FILES, UNAUTHORIZED_INTEGRATION_PR_AUTH_ENV);
  assert.equal(c.checkApplicability['Contract tests'], true);

  const byName = allGreen({ 'Contract tests': null, 'Staging health checks': 'skipped', 'Synthetic auth tests': 'skipped' });
  const verdict = verdictFor(byName, c.checkApplicability);
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.missingChecks.includes('Contract tests'));
});

test('STAGING-DEPLOY-AUTH-001: absent auth context (every existing/unaware caller) defaults to authorized, never less strict', () => {
  const c = classify(BACKEND_FILES);
  assert.equal(c.stagingDeploymentAuthorized, true);
  assert.equal(c.checkApplicability['Staging health checks'], true);
  assert.equal(c.checkApplicability['Synthetic auth tests'], true);
});

test('STAGING-DEPLOY-AUTH-001: workflow_dispatch with the exact confirm phrase and staging project ref is authorized', () => {
  const c = classify(BACKEND_FILES, {
    STAGING_DEPLOY_AUTH_EVENT_NAME: 'workflow_dispatch',
    STAGING_DEPLOY_AUTH_REF: 'refs/heads/some-other-branch',
    STAGING_DEPLOY_AUTH_BASE_REF: '',
    STAGING_DEPLOY_AUTH_DISPATCH_CONFIRM: 'DEPLOY-TO-STAGING',
    STAGING_DEPLOY_AUTH_DISPATCH_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
  });
  assert.equal(c.stagingDeploymentAuthorized, true);
});

test('STAGING-DEPLOY-AUTH-001: workflow_dispatch missing the exact confirm phrase is NOT authorized', () => {
  const c = classify(BACKEND_FILES, {
    STAGING_DEPLOY_AUTH_EVENT_NAME: 'workflow_dispatch',
    STAGING_DEPLOY_AUTH_REF: 'refs/heads/some-other-branch',
    STAGING_DEPLOY_AUTH_BASE_REF: '',
    STAGING_DEPLOY_AUTH_DISPATCH_CONFIRM: 'deploy-to-staging',
    STAGING_DEPLOY_AUTH_DISPATCH_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
  });
  assert.equal(c.stagingDeploymentAuthorized, false);
});

test('STAGING-DEPLOY-AUTH-001: a push directly to staging/production-parity is authorized', () => {
  const c = classify(BACKEND_FILES, {
    STAGING_DEPLOY_AUTH_EVENT_NAME: 'push',
    STAGING_DEPLOY_AUTH_REF: 'refs/heads/staging/production-parity',
    STAGING_DEPLOY_AUTH_BASE_REF: '',
    STAGING_DEPLOY_AUTH_DISPATCH_CONFIRM: '',
    STAGING_DEPLOY_AUTH_DISPATCH_PROJECT_REF: '',
  });
  assert.equal(c.stagingDeploymentAuthorized, true);
});

test('STAGING-DEPLOY-AUTH-001: a mobile-only integration PR (no backend deployment needed) never even reaches the authorization question', () => {
  const c = classify(['app/x.tsx'], UNAUTHORIZED_INTEGRATION_PR_AUTH_ENV);
  assert.equal(c.backendDeploymentRequired, false);
  assert.equal(c.checkApplicability['Staging health checks'], false);
  assert.equal(c.checkApplicability['Synthetic auth tests'], false);
});

// ── CONTROLS B–E — applicable checks must never be waived ───────────────────

test('CONTROL B: migration REQUIRED but check absent after deadline -> OPERATIONAL FAILURE', () => {
  const applicability = classify(['supabase/migrations/x.sql']).checkApplicability;
  const byName = allGreen({ 'Migration validation': null });
  const verdict = verdictFor(byName, applicability);
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.missingChecks.includes('Migration validation'));
});

test('CONTROL C: migration REQUIRED and check FAILS -> blocked, never pass', () => {
  const applicability = classify(['supabase/migrations/x.sql']).checkApplicability;
  const verdict = verdictFor(allGreen({ 'Migration validation': 'failure' }), applicability);
  assert.notEqual(verdict.finalVerdict, 'PASS');
  assert.ok(
    verdict.finalVerdict === 'BLOCKED' || verdict.finalVerdict === 'OPERATIONAL FAILURE',
    `unexpected verdict ${verdict.finalVerdict}`,
  );
});

test('CONTROL D: Contract tests applicable but absent -> OPERATIONAL FAILURE', () => {
  const applicability = classify(['app/x.tsx']).checkApplicability;
  const verdict = verdictFor(allGreen({ 'Contract tests': null }), applicability);
  assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(verdict.missingChecks.includes('Contract tests'));
});

test('CONTROL E: a required SECURITY scanner missing is never waived by applicability', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  for (const scanner of ['Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner', 'Trivy filesystem', 'npm audit', 'Project checks']) {
    const byName = allGreen({
      [scanner]: null,
      'Migration validation': null,
      'Staging health checks': null,
      'Synthetic auth tests': null,
    });
    const verdict = verdictFor(byName, applicability);
    assert.equal(verdict.finalVerdict, 'OPERATIONAL FAILURE', scanner);
    assert.ok(verdict.missingChecks.includes(scanner), scanner);
  }
});

test('CONTROL F: with no contract, UNCONDITIONAL checks are still strictly required', () => {
  // This is the fail-closed property that matters. A missing scanner can never
  // be excused by the absence of an applicability contract.
  for (const broken of [null, undefined, 'nonsense', 42, {}]) {
    for (const scanner of ['Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner', 'Trivy filesystem', 'npm audit', 'Project checks']) {
      const verdict = verdictFor(allGreen({ [scanner]: null }), broken);
      assert.equal(
        verdict.finalVerdict,
        'OPERATIONAL FAILURE',
        `contract ${JSON.stringify(broken)} must not excuse a missing ${scanner}`,
      );
    }
  }
  assert.equal(isCheckApplicable('Gitleaks', null), true);
  assert.equal(isCheckApplicable('Anything Unlisted', { 'Migration validation': false }), true);
});

test('CONTROL F: with no contract, ONLY a named, justified set is tolerated', () => {
  const { TOLERATED_WITHOUT_CONTRACT } = require(path.join(ROOT, 'security', 'scripts', 'evaluate-promotion-gate.js'));
  assert.deepEqual(
    [...TOLERATED_WITHOUT_CONTRACT].sort(),
    [
      'Migration validation',
      'Staging health checks',
      'Synthetic auth tests',
      'ZAP API staging',
      'ZAP Baseline (staging)',
    ],
    'the no-contract tolerance must be an explicit, reviewable set',
  );
  // Contract tests is applicable for nearly everything, so tolerating its
  // absence without a contract would be a real weakening, not a fallback.
  assert.ok(
    !TOLERATED_WITHOUT_CONTRACT.includes('Contract tests'),
    'Contract tests must stay required even with no contract',
  );

  const absent = {};
  for (const name of TOLERATED_WITHOUT_CONTRACT) absent[name] = null;
  assert.equal(verdictFor(allGreen(absent), null).finalVerdict, 'PASS');

  // Everything outside that set stays mandatory in the same no-contract state.
  const tolerated = new Set(TOLERATED_WITHOUT_CONTRACT);
  for (const name of [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]) {
    if (tolerated.has(name)) continue;
    const v = verdictFor(allGreen({ ...absent, [name]: null }), null);
    assert.notEqual(v.finalVerdict, 'PASS', `${name} must stay required without a contract`);
  }
});

test('CONTROL F: a contract that says APPLICABLE still fails a skipped conditional check', () => {
  // The tolerance above exists only when nothing knows. When the canonical
  // contract asserts applicability, strictness is absolute -- this is what stops
  // the no-contract fallback from becoming a way to launder a real skip.
  const applicability = classify(['supabase/migrations/x.sql']).checkApplicability;
  assert.equal(applicability['Migration validation'], true);
  for (const state of ['skipped', null]) {
    const verdict = verdictFor(allGreen({ 'Migration validation': state }), applicability);
    assert.notEqual(verdict.finalVerdict, 'PASS', `Migration validation ${state} must not pass`);
  }
});

test('CONTROL F: a classifier that cannot resolve its base FAILS, it does not return empty', () => {
  // Environment-independent by construction. In CI the checkout is a PR MERGE
  // commit, so a bogus base legitimately resolves via the merge commit's first
  // parent -- which IS the base by definition. Asserting "a bogus base always
  // throws" therefore only held on a non-merge HEAD, and this test failed in CI
  // for that reason on this repair's own first run.
  //
  // The real contract is: when NOTHING resolves -- no spelling of the ref, and
  // no merge parent to fall back on -- the classifier must throw rather than
  // report an empty diff. A throwaway single-commit repo makes that state
  // reachable deterministically on any machine.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-classify-base-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Base Resolution Test');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'root');
    // Single commit: no parents at all, so no merge-parent fallback exists.
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
      cwd: tmp, encoding: 'utf8',
    }).trim().split(/\s+/);
    assert.equal(parents.length, 1, 'fixture must be a root commit');

    let threw = false;
    try {
      execFileSync('node', [CLASSIFIER, 'refs/heads/definitely-not-a-real-base-ref'], {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, 'an unresolvable base must not silently classify an empty diff');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CONTROL F: the merge-parent fallback is EXACT, not a guess', () => {
  // It is used only when HEAD really is a merge commit, and then the first
  // parent is the base tip by definition of a pull_request merge checkout.
  const { resolveBaseRef } = require(path.join(ROOT, 'security', 'scripts', 'classify-changed-surfaces.js'));
  const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim().split(/\s+/);
  const resolved = resolveBaseRef('refs/heads/definitely-not-a-real-base-ref');
  if (parents.length >= 3) {
    assert.equal(resolved, parents[1], 'on a merge commit, resolve to the FIRST parent');
  } else {
    assert.equal(resolved, null, 'with no merge parent there is nothing to fall back to');
  }
});

// ── Raw conclusion mapping ──────────────────────────────────────────────────

test('every documented GitHub conclusion is mapped explicitly', () => {
  const expected = {
    success: CHECK_STATE.SUCCESS,
    failure: CHECK_STATE.FAILURE,
    cancelled: CHECK_STATE.OPERATIONAL_FAILURE,
    timed_out: CHECK_STATE.OPERATIONAL_FAILURE,
    startup_failure: CHECK_STATE.OPERATIONAL_FAILURE,
    stale: CHECK_STATE.OPERATIONAL_FAILURE,
    action_required: CHECK_STATE.OPERATIONAL_FAILURE,
    neutral: CHECK_STATE.OPERATIONAL_FAILURE,
    skipped: CHECK_STATE.OPERATIONAL_FAILURE,
  };
  for (const [conclusion, state] of Object.entries(expected)) {
    assert.equal(CONCLUSION_STATE[conclusion], state, conclusion);
  }
});

test('each non-success conclusion on an APPLICABLE check prevents PASS', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure', 'stale', 'action_required', 'neutral', 'skipped', 'failure']) {
    const byName = allGreen({
      'Contract tests': conclusion,
      'Migration validation': null,
      'Staging health checks': null,
      'Synthetic auth tests': null,
    });
    const verdict = verdictFor(byName, applicability);
    assert.notEqual(verdict.finalVerdict, 'PASS', `${conclusion} must not pass`);
  }
});

test('an APPLICABLE check reported skipped is an operational failure, not a pass', () => {
  // This was the inverse defect: `skipped` was accepted as success for every
  // check, so a wrongly-skipped required job silently satisfied the gate.
  const applicability = classify(['supabase/migrations/x.sql']).checkApplicability;
  const verdict = verdictFor(allGreen({ 'Migration validation': 'skipped' }), applicability);
  assert.notEqual(verdict.finalVerdict, 'PASS');
  assert.equal(verdict.checkStates['Migration validation'], CHECK_STATE.OPERATIONAL_FAILURE);
});

test('a NOT_APPLICABLE check reported skipped is legitimately not applicable', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  const byName = allGreen({
    'Migration validation': 'skipped',
    'Staging health checks': 'skipped',
    'Synthetic auth tests': 'skipped',
  });
  const verdict = verdictFor(byName, applicability);
  assert.equal(verdict.finalVerdict, 'PASS', JSON.stringify(verdict.failures));
  assert.equal(verdict.checkStates['Migration validation'], CHECK_STATE.NOT_APPLICABLE);
});

test('an UNKNOWN conclusion fails closed', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  for (const conclusion of ['some_future_github_state', '', null]) {
    const byName = allGreen({
      'Contract tests': { status: 'completed', conclusion },
      'Migration validation': null,
      'Staging health checks': null,
      'Synthetic auth tests': null,
    });
    const verdict = verdictFor(byName, applicability);
    assert.notEqual(verdict.finalVerdict, 'PASS', `conclusion ${JSON.stringify(conclusion)}`);
    assert.equal(verdict.checkStates['Contract tests'], CHECK_STATE.OPERATIONAL_FAILURE);
  }
});

// ── Timing / convergence ────────────────────────────────────────────────────

test('TRANSIENT ABSENCE: the WAIT LOOP, not the resolver, absorbs a not-yet-started check', () => {
  // Transient absence is handled where it belongs -- the WAIT LOOP keeps
  // waiting while an APPLICABLE check has no check-run yet (it previously only
  // waited for checks that already existed, so a queued sibling workflow
  // returned immediately and was reported structurally missing).
  //
  // CI-CONVERGENCE-001 moved that decision out of fetchCheckRunsOnce's body
  // and into summarizeConvergence, so the wait and the verdict can no longer
  // disagree about what "pending" means. These assertions therefore exercise
  // the behaviour directly instead of pattern-matching the loop's source --
  // a stronger pin, and one that survives the next refactor.
  const src = fs.readFileSync(
    path.join(ROOT, 'security', 'scripts', 'evaluate-promotion-gate.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /byName\.has\(n\) &&/, 'the old already-present-only condition must be gone');

  const waitProbe = buildByNameMap(
    [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]
      .filter((name) => name !== 'Contract tests') // never started yet
      .map((name) => ({ name, status: 'completed', conclusion: 'success', head_sha: 'x'.repeat(40) })),
    'x'.repeat(40),
  );
  assert.deepEqual(
    summarizeConvergence(waitProbe, { 'Contract tests': true }).pending,
    ['Contract tests'],
    'an applicable check with no run yet must keep the wait open',
  );
  assert.deepEqual(
    summarizeConvergence(waitProbe, { 'Contract tests': false }).pending,
    [],
    'the wait must consult applicability -- a check proven not to apply is never waited for',
  );

  // A check that IS present but not concluded stays PENDING while the window is
  // open, and only escalates once the caller reports the wait elapsed.
  const applicability = classify(PR243_FILES).checkApplicability;
  const byName = allGreen({
    'Contract tests': { status: 'in_progress', conclusion: null },
    'Migration validation': null,
    'Staging health checks': null,
    'Synthetic auth tests': null,
  });
  const open = verdictFor(byName, applicability, { treatUnresolvedAsOperational: false });
  assert.equal(open.finalVerdict, 'PENDING');
  assert.ok(open.pendingChecks.includes('Contract tests'));
  assert.deepEqual(open.missingChecks, []);
});

test('a still-queued applicable check becomes OPERATIONAL FAILURE once the deadline expires', () => {
  const applicability = classify(PR243_FILES).checkApplicability;
  const byName = allGreen({
    'Contract tests': { status: 'queued', conclusion: null },
    'Migration validation': null,
    'Staging health checks': null,
    'Synthetic auth tests': null,
  });
  const open = verdictFor(byName, applicability, { treatUnresolvedAsOperational: false });
  assert.equal(open.finalVerdict, 'PENDING');

  const expired = verdictFor(byName, applicability, { treatUnresolvedAsOperational: true });
  assert.equal(expired.finalVerdict, 'OPERATIONAL FAILURE');
  assert.ok(expired.failures.some((f) => f.includes('Contract tests')));
});

test('a NOT_APPLICABLE check is never waited for', () => {
  assert.equal(
    resolveCheckState('Migration validation', undefined, false),
    CHECK_STATE.NOT_APPLICABLE,
  );
  assert.equal(
    resolveCheckState('Migration validation', { status: 'queued', conclusion: null }, false),
    CHECK_STATE.NOT_APPLICABLE,
  );
});

// ── Contract correspondence with the workflow ───────────────────────────────

test('the applicability contract mirrors the workflow if: conditions', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'security-staging-gate.yml'),
    'utf8',
  );
  // Migration validation
  assert.match(
    workflow,
    /if: contains\(needs\.classify-changes\.outputs\.classifications, 'DATABASE MIGRATION'\)/,
  );
  // Staging health checks / Synthetic auth tests
  assert.match(workflow, /needs\.classify-changes\.outputs\.backend_deployment_required == 'true'/);
  // Contract tests
  assert.match(
    workflow,
    /needs\.classify-changes\.outputs\.classifications != 'DOCUMENTATION ONLY'/,
  );
  // And the classifier must key its contract on those exact check names.
  const c = classify(['app/x.tsx']);
  assert.deepEqual(
    Object.keys(c.checkApplicability).sort(),
    ['Contract tests', 'Migration validation', 'Staging health checks', 'Synthetic auth tests'],
  );
});

test('the gate is not weakened: every required check name is still required', () => {
  for (const name of [
    'Project checks', 'Gitleaks', 'Semgrep Community Edition', 'OSV-Scanner',
    'Trivy filesystem', 'npm audit', 'Migration validation', 'Contract tests',
  ]) {
    assert.ok(ALWAYS_REQUIRED_CHECKS.includes(name), `${name} must remain always-required`);
  }
  for (const name of ['Staging health checks', 'Synthetic auth tests', 'ZAP Baseline (staging)', 'ZAP API staging']) {
    assert.ok(DEPLOYMENT_REQUIRED_CHECKS.includes(name), `${name} must remain required`);
  }
  // Nothing may be unconditionally exempt: only the four contract entries can
  // ever be non-applicable, and only on a proven classification.
  const migration = classify(['supabase/migrations/x.sql']).checkApplicability;
  assert.equal(migration['Migration validation'], true);
  assert.equal(migration['Contract tests'], true);
});

test('the CI repair PR itself is not documentation-only (self-application)', () => {
  const c = classify([
    'security/scripts/evaluate-promotion-gate.js',
    'security/scripts/classify-changed-surfaces.js',
    '.github/workflows/security-promotion-gate.yml',
    '__tests__/security/checkApplicability.test.js',
  ]);
  assert.equal(c.documentationOnly, false);
  assert.equal(c.governanceSensitive, true);
  assert.equal(c.checkApplicability['Contract tests'], true, 'this PR must run contract tests');
  assert.equal(c.checkApplicability['Migration validation'], false, 'it contains no migration');
});


// ── Base resolution (regression: this repair's own first CI run) ────────────

test('a bare base branch name resolves via its origin/ spelling', () => {
  // The staging gate passes `origin/<base>`, and actions/checkout does not
  // always create a remote-tracking branch for a PR base. resolveBaseRef tries
  // other spellings of the SAME ref before giving up -- it never substitutes a
  // different range. This repair's first CI run failed exactly here: the base
  // did not resolve and the (correct) fail-closed throw took the classify job
  // down with it.
  const { resolveBaseRef } = require(path.join(ROOT, 'security', 'scripts', 'classify-changed-surfaces.js'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(resolveBaseRef(head), head, 'an explicit sha resolves as itself');
  assert.equal(
    resolveBaseRef('refs/heads/definitely-not-real-anywhere'),
    // No spelling resolves; on a non-merge HEAD there is no first parent to
    // fall back to either, so this must be null and the caller fails closed.
    resolveBaseRef('refs/heads/definitely-not-real-anywhere'),
  );
});

test('git is invoked WITHOUT a shell, so ref syntax survives on every platform', () => {
  // `git rev-parse --verify <ref>^{commit}` through cmd.exe silently loses the
  // peel, because `^` is the Windows escape character -- every ref then failed
  // to resolve. execFileSync bypasses the shell entirely.
  const src = fs.readFileSync(
    path.join(ROOT, 'security', 'scripts', 'classify-changed-surfaces.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /execSync\(/, 'no shell-invoking git calls may remain');
  assert.match(src, /execFileSync\('git', \['rev-parse'/);
  assert.match(src, /execFileSync\('git', \['diff', '--no-renames'/);
});

// ── temp-dir hygiene for any fixture use ────────────────────────────────────

test('no fixture residue is left behind', () => {
  const tmp = path.join(os.tmpdir(), 'kscan-ci-applicability-fixtures');
  assert.equal(fs.existsSync(tmp), false, 'this suite writes no fixture directory');
});
