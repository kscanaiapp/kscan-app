/**
 * Governance tests for MIGRATION-ONLY production deploy mode.
 *
 * `.github/workflows/production-controlled-deploy.yml` is the only governed
 * entry point that invokes scripts/apply-production-migration.mjs. It used to
 * require a real Edge Function on every run, which meant the Build 34
 * account-deletion campaign had no legal first step: every existing production
 * function is blocked until exact-bundle rollback lands, and both new functions
 * depend on a LATER migration in the same sequence.
 *
 * `function_name: none` removes exactly one thing — the function deployment.
 * These tests exist to prove it removes nothing else. The dangerous failure
 * here is not "the mode doesn't work"; it is "the mode quietly became a way to
 * reach production with fewer checks", so most of what follows asserts that the
 * governance controls are still wired to the migration path.
 *
 * The workflow is parsed into a job graph rather than grepped, so an assertion
 * cannot pass by accidentally matching a comment or a neighbouring job.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'production-controlled-deploy.yml');
const source = fs.readFileSync(WORKFLOW, 'utf8');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_REF = 'yzqjvdfgefveprobvvyw';

/**
 * Splits the workflow into jobs by indentation. Job keys sit at exactly two
 * spaces under `jobs:`; everything more deeply indented belongs to that job.
 * Good enough for this one file, and far more precise than a bare grep.
 */
function parseJobs(yaml) {
  const lines = yaml.split('\n');
  const jobsIndex = lines.findIndex((l) => l === 'jobs:');
  assert.ok(jobsIndex !== -1, 'workflow must declare a jobs: block');

  const jobs = {};
  let current = null;
  for (const line of lines.slice(jobsIndex + 1)) {
    const jobHeader = line.match(/^ {2}([a-z0-9-]+):\s*$/);
    if (jobHeader) {
      current = jobHeader[1];
      jobs[current] = [];
      continue;
    }
    if (current && line.trim() !== '' && !line.startsWith('   ') && !line.startsWith('  ')) break;
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

const jobs = parseJobs(source);

/** The `if:` expression of one job, whitespace-collapsed. */
function jobIf(name) {
  const body = jobs[name];
  assert.ok(body !== undefined, `job ${name} must exist`);
  const m = body.match(/^ {4}if:\s*\|?\s*\n((?: {6}.*\n?)+)/m) || body.match(/^ {4}if:\s*(.+)$/m);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

const MUTATING_JOBS = [
  'approved-single-migration',
  'deploy-one-function',
  'health-check',
  'synthetic-tests',
  'rollback-on-failure',
];

// --------------------------------------------------------------- 1. the mode

test('1. function_name=none selects a migration-only run', () => {
  const scope = jobs.preflight;

  assert.match(scope, /MIGRATION_ONLY=false/, 'the scope step defaults to a normal run');
  assert.match(
    scope,
    /tr '\[:upper:\]' '\[:lower:\]'\) *" *= *"none"/,
    'the sentinel is matched case-insensitively',
  );
  assert.match(scope, /MIGRATION_ONLY=true/, 'the sentinel switches the run into migration-only mode');
  assert.match(
    scope,
    /echo "migration_only=\$\{MIGRATION_ONLY\}" >> "\$GITHUB_OUTPUT"/,
    'the decision is published as a job output',
  );
  assert.match(
    jobs.preflight,
    /migration_only: \$\{\{ steps\.scope\.outputs\.migration_only \}\}/,
    'preflight exposes migration_only to downstream jobs',
  );
});

test('1b. the input documents the sentinel', () => {
  assert.match(source, /or "none" for a migration-only run/, 'the dispatch input documents the mode');
});

// ----------------------------------------------- 2, 3. approval is mandatory

test('2. migration approval is still mandatory in migration-only mode', () => {
  const scope = jobs.preflight;

  // A migration-only run with nothing approved would be a no-op wearing a
  // production deployment's clothes. It is refused outright.
  assert.match(
    scope,
    /approved_migration_version is required/,
    'migration-only without an approved version is refused',
  );
  assert.match(
    scope,
    /approve_migration must be YES/,
    'migration-only without approve_migration=YES is refused',
  );

  // The applier itself still gates on the same value.
  const applier = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-production-migration.mjs'), 'utf8');
  assert.match(applier, /APPROVE_PRODUCTION_MIGRATION/, 'the applier still requires its own approval flag');
  assert.match(applier, /MIGRATION_VERSION must be a 12-14 digit migration version/);

  // And the migration job still only runs when the plan says apply.
  assert.match(
    jobIf('approved-single-migration'),
    /needs\.migration-plan\.outputs\.apply == 'true'/,
    'the migration job is still gated on the migration plan',
  );
});

test('3. the DEPLOY TO PRODUCTION confirmation is still mandatory', () => {
  assert.match(
    jobs.confirm,
    /!= "DEPLOY TO PRODUCTION"/,
    'the exact confirmation phrase is still enforced',
  );
  assert.match(jobs.confirm, /exit 1/, 'a wrong phrase still fails the run');

  // Every job that can mutate production still descends from confirm.
  for (const job of MUTATING_JOBS) {
    assert.match(jobs[job], /^ {6}- confirm$/m, `${job} must still depend on confirm`);
  }

  // The confirm job carries no `if:`, so it can never be skipped.
  assert.equal(jobIf('confirm'), '', 'confirm is unconditional');
});

// ---------------------------------------------- 4, 5. environment and commit

test('4. the production Environment gate is preserved on every mutating job', () => {
  for (const job of MUTATING_JOBS) {
    assert.match(
      jobs[job],
      /^ {4}environment: production$/m,
      `${job} must keep the production Environment gate`,
    );
  }

  // Migration-only removes a deploy, not a gate: the migration job is the one
  // that mutates production in this mode, and it is gated.
  assert.match(jobs['approved-single-migration'], /^ {4}environment: production$/m);
});

test('5. the governed commit is still required before the migration runs', () => {
  assert.match(
    jobs['approved-single-migration'],
    /git rev-parse HEAD.*origin\/\$\{GOVERNED_BRANCH\}/s,
    'the migration job still pins HEAD to the governed branch tip',
  );
  assert.match(source, /GOVERNED_BRANCH: rebuild\/backend-authority-v2/);

  const preflight = fs.readFileSync(path.join(ROOT, 'scripts', 'production-deploy-preflight.mjs'), 'utf8');
  assert.match(preflight, /is not the current tip of/, 'assertGovernedCommit is unchanged');
});

// ------------------------------------- 6. no function deployment when "none"

test('6. no Edge Function deploy step runs in migration-only mode', () => {
  for (const job of ['source-validation', 'deploy-one-function']) {
    assert.match(
      jobIf(job),
      /needs\.preflight\.outputs\.migration_only != 'true'/,
      `${job} must be skipped in migration-only mode`,
    );
  }

  // The post-deploy chain hangs off deploy-one-function succeeding, so skipping
  // that job skips the rest without needing its own migration_only condition.
  for (const job of ['health-check', 'rollback-on-failure']) {
    assert.match(
      jobIf(job),
      /needs\.deploy-one-function\.result == 'success'/,
      `${job} only runs after a successful deploy`,
    );
  }
  assert.match(jobIf('synthetic-tests'), /needs\.health-check\.result == 'success'/);

  // The preflight must not demand a function allow-list either.
  assert.match(
    jobs.preflight,
    /DEPLOY_FUNCTIONS: \$\{\{ steps\.scope\.outputs\.migration_only == 'true' && '' \|\| inputs\.function_name \}\}/,
    'migration-only passes an empty DEPLOY_FUNCTIONS, which means "deploy nothing"',
  );

  // And the reported outcome says so plainly.
  assert.match(source, /FUNCTION_DEPLOYMENT=SKIPPED_MIGRATION_ONLY/);
  assert.match(
    jobs['publish-deployment-artifact'],
    /FUNCTION_DEPLOYMENT=SKIPPED_MIGRATION_ONLY/,
    'the summary reports the skip explicitly rather than leaving it blank',
  );
});

test('6b. a migration-only run is judged on the migration, and fails when it fails', () => {
  const summary = jobs['publish-deployment-artifact'];

  assert.match(
    summary,
    /^ {6}- approved-single-migration$/m,
    'the summary job must observe the migration result',
  );
  assert.match(
    summary,
    /Migration-only run: the approved migration did not succeed[\s\S]*?exit 1/,
    'a failed migration still fails a migration-only run',
  );
  // Without this early exit the pre-existing "deploy != success -> exit 1" check
  // would fail every migration-only run, because the deploy is skipped by design.
  assert.match(summary, /FUNCTION_DEPLOYMENT=SKIPPED_MIGRATION_ONLY"\s*\n\s*exit 0/);
});

// ------------------------------------- 7, 8. the normal path is not weakened

test('7. normal named-function behaviour is unchanged', () => {
  // The skip conditions are additive: for any function_name other than the
  // sentinel, migration_only is 'false' and every original condition still
  // decides the run.
  assert.match(
    jobIf('deploy-one-function'),
    /needs\.preflight\.result == 'success' && needs\.source-validation\.result == 'success'/,
    'the original deploy conditions survive',
  );
  assert.match(
    jobIf('source-validation'),
    /needs\.approved-single-migration\.result == 'success' \|\| needs\.approved-single-migration\.result == 'skipped'/,
    'the original source-validation conditions survive',
  );

  // The function source check is untouched for real function names.
  assert.match(jobs['source-validation'], /test -f "supabase\/functions\/\$\{FN\}\/index\.ts"/);
  assert.match(jobs['deploy-one-function'], /deploy-production-function\.mjs/);

  // verify_jwt is still carried through to the deploy, not defaulted away.
  assert.match(jobs['deploy-one-function'], /EXPECTED_VERIFY_JWT: \$\{\{ needs\.preflight\.outputs\.verify_jwt \}\}/);
});

test('8. function_name=all is still rejected, and so is an empty name', () => {
  assert.match(
    jobs.preflight,
    /if \[ -z "\$FN" \] \|\| \[ "\$FN" = "all" \]; then\s*\n\s*echo "Invalid function_name"\s*\n\s*exit 1/,
    'empty and "all" are still refused, before the sentinel is considered',
  );

  // The shared helper refuses "all" too, so both layers hold.
  const helpers = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs'), 'utf8');
  assert.match(helpers, /DEPLOY_FUNCTIONS=all is rejected/);
});

// --------------------------------------------- 9, 10. target and gate intact

test('9. staging can never be targeted, in either mode', () => {
  assert.match(source, /STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.match(source, /EXPECTED_PRODUCTION_REF: wyyuqfdxucjksghsmhry/);

  // The ref comparison used to live in the `preflight` job. It cannot: that
  // job runs BEFORE the production Environment gate and so has no project ref
  // to compare. It now runs inside `approved-single-migration`, where the
  // environment supplies the ref and where it sits immediately before the
  // write. Assert the refusal exists AND that every job performing it is
  // environment-gated — stricter than pinning it to one named job.
  const refusingJobs = Object.keys(jobs).filter((j) =>
    /Staging project ref is forbidden here/.test(jobs[j]),
  );
  assert.ok(refusingJobs.length > 0, 'some job must refuse the staging project ref');
  for (const job of refusingJobs) {
    assert.match(
      jobs[job],
      /^ {4}environment: production$/m,
      `the staging refusal in ${job} must sit behind the production Environment gate`,
    );
    assert.match(
      jobs[job],
      /SUPABASE_PRODUCTION_PROJECT_REF\}" != "\$\{EXPECTED_PRODUCTION_REF\}"/,
      'the production ref is still pinned',
    );
  }
  assert.ok(
    refusingJobs.includes('approved-single-migration'),
    'the migration job must refuse staging before it writes',
  );

  const helpers = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'production-helpers.mjs'), 'utf8');
  assert.ok(helpers.includes(STAGING_REF) || helpers.includes('STAGING_PROJECT_REF'));
  assert.match(helpers, /equals staging — refusing/);
  assert.ok(source.includes(PRODUCTION_REF), 'the production ref stays declared in the workflow');
});

test('10. migration-only mode cannot bypass reconciliation or the prohibited-SQL scan', () => {
  // The preflight runs before anything can mutate production, in both modes.
  // It now runs in two halves: a credential-free static precheck before the
  // approval gate (reconciliation authority + prohibited-SQL scan, everything
  // answerable without production), and the full remote preflight inside
  // `environment: production` immediately before the write. Both are
  // unconditional, so neither mode can skip either half.
  assert.match(
    jobs.preflight,
    /production-deploy-preflight\.mjs --static --json/,
    'the pre-approval half runs unconditionally and credential-free',
  );
  assert.equal(jobIf('preflight'), '', 'the preflight is unconditional');
  assert.match(
    jobs['approved-single-migration'],
    /node scripts\/production-deploy-preflight\.mjs --json/,
    'the full remote half runs inside the environment gate',
  );
  assert.match(jobs['approved-single-migration'], /^ {6}- preflight$/m);

  // Nothing in this change touched the gate or the scan.
  const applier = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-production-migration.mjs'), 'utf8');
  assert.match(applier, /selectApprovedMigration/);
  assert.match(applier, /scanSqlForProhibited/);
  assert.match(applier, /Migration blocked by prohibited SQL patterns/);
  assert.match(applier, /remote-only migrations exist with no declared reconciliation/);

  // The migration-only condition appears ONLY on the two function jobs. If it
  // ever leaks onto the migration job or the preflight, the mode would become a
  // way to skip the gate instead of the deploy.
  const carriers = Object.keys(jobs).filter((j) =>
    jobIf(j).includes("needs.preflight.outputs.migration_only != 'true'"),
  );
  assert.deepEqual(
    carriers.sort(),
    ['deploy-one-function', 'source-validation'],
    'only the function jobs may be skipped by migration-only mode',
  );
});

// ---------------------------------------------------- the campaign can start

test('the first account-deletion migration now has a legal governed dispatch', () => {
  // This is the whole point of the change: AD-DB-001 could not previously be
  // applied through the governed path at all, because it could not be paired
  // with any deployable function.
  const scope = jobs.preflight;
  assert.match(scope, /MIGRATION-ONLY RUN: no Edge Function will be deployed/);

  // function_name=none + approved_migration_version + approve_migration=YES +
  // confirm_production reaches the migration job, and only that job.
  assert.match(jobIf('approved-single-migration'), /needs\.migration-plan\.outputs\.apply == 'true'/);
  assert.doesNotMatch(
    jobIf('approved-single-migration'),
    /migration_only/,
    'the migration job must not be conditioned on the mode — it runs in both',
  );
});

test('the workflow is still manual-dispatch only', () => {
  assert.match(source, /^on:\s*\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(source, /^ {2}(push|pull_request|schedule|repository_dispatch):/m);
});
