// The VTO scope guard's ENFORCEMENT MODE contract.
//
// WHY THIS FILE EXISTS. The guard's live mutation-boundary diff used to run on
// every branch in this repository, because it chose its base ref by trying a
// list of candidates and taking the first that resolved. "This checkout
// contains the VTO integration commit" is true everywhere, so a notifications
// branch was judged against the VTO manifest and failed for its own work,
// blocking CI on lanes the boundary was never about.
//
// The repair replaces discovery with declaration. That is only an improvement
// if the declaration cannot be dodged, so this file proves BOTH directions:
//
//   MODE A (general lane)   the static boundary controls still run; the two
//                           live-diff assertions report NOT APPLICABLE.
//   MODE B (VTO lane)       the live diff runs against an explicit base
//                           authority, refuses unauthorized mutations, and
//                           FAILS CLOSED when it cannot be carried out.
//
// The failure modes matter more than the happy path. A missing base ref, an
// unresolvable base ref, or a typo'd enforcement value must never read as
// success and must never quietly degrade to a skip -- "the base could not be
// resolved, so we are fine" is precisely the control this guard must not have.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD_SCRIPT = path.join(ROOT, 'scripts', 'check-vto-live-integration-scope.js');
const GUARD_TESTS = path.join(ROOT, '__tests__', 'vtoLiveIntegrationScope.test.js');
const VTO_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'vto-e2e.yml');
const PR_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'security-code.yml');

const guard = require('../scripts/check-vto-live-integration-scope.js');
const manifest = fs.readFileSync(path.join(ROOT, guard.MANIFEST), 'utf8');
const { patterns } = guard.parseAuthorizedPatterns(manifest);

const ENFORCE = guard.ENFORCE_ENV;
const BASE = guard.BASE_REF_ENV;

/** A ref that never exists, so "unresolvable" is not an accident of the checkout. */
const UNRESOLVABLE = 'refs/heads/vto-scope-guard-base-that-does-not-exist-4c1f9a';

/** Neither variable inherited from whatever shell is running the suite. */
function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env[ENFORCE];
  delete env[BASE];
  // node:test marks its own children with NODE_TEST_CONTEXT, and a child
  // runner that sees it refuses to run files ("run() is being called
  // recursively") -- which would leave the assertions below matching against
  // a warning instead of a test report.
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...overrides };
}

function runGuardCli({ env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, [GUARD_SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: cleanEnv(env),
  });
}

function unauthorizedIn(changedPaths) {
  return guard.classifyChangedPaths(changedPaths, patterns).unauthorized;
}

// ── The signal names are part of the contract ──────────────────────────────

test('the enforcement signal is exactly the two declared variables', () => {
  // The CI wiring, the guard and this file all name these. A rename that
  // reaches only some of them would leave a VTO lane unenforced and green.
  assert.equal(ENFORCE, 'KSCAN_VTO_SCOPE_ENFORCE');
  assert.equal(BASE, 'KSCAN_VTO_SCOPE_BASE_REF');
});

// ── MODE A: a general, non-VTO lane ────────────────────────────────────────

test('MODE A: with no enforcement signal the live diff is NOT APPLICABLE', () => {
  const mode = guard.resolveScopeMode({ env: {}, refExists: () => true });
  assert.equal(mode.decision, 'SKIP');
  assert.match(mode.reason, /KSCAN_VTO_SCOPE_ENFORCE is not set/);
  assert.equal(mode.baseRef, undefined, 'a skipped lane must not carry a base authority');
});

test('MODE A: an explicit OFF is also not a VTO lane', () => {
  for (const value of ['0', 'false', 'FALSE', '']) {
    const mode = guard.resolveScopeMode({ env: { [ENFORCE]: value }, refExists: () => true });
    assert.equal(mode.decision, 'SKIP', `${ENFORCE}=${JSON.stringify(value)} should not enforce`);
  }
});

test('MODE A: the CLI reports NOT APPLICABLE and exits 0 without diffing', () => {
  const result = runGuardCli();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LIVE MUTATION-BOUNDARY DIFF: NOT APPLICABLE/);
  // It must not claim the live check passed -- it did not run.
  assert.doesNotMatch(result.stdout, /PASS: every changed path/);
});

test('MODE A: the guard test file skips exactly the two live assertions and passes the rest', () => {
  // This is the blocker itself, asserted: on a lane with no enforcement
  // signal, this file used to produce 2 failures. It must now produce 0.
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', GUARD_TESTS],
    { cwd: ROOT, encoding: 'utf8', env: cleanEnv() },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /^# fail 0$/m, output);
  assert.match(output, /^# skipped 2$/m, 'exactly the two live-diff assertions skip');
  assert.match(output, /^# pass 8$/m, 'the eight static boundary controls still run');
  // Skipping is reported with its reason, never silent.
  assert.match(output, /NOT APPLICABLE/);
});

// ── MODE B: a declared VTO lane ────────────────────────────────────────────

test('MODE B: a declared lane with a resolvable base enforces against it', () => {
  const mode = guard.resolveScopeMode({
    env: { [ENFORCE]: '1', [BASE]: 'origin/integration/backend-kplus-complimentary-staging-v1' },
    refExists: (ref) => ref === 'origin/integration/backend-kplus-complimentary-staging-v1',
  });
  assert.equal(mode.decision, 'ENFORCE');
  assert.equal(mode.baseRef, 'origin/integration/backend-kplus-complimentary-staging-v1');
});

test('MODE B: `true` is accepted as the enforcement signal alongside `1`', () => {
  for (const value of ['1', 'true', 'TRUE', ' 1 ']) {
    const mode = guard.resolveScopeMode({
      env: { [ENFORCE]: value, [BASE]: 'somebase' },
      refExists: () => true,
    });
    assert.equal(mode.decision, 'ENFORCE', `${ENFORCE}=${JSON.stringify(value)} should enforce`);
  }
});

test('MODE B: an authorized VTO path passes the boundary', () => {
  assert.deepEqual(
    unauthorizedIn([
      'services/vto/vtoLiveCapability.ts',
      'components/vto/VtoLivePanel.tsx',
      'types/vtoLive.ts',
      '__tests__/vtoLiveIntegrationScope.test.js',
    ]),
    [],
  );
});

test('MODE B: an unauthorized path FAILS the boundary', () => {
  assert.deepEqual(
    unauthorizedIn(['components/account-home/PermissionsStepV1.tsx']).sort(),
    ['components/account-home/PermissionsStepV1.tsx'],
    'the repair must not have widened the boundary to let unrelated app code through',
  );
});

test('MODE B: app.json is REJECTED', () => {
  // Named on its own because it is exactly what a "just add it to the
  // manifest" repair would have authorized to make an unrelated diff pass.
  assert.deepEqual(unauthorizedIn(['app.json']), ['app.json']);
  assert.deepEqual(unauthorizedIn(['eas.json']), ['eas.json']);
});

test('MODE B: authorizing the VTO workflow did not authorize workflows generally', () => {
  // The enforcement wiring lives in .github/workflows/vto-e2e.yml, so that
  // one file acquired a manifest row. The row is an exact path on purpose: a
  // `.github/workflows/**` pattern would have handed this lane the security,
  // deployment and ZAP pipelines along with it.
  assert.deepEqual(unauthorizedIn(['.github/workflows/vto-e2e.yml']), []);
  assert.deepEqual(
    unauthorizedIn([
      '.github/workflows/security-code.yml',
      '.github/workflows/security-promotion-gate.yml',
      '.github/workflows/staging-controlled-deploy.yml',
      '.github/workflows/zap-api-staging.yml',
    ]).sort(),
    [
      '.github/workflows/security-code.yml',
      '.github/workflows/security-promotion-gate.yml',
      '.github/workflows/staging-controlled-deploy.yml',
      '.github/workflows/zap-api-staging.yml',
    ],
  );
});

test('MODE B: a generative backend mutation is REJECTED', () => {
  assert.deepEqual(
    unauthorizedIn([
      'supabase/functions/vto-generate/index.ts',
      'supabase/functions/vto-generate/providers/aiLabToolsProvider.ts',
      'supabase/functions/commerce-watch-refresh/index.ts',
    ]).sort(),
    [
      'supabase/functions/commerce-watch-refresh/index.ts',
      'supabase/functions/vto-generate/index.ts',
      'supabase/functions/vto-generate/providers/aiLabToolsProvider.ts',
    ],
    'GENERATIVE BACKEND MUTATION must remain NO',
  );
});

test('MODE B: the live diff really runs end to end when a lane declares itself', () => {
  // HEAD...HEAD is an empty diff, so this proves the ENFORCE path executes
  // and reaches its verdict -- not that some diff happened to be clean.
  const result = runGuardCli({ env: { [ENFORCE]: '1', [BASE]: 'HEAD' } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Base ref:\s+HEAD/);
  assert.match(result.stdout, /PASS: every changed path is inside the authorized/);
  assert.doesNotMatch(result.stdout, /NOT APPLICABLE/);
});

// ── MODE B fails closed ────────────────────────────────────────────────────

test('FAIL-CLOSED: enforcement with no base ref FAILS -- it does not skip', () => {
  for (const env of [{ [ENFORCE]: '1' }, { [ENFORCE]: '1', [BASE]: '' }, { [ENFORCE]: '1', [BASE]: '   ' }]) {
    const mode = guard.resolveScopeMode({ env, refExists: () => true });
    assert.equal(mode.decision, 'FAIL', JSON.stringify(env));
    assert.match(mode.reason, /unset or empty/);
  }
});

test('FAIL-CLOSED: enforcement with an unresolvable base ref FAILS', () => {
  const mode = guard.resolveScopeMode({
    env: { [ENFORCE]: '1', [BASE]: UNRESOLVABLE },
    refExists: () => false,
  });
  assert.equal(mode.decision, 'FAIL');
  assert.match(mode.reason, /does not resolve to a commit/);
});

test('FAIL-CLOSED: "could not resolve the base" is never the success control', () => {
  // The whole point. Against a REAL checkout, with a ref that genuinely does
  // not exist, the CLI must exit non-zero rather than report SKIPPED/PASS.
  const result = runGuardCli({ env: { [ENFORCE]: '1', [BASE]: UNRESOLVABLE } });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /does not resolve to a commit/);
  assert.doesNotMatch(result.stdout, /NOT APPLICABLE/);
  assert.doesNotMatch(result.stdout, /PASS: every changed path/);
});

test('FAIL-CLOSED: enforcement with no base ref exits non-zero in a real checkout', () => {
  const result = runGuardCli({ env: { [ENFORCE]: '1' } });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(`${BASE} is unset or empty`));
});

test('FAIL-CLOSED: an unrecognised enforcement value does not read as OFF', () => {
  for (const value of ['ture', 'yes', 'on', 'enabled', '2', 'no']) {
    const mode = guard.resolveScopeMode({ env: { [ENFORCE]: value }, refExists: () => true });
    assert.equal(mode.decision, 'FAIL', `${ENFORCE}=${value} must fail closed, not silently disarm`);
    assert.match(mode.reason, /neither an ON value/);
  }
});

test('FAIL-CLOSED: two conflicting base authorities are refused, not silently ranked', () => {
  const mode = guard.resolveScopeMode({
    env: { [ENFORCE]: '1', [BASE]: 'origin/one' },
    explicitBaseRef: 'origin/two',
    refExists: () => true,
  });
  assert.equal(mode.decision, 'FAIL');
  assert.match(mode.reason, /two different base authorities/);
});

test('FAIL-CLOSED: enforcement can NEVER resolve to SKIP', () => {
  // Property, not example: across every shape an enforcing environment can
  // take, the outcome is ENFORCE or FAIL. There is no silent path by which a
  // VTO lane avoids its mutation guard.
  const baseValues = [undefined, '', '   ', 'HEAD', UNRESOLVABLE];
  const explicitValues = [null, '', 'HEAD', UNRESOLVABLE];
  const refExistsValues = [() => true, () => false, (ref) => ref === 'HEAD'];

  for (const enforceValue of ['1', 'true']) {
    for (const baseValue of baseValues) {
      for (const explicitBaseRef of explicitValues) {
        for (const refExists of refExistsValues) {
          const env = { [ENFORCE]: enforceValue };
          if (baseValue !== undefined) env[BASE] = baseValue;
          const mode = guard.resolveScopeMode({ env, explicitBaseRef, refExists });
          assert.notEqual(
            mode.decision,
            'SKIP',
            `enforcement silently skipped for ${JSON.stringify({ env, explicitBaseRef })}`,
          );
        }
      }
    }
  }
});

// ── The manual/local invocation stays usable, and stays fail-closed ────────

test('a base ref named on the command line runs the diff without the env signal', () => {
  const result = runGuardCli({ args: ['HEAD'] });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: every changed path is inside the authorized/);
});

test('a base ref named on the command line that does not resolve FAILS', () => {
  const result = runGuardCli({ args: [UNRESOLVABLE] });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /does not resolve to a commit/);
});

// ── The defect itself cannot come back ─────────────────────────────────────

test('the base-ref DISCOVERY list that caused the blocker is gone', () => {
  // Scanned as code: this file and the guard both describe the old behaviour
  // in prose, and a naive text search would find the very words written to
  // disclaim it.
  const source = fs
    .readFileSync(GUARD_SCRIPT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  assert.ok(!source.includes('DEFAULT_BASE_REFS'), 'the candidate list must not return');
  assert.doesNotMatch(
    source,
    /f2ef091aae0f270a8b966dc03d7c18198070b42f/,
    'no hard-coded fallback base commit',
  );
  assert.doesNotMatch(
    source,
    /integration\/backend-kplus-complimentary-staging-v1/,
    'the base authority is declared by the caller, never guessed by the guard',
  );

  // And the detector is proven to detect, so an over-eager strip cannot pass
  // this test by finding nothing anywhere.
  const stripped = ' const DEFAULT_BASE_REFS = [];'
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(stripped.includes('DEFAULT_BASE_REFS'));
});

// ── §7: enforcement is wired at the VTO execution point, and only there ────

test('the VTO workflow declares the enforcement signal and runs the guard', () => {
  const workflow = fs.readFileSync(VTO_WORKFLOW, 'utf8');
  assert.match(workflow, new RegExp(`${ENFORCE}:\\s*'1'`), 'the VTO lane must declare enforcement');
  assert.match(workflow, new RegExp(`${BASE}:\\s*\\S`), 'and must name the base authority');
  assert.match(workflow, /node scripts\/check-vto-live-integration-scope\.js/);
  assert.match(
    workflow,
    /node --test __tests__\/vtoLiveIntegrationScope\.test\.js/,
    'the two live assertions must be proven to RUN somewhere, not merely to be skippable everywhere',
  );
});

test('the enforcement job never invents a base authority for a push', () => {
  const workflow = fs.readFileSync(VTO_WORKFLOW, 'utf8');
  const start = workflow.indexOf('\n  scope-guard:');
  assert.notEqual(start, -1, 'the scope-guard job must exist');
  const job = workflow.slice(start, workflow.indexOf('\n  staging-dryrun:', start));

  // The base authority of a change is the branch it is proposed INTO, which
  // only exists on a pull request. The first revision of this job fell back
  // to the integration branch on a push and failed a branch for work it had
  // legitimately inherited from its real base -- the same category error the
  // guard repair exists to remove.
  assert.match(job, /if:\s*github\.event_name == 'pull_request'/);
  assert.ok(
    !job.includes('github.ref_name'),
    'a pushed ref name must not stand in for a base authority',
  );

  const baseAssignments = job.match(/^\s*BASE=.*$/gm) ?? [];
  assert.equal(
    baseAssignments.length,
    1,
    `the base authority must have exactly one source, got: ${baseAssignments.join(' | ')}`,
  );
  assert.match(baseAssignments[0], /BASE="origin\/\$\{BASE_REF\}"/);
});

test('the general PR workflow does NOT declare itself a VTO lane', () => {
  const prWorkflow = fs.readFileSync(PR_WORKFLOW, 'utf8');
  assert.ok(
    !prWorkflow.includes(ENFORCE),
    'Project checks runs on every branch; declaring enforcement there would restore the blocker',
  );
});

test('the workflow\'s fallback base authority is the one the manifest records', () => {
  const workflow = fs.readFileSync(VTO_WORKFLOW, 'utf8');
  const declared = /VTO_BASE_AUTHORITY:\s*(\S+)/.exec(workflow);
  assert.ok(declared, 'the workflow must name the base authority it falls back to');

  const recorded = /INTEGRATION_BRANCH:\s*(\S+)/.exec(manifest);
  assert.ok(recorded, 'the manifest must record its base authority');

  assert.equal(
    declared[1],
    recorded[1],
    'the CI base authority and the manifest base authority must not drift apart',
  );
});
