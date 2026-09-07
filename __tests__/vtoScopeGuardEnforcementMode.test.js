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
  assert.match(result.stdout, /PASS: every VTO-owned changed path is inside the authorized/);
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
  assert.match(result.stdout, /PASS: every VTO-owned changed path is inside the authorized/);
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

// ── The unit of enforcement is the VTO-OWNED SUBSET, not the whole diff ─────
//
// Declaring lane membership stopped a NON-VTO branch being judged. It did not
// stop a MIXED one. An integration branch merges the VTO lane together with
// unrelated lanes, so it touches VTO paths and is correctly classified a VTO
// lane -- and was then refused for the research labs, commerce and onboarding
// work it also carries, none of which answers to this boundary.
//
// The repair scopes the manifest check to the paths VTO actually owns. That is
// only safe if it cannot become a bypass, so the controls below prove the
// narrowing in BOTH directions: an unauthorized VTO path must still fail no
// matter how much unrelated work is stacked around it.

const LABS = [
  'tools/fashion-match-quality/lib/score.js',
  'tools/curiosity-gap-performance/runLab.js',
  'tools/canonical-product-identity/resolver/identity.js',
  'tools/elise-concierge-eval/runner.js',
  'tools/real-fashion-corpus/lib/ingest.js',
  '__tests__/curiosityGapPerformance/labGraph.test.js',
];
const UNRELATED_PRODUCTION = [
  'app/onboarding/index.tsx',
  'services/watchlist/pushRegistration.ts',
  'supabase/functions/commerce-watch-refresh/index.ts',
  'components/home/HomeLuxuryTechV1.tsx',
];

/** An authorized VTO path, taken from the manifest itself rather than guessed. */
const AUTHORIZED_VTO_PATH = 'services/vto/vtoPersonInput.ts';
/** VTO-owned by prefix, and deliberately absent from the manifest. */
// `scripts/vto-e2e/` is VTO-owned, and the manifest deliberately declares ONE
// exact file under it rather than widening to `scripts/vto-e2e/**`. So a second
// file there is genuinely VTO-owned AND genuinely unauthorized -- which is what
// this fixture has to be for the hostile controls to mean anything.
const UNAUTHORIZED_VTO_PATH = 'scripts/vto-e2e/zzUnauthorizedProbe.mjs';

function judge(changedPaths) {
  const { vtoOwned, notJudged } = guard.partitionByVtoOwnership(changedPaths);
  return {
    notJudged,
    unauthorized: guard.classifyChangedPaths(vtoOwned, patterns).unauthorized,
  };
}

test('OWNERSHIP: the authorized VTO fixture really is authorized (so the controls below mean something)', () => {
  assert.ok(guard.isVtoOwnedPath(AUTHORIZED_VTO_PATH));
  assert.deepEqual(unauthorizedIn([AUTHORIZED_VTO_PATH]), []);
});

test('OWNERSHIP: the unauthorized VTO fixture is VTO-owned and NOT in the manifest', () => {
  // If either half of this drifts, the hostile control below would pass for
  // the wrong reason -- a path that is ignored rather than refused.
  assert.ok(guard.isVtoOwnedPath(UNAUTHORIZED_VTO_PATH));
  assert.deepEqual(unauthorizedIn([UNAUTHORIZED_VTO_PATH]), [UNAUTHORIZED_VTO_PATH]);
});

test('OWNERSHIP: labs and unrelated production paths are not VTO-owned', () => {
  for (const p of [...LABS, ...UNRELATED_PRODUCTION]) {
    assert.equal(guard.isVtoOwnedPath(p), false, `${p} must not be claimed by the VTO boundary`);
  }
});

test('HOSTILE: many unrelated integration paths + ONE unauthorized VTO path -> still FAILS', () => {
  // The control that keeps the narrowing honest. Volume of unrelated work is
  // not a place to hide a VTO mutation.
  const diff = [...LABS, ...UNRELATED_PRODUCTION, AUTHORIZED_VTO_PATH, UNAUTHORIZED_VTO_PATH];
  const { unauthorized } = judge(diff);
  assert.deepEqual(
    unauthorized,
    [UNAUTHORIZED_VTO_PATH],
    'the one unauthorized VTO path must be refused, and it must be the ONLY thing refused',
  );
});

test('HOSTILE: many unrelated integration paths + only AUTHORIZED VTO paths -> PASSES', () => {
  const diff = [...LABS, ...UNRELATED_PRODUCTION, AUTHORIZED_VTO_PATH];
  const { unauthorized, notJudged } = judge(diff);
  assert.deepEqual(unauthorized, [], 'an integration branch must not be refused for other lanes');
  assert.equal(
    notJudged.length,
    LABS.length + UNRELATED_PRODUCTION.length,
    'every unrelated path must be REPORTED as not judged, not silently dropped',
  );
});

test('HOSTILE: a pure VTO lane is judged exactly as hard as a mixed one', () => {
  // Same VTO content, with and without unrelated work stacked around it. The
  // verdict on the VTO paths must be identical -- otherwise adding unrelated
  // files would itself be a way to soften the boundary.
  const pure = judge([AUTHORIZED_VTO_PATH, UNAUTHORIZED_VTO_PATH]).unauthorized;
  const mixed = judge([...LABS, AUTHORIZED_VTO_PATH, UNAUTHORIZED_VTO_PATH]).unauthorized;
  assert.deepEqual(mixed, pure);
  assert.deepEqual(pure, [UNAUTHORIZED_VTO_PATH]);
});

test('HOSTILE: an all-unrelated diff is not a pass the guard can be said to have granted', () => {
  const { unauthorized, notJudged } = judge(LABS);
  assert.deepEqual(unauthorized, []);
  assert.deepEqual(notJudged, LABS, 'the guard must account for every path it declined to judge');
});

test('HOSTILE: partitioning loses nothing -- every changed path is judged or reported', () => {
  const diff = [...LABS, ...UNRELATED_PRODUCTION, AUTHORIZED_VTO_PATH, UNAUTHORIZED_VTO_PATH];
  const { vtoOwned, notJudged } = guard.partitionByVtoOwnership(diff);
  assert.equal(vtoOwned.length + notJudged.length, diff.length);
  assert.deepEqual([...vtoOwned, ...notJudged].sort(), [...diff].sort());
});

test('NO BYPASS: nothing in the ownership rule reads a branch name', () => {
  // The superseded design inferred lane membership from substrings in the
  // branch name. This one must not reintroduce that by any route.
  const source = fs.readFileSync(GUARD_SCRIPT, 'utf8');
  const owning = source.slice(
    source.indexOf('const VTO_OWNED_PREFIXES'),
    source.indexOf('function partitionByVtoOwnership'),
  );
  assert.ok(owning.length > 0, 'the ownership rule must be locatable in the guard source');

  // Comments stripped first: this control is about what the rule EXECUTES, and
  // the prose above it necessarily discusses branch names in order to explain
  // why it does not read them.
  const code = owning
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  for (const forbidden of [
    'GITHUB_HEAD_REF',
    'GITHUB_REF_NAME',
    'process.env',
    'branchName',
    'headRef',
    'execFileSync',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `the ownership rule must not consult ${forbidden}: ownership is by path, never by lane identity`,
    );
  }
});

test('NO BYPASS: an integration-looking branch does not change what a path is', () => {
  // A VTO file does not stop being VTO-owned because of the branch it arrives
  // on. Ownership is a property of the path and nothing else.
  assert.ok(guard.isVtoOwnedPath('services/vto/anything.ts'));
  assert.ok(guard.isVtoOwnedPath('modules/kscan-live-vto-native/android/src/main/Foo.kt'));
  assert.ok(guard.isVtoOwnedPath('supabase/functions/vto-generate/index.ts'));
});

test('the Live VTO native runtime is inside VTO ownership', () => {
  // #308/#312/#313 added a native runtime after the original prefix list was
  // written. If it were not claimed here, the lane's own newest surface would
  // be the one thing the boundary could not see.
  for (const p of [
    'modules/kscan-live-vto-native/android/src/main/java/expo/modules/kscanlivevtonative/KScanLiveVtoModule.kt',
    'config/on-device-model-authority.json',
    'scripts/check-on-device-model-authority.js',
    'evidence/vto-live-native-n1/capture.json',
  ]) {
    assert.ok(guard.isVtoOwnedPath(p), `${p} must be judged by the VTO boundary`);
  }
});

test('SINGLE DEFINITION: the workflow classifies lanes with the guard own predicate', () => {
  // Two definitions of "VTO path" that can drift apart is how a branch ends up
  // classified by one rule and judged by another.
  const workflow = fs.readFileSync(VTO_WORKFLOW, 'utf8');
  assert.ok(
    workflow.includes('isVtoOwnedPath'),
    'the lane classifier must call the exported predicate from the guard',
  );
  assert.ok(
    !workflow.includes("grep -E '^(services/vto/"),
    'the workflow must not keep a second, forkable copy of the VTO prefix list',
  );
});

test('SINGLE DEFINITION: every prefix is an exact string, never a pattern to interpret', () => {
  for (const prefix of guard.VTO_OWNED_PREFIXES) {
    assert.equal(typeof prefix, 'string');
    assert.ok(prefix.length > 0);
    for (const metachar of ['*', '?', '[', '(', '|', '\\']) {
      assert.ok(
        !prefix.includes(metachar),
        `${prefix} must be a plain prefix: a guard whose matching rules need interpreting is one nobody can audit`,
      );
    }
  }
});

test('the prefix list is frozen, so no caller can widen ownership at runtime', () => {
  assert.ok(Object.isFrozen(guard.VTO_OWNED_PREFIXES));
});

test('AGREEMENT: the workflow\'s two enforcement steps ask the same question', () => {
  // The scope-guard job runs the CLI and then runs this file, both with
  // enforcement declared. They are two implementations of one boundary, so a
  // change to the unit of scope in one and not the other makes the job
  // self-contradictory -- which is exactly what happened: the CLI judged the
  // VTO-owned subset and passed, while this file still classified the whole
  // diff and refused an integration branch for its research labs.
  //
  // Asserted structurally rather than by re-running the CLI: both call sites
  // must partition before classifying.
  const suite = fs.readFileSync(GUARD_TESTS, 'utf8');
  const script = fs.readFileSync(GUARD_SCRIPT, 'utf8');

  for (const [name, source] of [['the guard script', script], ['the guard test suite', suite]]) {
    const partitionAt = source.indexOf('partitionByVtoOwnership');
    const classifyAt = source.indexOf('classifyChangedPaths(');
    assert.notEqual(partitionAt, -1, `${name} must scope the diff to VTO-owned paths first`);
    assert.notEqual(classifyAt, -1, `${name} must classify against the manifest`);
  }

  // And the live assertion must not classify the raw diff variable.
  assert.ok(
    !/classifyChangedPaths\(\s*changed\s*,/.test(suite),
    'the live assertion must classify the VTO-owned subset, never the whole diff',
  );
});
