'use strict';

/**
 * Workflow-contract guards for the Staging Gate V2 enforcement-level model as
 * ported onto this integration line (PR #238's rationalization, brought into
 * PR #236 without merging staging/production-parity wholesale).
 *
 * NAMING NOTE. Upstream these assertions live inside
 * __tests__/security/securityWorkflowContract.test.js, a file that belongs to
 * staging/production-parity's security baseline and does not exist here.
 * Recreating that filename with only a fragment of its contents would produce
 * an add/add conflict the next time these two lines converge, so the V2
 * assertions get their own file instead. When that baseline does land here,
 * fold these into it.
 *
 * These assert YAML-level properties CI cannot discover for itself: a gate
 * that silently stops gating looks exactly like a green run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

const workflowFiles = fs.readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({ name, content: fs.readFileSync(path.join(WORKFLOWS, name), 'utf8') }));

function workflow(name) {
  const found = workflowFiles.find((file) => file.name === name);
  assert.ok(found, `${name} must exist`);
  return found;
}

function slice(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  assert.notEqual(start, -1, `missing block start ${startMarker}`);
  const end = content.indexOf(endMarker, start + startMarker.length);
  return content.slice(start, end === -1 ? undefined : end);
}

function projectChecksBlock() {
  return slice(workflow('security-code.yml').content, 'project-checks:', '\n  gitleaks:');
}

// --- Section 4: the base/head regression check needs a real base commit ---

test('project-checks checkout uses full history (fetch-depth: 0)', () => {
  assert.match(
    projectChecksBlock(),
    /fetch-depth:\s*0/,
    'project-checks must fetch full history for git worktree add <base_sha> to resolve',
  );
});

test('project-checks runs the enforcement-level and base/head regression steps', () => {
  const jobBlock = projectChecksBlock();
  assert.match(jobBlock, /id: enforcement/, 'the enforcement-level step must exist');
  assert.match(jobBlock, /run-project-checks-regression\.js/, 'the base/head regression runner must be invoked');
  assert.match(
    jobBlock,
    /if: github\.event_name == 'pull_request' && steps\.enforcement\.outputs\.level == 'NORMAL_PR'/,
    'the regression path must be scoped to NORMAL_PR pull_request events only',
  );
});

test('the regression report is uploaded even when the job fails, so the promotion gate can classify the failure', () => {
  const jobBlock = projectChecksBlock();
  assert.match(jobBlock, /name: project-checks-regression-/);
  assert.match(jobBlock, /if: always\(\) && steps\.regression\.outcome != 'skipped'/);
});

// --- The convergence invariant this PR exists to hold ---

const TRACK_B_GATES = [
  'node scripts/run-all-tests.js',
  'node scripts/run-backend-tests.js',
  'npx tsc --noEmit -p tsconfig.json',
  'deno check supabase/functions/stylechat-generate/index.ts',
  'node scripts/check-edge-function-parity.js',
  'node scripts/generate-edge-function-manifest.js --check',
];

test('every Track B integration gate still runs, unconditionally, at every enforcement level', () => {
  const steps = projectChecksBlock().split(/\n      - name: /).slice(1);
  for (const gate of TRACK_B_GATES) {
    const step = steps.find((s) => s.includes(`run: ${gate}`));
    assert.ok(step, `Track B gate must still be present: ${gate}`);
    assert.doesNotMatch(
      step,
      /\n        if:/,
      `Track B gate must never become conditional - a typecheck error, an Edge Function parity break or manifest drift is a whole-tree invariant, not an inheritable test outcome: ${gate}`,
    );
  }
});

const FLAT_SUITE_SCRIPTS = [
  'test:privacy',
  'test:auth-privacy',
  'test:verify-supabase',
  'test:analyze-contract',
  'test:security',
];

test('the flat npm test suites are the only steps downgraded to base-relative at NORMAL_PR', () => {
  const jobBlock = projectChecksBlock();
  for (const script of FLAT_SUITE_SCRIPTS) {
    const pattern = new RegExp(`if: steps\\.regression\\.outcome == 'skipped'\\s*\\n\\s*run: npm run ${script}\\b`);
    assert.match(jobBlock, pattern, `${script} must be guarded on the regression step having been skipped`);
  }
});

test('run-project-checks-regression DEFAULT_SCRIPTS matches the flat suite security-code.yml actually runs', () => {
  // Drift here silently narrows what the base/head diff covers: a script added
  // to the workflow but not to DEFAULT_SCRIPTS would never be diffed at all on
  // a NORMAL_PR, and one removed from the workflow but left here throws in
  // resolveScriptFiles (fail closed to CI_OPERATIONAL_FAILURE).
  const { DEFAULT_SCRIPTS } = require('../../security/scripts/run-project-checks-regression');
  const guarded = [...projectChecksBlock().matchAll(/if: steps\.regression\.outcome == 'skipped'\s*\n\s*run: npm run (\S+)/g)]
    .map((m) => m[1]);
  assert.deepEqual(guarded, FLAT_SUITE_SCRIPTS);
  assert.deepEqual(DEFAULT_SCRIPTS, FLAT_SUITE_SCRIPTS);
});

// --- Section 6/10: docs-only skip, qualified by enforcement level ---

function contractTestsBlock() {
  return slice(workflow('security-staging-gate.yml').content, '\n  contract-tests:', '\n  staging-security-gate:');
}

test('contract-tests is gated off for docs-only classifications', () => {
  assert.match(
    contractTestsBlock(),
    /classifications\s*!=\s*'DOCUMENTATION ONLY'/,
    'contract-tests must skip (not fail) for a purely documentation-only diff',
  );
});

test('the docs-only exemption for contract-tests is qualified by enforcement level, not classification alone', () => {
  assert.match(
    contractTestsBlock(),
    /enforcement_level\s*!=\s*'NORMAL_PR'/,
    'the docs-only skip must be scoped to NORMAL_PR level only',
  );
  const classifyOutputsBlock = slice(
    workflow('security-staging-gate.yml').content,
    'classify-changes:',
    '\n    steps:',
  );
  assert.match(classifyOutputsBlock, /enforcement_level:/, 'classify-changes must expose an enforcement_level output');
});

test('staging-security-gate treats a skipped Contract tests result as passing, not blocking', () => {
  const stagingGate = workflow('security-staging-gate.yml').content;
  assert.doesNotMatch(
    stagingGate,
    /if\s*\[\s*"\$CONTRACT"\s*!=\s*"success"\s*\]/,
    'CONTRACT must not be compared with != "success" - that reads a legitimate skip as a failure',
  );
  assert.match(
    stagingGate,
    /if\s*\[\s*"\$CONTRACT"\s*=\s*"failure"\s*\]/,
    'CONTRACT should be compared the same tolerant way MIGRATION/HEALTH/SYNTHETIC already are',
  );
});

// --- Deployment applicability ---

test('the staging write jobs are gated on backend_deployment_required, not the blanket staging_impact', () => {
  const stagingGate = workflow('security-staging-gate.yml').content;
  for (const [job, next] of [
    ['\n  deploy-staging:', '\n  staging-health:'],
    ['\n  staging-health:', '\n  synthetic-tests:'],
    ['\n  synthetic-tests:', '\n  contract-tests:'],
  ]) {
    const jobBlock = slice(stagingGate, job, next);
    const condition = jobBlock.slice(0, jobBlock.indexOf('    steps:'));
    assert.match(
      condition,
      /needs\.classify-changes\.outputs\.backend_deployment_required == 'true'/,
      `${job.trim()} must gate on backend_deployment_required`,
    );
    assert.doesNotMatch(
      condition,
      /needs\.classify-changes\.outputs\.staging_impact == 'true'/,
      `${job.trim()} must no longer gate on the blanket staging_impact`,
    );
  }
});

test('deploy authority is still an allow-list of the governed branch or an explicit dispatch', () => {
  const jobBlock = slice(
    workflow('security-staging-gate.yml').content,
    '\n  deploy-staging:',
    '\n  staging-health:',
  );
  const condition = jobBlock.slice(0, jobBlock.indexOf('    steps:'));
  assert.match(condition, /github\.ref == 'refs\/heads\/staging\/production-parity'/);
  assert.match(condition, /inputs\.confirm_staging_deploy == 'DEPLOY-TO-STAGING'/);
  assert.doesNotMatch(condition, /!=/, 'deploy authority must not use negative branch matching');
});

// --- Why PR #238's ZAP trigger scoping was NOT ported to this line ---

test('every DEPLOYMENT_REQUIRED_CHECK is still produced on an ordinary pull request', () => {
  // On staging/production-parity, PR #238 scopes the two ZAP workflows to
  // `branches: [staging/production-parity]`. That is safe there because
  // security-promotion-gate.yml is workflow_dispatch-only and
  // staging-release-certification.yml invokes ZAP via workflow_call instead.
  //
  // Neither of those exists on this line: the promotion gate still runs
  // automatically, and evaluate-promotion-gate.js requires the ZAP check-runs
  // to EXIST (skipped is fine, missing is not - see resolveCheckRunVerdict's
  // `missing` path, which forces OPERATIONAL FAILURE). Scoping those triggers
  // here would make them missing on every ordinary PR and permanently block
  // promotion. This test fails if someone ports that scoping without first
  // bringing the certification workflow that makes it safe.
  const { DEPLOYMENT_REQUIRED_CHECKS } = require('../../security/scripts/evaluate-promotion-gate');
  const producers = {
    'Staging health checks': 'security-staging-gate.yml',
    'Synthetic auth tests': 'security-staging-gate.yml',
    'ZAP Baseline (staging)': 'zap-baseline-staging.yml',
    'ZAP API staging': 'zap-api-staging.yml',
  };
  for (const checkName of DEPLOYMENT_REQUIRED_CHECKS) {
    const file = producers[checkName];
    assert.ok(file, `no known producer workflow for required check "${checkName}"`);
    const content = workflow(file).content;
    assert.ok(
      content.includes(`name: ${checkName}`),
      `${file} must still declare the job name "${checkName}"`,
    );
    const triggerBlock = content.slice(content.indexOf('\non:'), content.indexOf('\npermissions:'));
    assert.match(
      triggerBlock,
      /pull_request:/,
      `${file} must still run on pull_request so "${checkName}" materializes as a check-run`,
    );
    assert.doesNotMatch(
      triggerBlock,
      /branches: \[staging\/production-parity\]/,
      `${file} triggers must not be scoped to staging/production-parity while evaluate-promotion-gate.js still requires "${checkName}" to exist on every PR`,
    );
  }
});
