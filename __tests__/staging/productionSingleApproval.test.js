const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const ROOT = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(ROOT, '.github/workflows/production-controlled-deploy.yml'), 'utf8');
const jobs = yaml.load(source).jobs;
const execution = jobs['deploy-one-function'];
const step = (name) => execution.steps.find((entry) => entry.name === name);

test('one exclusive protected job covers each complete deployment mode', () => {
  assert.deepEqual(Object.keys(jobs).filter((name) => jobs[name].environment === 'production').sort(),
    ['approved-single-migration', 'deploy-one-function']);
  assert.match(jobs['approved-single-migration'].if, /migration_only == 'true'.*apply == 'true'/);
  assert.match(execution.if, /migration_only != 'true'/);
  assert.ok(execution.needs.includes('source-validation'));
  assert.ok(!jobs['source-validation'].needs.includes('approved-single-migration'));
  assert.match(step('Apply one approved migration').if, /apply == 'true'/);
  assert.match(step('Live remote preflight against production (post-approval, pre-write)').if, /apply == 'true'/);
  assert.match(step('Refuse anything but the governed branch tip').run, /git fetch.*GOVERNED_BRANCH/);
});

test('optional migration, deployment, live contracts, smoke checks and recovery remain inside one approval', () => {
  const names = execution.steps.map((entry) => entry.name);
  const ordered = ['Live remote preflight against production (post-approval, pre-write)',
    'Apply one approved migration', 'Stage scoped migration artifacts outside checkout',
    'Deploy function', 'Probe deployed function', 'Run production deployment smoke tests',
    'Roll back / contain deployed function', 'Require complete scoped deployment success'];
  for (let i = 1; i < ordered.length; i++) assert.ok(names.indexOf(ordered[i]) > names.indexOf(ordered[i - 1]));
  assert.match(step('Probe deployed function').run, /checkProductionContract/);
  assert.match(step('Probe deployed function').if, /steps\.deploy\.outcome == 'success'/);
  assert.match(step('Run production deployment smoke tests').if, /steps\.health\.outcome == 'success'/);
  assert.match(step('Roll back / contain deployed function').if, /always\(\).*steps\.deploy\.outcome == 'success'/);
  assert.match(step('Roll back / contain deployed function').if, /health\.outcome != 'success'.*synthetic\.outcome != 'success'/);
  assert.match(step('Roll back / contain deployed function').run, /recover-production-function\.mjs --reference "artifacts\/production-deployments\/recovery-reference.json"/);
  assert.ok(execution.steps.every((entry) => !entry['continue-on-error']));
  assert.equal(step('Deploy function').env.APPROVED_MIGRATION_VERSION, '');
  assert.match(step('Stage scoped migration artifacts outside checkout').run, /mv artifacts\/production-migrations "\$RUNNER_TEMP\//);
});

test('failed, skipped or canceled verification cannot report success after recovery', () => {
  const verdict = step('Require complete scoped deployment success');
  assert.equal(verdict.if, 'always()');
  // Execute the actual verdict shell on Linux; Windows still asserts the exact
  // boolean contract while Linux CI exercises every terminal outcome.
  assert.match(verdict.run, /test "\$DEPLOY" = success && test "\$HEALTH" = success && test "\$SYNTHETIC" = success/);
  if (process.platform === 'win32') return;
  for (const DEPLOY of ['success', 'failure', 'cancelled', 'skipped']) {
    for (const HEALTH of ['success', 'failure', 'cancelled', 'skipped']) {
      for (const SYNTHETIC of ['success', 'failure', 'cancelled', 'skipped']) {
        const result = spawnSync('bash', ['-c', verdict.run], { env: { ...process.env, DEPLOY, HEALTH, SYNTHETIC } });
        assert.equal(result.status === 0, [DEPLOY, HEALTH, SYNTHETIC].every((value) => value === 'success'));
      }
    }
  }
});

test('durable private recovery and independently protected interruption recovery are retained', () => {
  const deployer = fs.readFileSync(path.join(ROOT, 'scripts/deploy-production-function.mjs'), 'utf8');
  const capture = deployer.indexOf('await store.upload');
  const replace = deployer.indexOf('runSupabaseProduction(deployArgs)');
  assert.ok(capture >= 0 && replace > capture, 'recovery must precede replacement');
  assert.match(source, /production-function-recovery/);
  const recovery = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/production-function-recovery.yml'), 'utf8'));
  assert.ok(Object.values(recovery.jobs).some((job) => job.environment === 'production'));
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/production-function-recovery.yml'), 'utf8'), /recover-production-function/);
  const upload = step('Upload deploy artifacts');
  assert.equal(upload.with.path, '${{ runner.temp }}/production-deploy-artifact/');
  assert.doesNotMatch(upload.with.path, /production-function-captures/);
});
