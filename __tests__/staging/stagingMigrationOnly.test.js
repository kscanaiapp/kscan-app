const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '../..');
const GREETING = '20261015214749';
const OTHER = '20260101000000';
const importFile = (name) => import(pathToFileURL(path.join(ROOT, 'scripts', name)).href);
const local = (...versions) => versions.map((version) => ({ version, name: 'fixture', path: `${version}_fixture.sql` }));
const declaration = (version, disposition = 'KNOWN_FUTURE_UNAPPLIED') => ({
  localVersion: version, logicalName: 'fixture', disposition, applyAfter: [], evidence: 'Synthetic governed migration test evidence; no live execution.',
});
const authority = (...entries) => ({ reconciled: [], remoteOnly: [], knownPending: entries });

test('migration-only scope cannot silently deploy a function or execute without exact approval', async () => {
  const { resolveStagingDeployScope } = await importFile('staging-deploy-scope.mjs');
  const input = { functionName: 'none', verifyJwt: 'true', approvedVersion: GREETING, approveMigration: 'YES' };
  const result = resolveStagingDeployScope(input);
  assert.equal(result.migration_only, 'true');
  assert.equal(result.deploy_functions, '', 'none must never reach the function allowlist');
  for (const override of [ { approvedVersion: '' }, { approvedVersion: 'all' }, { approveMigration: 'NO' },
    { approveMigration: '' }, { functionName: 'all' }, { functionName: 'a,b' }, { functionName: '' }, { verifyJwt: 'maybe' } ]) {
    assert.throws(() => resolveStagingDeployScope({ ...input, ...override }));
  }
  const functionOnly = resolveStagingDeployScope({ functionName: 'staging-health', verifyJwt: 'false' });
  assert.equal(functionOnly.migration_only, 'false');
  assert.equal(functionOnly.deploy_functions, 'staging-health');
});

test('Staging selects exactly the greeting migration while other declared pending work stays untouched', async () => {
  const { selectApprovedMigration } = await importFile('apply-staging-migration.mjs');
  const { selectApprovedMigration: productionSelect } = await importFile('apply-production-migration.mjs');
  const input = { local: local(GREETING, OTHER), remote: [], approvedVersion: GREETING,
    reconciliation: authority(declaration(GREETING), declaration(OTHER, 'HOLD')) };
  const result = selectApprovedMigration(input);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.selected.version, GREETING);
  assert.equal(result.pending.length, 2);
  assert.equal(productionSelect(input).selected.version, GREETING, 'same shared reconciliation policy as Production');
  for (const mutate of [
    (i) => ({ ...i, approvedVersion: '' }),
    (i) => ({ ...i, approvedVersion: OTHER }), // HOLD cannot be selected
    (i) => ({ ...i, approvedVersion: '20990101000000' }),
    (i) => ({ ...i, remote: [GREETING] }),
    (i) => ({ ...i, local: [...i.local, ...local(GREETING)] }),
    (i) => ({ ...i, local: [...i.local, ...local('20990101000000')] }),
    (i) => ({ ...i, remote: ['20990101000000'] }),
    (i) => ({ ...i, reconciliation: authority(declaration(GREETING, 'EXCLUDE'), declaration(OTHER)) }),
    (i) => ({ ...i, reconciliation: authority(declaration(OTHER)) }),
    (i) => ({ ...i, reconciliation: authority() }), // many unexplained pending
  ]) {
    const rejected = selectApprovedMigration(mutate(input));
    assert.equal(rejected.selected, null);
    assert.ok(rejected.blockers.length > 0);
  }
});

test('post-apply check requires exactly one ledger addition, preserves pending work, rejects unrelated changes', async () => {
  const { verifyAppliedMigration } = await importFile('apply-staging-migration.mjs');
  const input = { local: local(GREETING, OTHER, '20200101000000'), beforeRemote: ['20200101000000'],
    afterRemote: ['20200101000000', GREETING], approvedVersion: GREETING,
    reconciliation: authority(declaration(GREETING), declaration(OTHER)) };
  const result = verifyAppliedMigration(input);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.report.knownPending.map((m) => m.version), [OTHER]);
  for (const afterRemote of [input.beforeRemote, [...input.afterRemote, OTHER],
    [...input.afterRemote, '20990101000000'], [GREETING]]) {
    assert.ok(verifyAppliedMigration({ ...input, afterRemote }).blockers.length > 0);
  }
});

test('an alternate file carrying the approved filename cannot substitute its SQL', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elise-migration-file-'));
  const decoy = path.join(directory, `${GREETING}_style_chat_greeting_actor_session_unique.sql`);
  fs.writeFileSync(decoy, 'select 1;');
  t.after(() => { fs.unlinkSync(decoy); fs.rmdirSync(directory); });
  const moduleUrl = pathToFileURL(path.join(ROOT, 'scripts/apply-staging-migration.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {resolveMigrationFile} from ${JSON.stringify(moduleUrl)}; resolveMigrationFile('${GREETING}',process.argv[1]);`, decoy],
  { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /must resolve to the governed local migration/);
});

test('migration-only workflow skips all function jobs and cannot report success for a failed migration', () => {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows/staging-controlled-deploy.yml'), 'utf8');
  const job = (name) => source.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
  for (const name of ['source-validation', 'deploy-one-function']) {
    const block = job(name);
    assert.match(block, /needs\.preflight\.outputs\.migration_only != 'true'/);
  }
  // Execute the actual trusted workflow expressions against job-result
  // scenarios, rather than merely checking that guard words are present.
  const enabled = (name, needs) => {
    const expression = job(name).match(/    if: \|\n((?:      .*\n)+)/)[1]
      .trim().replace(/always\(\)/g, 'true').replace(/needs\.([a-z-]+)\.outputs\.([a-z_]+)/g,
        (_, key, output) => JSON.stringify(needs[key]?.outputs?.[output]))
      .replace(/needs\.([a-z-]+)\.result/g, (_, key) => JSON.stringify(needs[key]?.result));
    return Function(`return (${expression});`)();
  };
  const needs = { preflight: { result: 'success', outputs: { migration_only: 'true' } },
    'approved-single-migration': { result: 'success' }, 'source-validation': { result: 'skipped' },
    'deploy-one-function': { result: 'skipped' }, 'health-check': { result: 'skipped' },
    'synthetic-tests': { result: 'skipped' } };
  for (const name of ['source-validation', 'deploy-one-function', 'health-check', 'synthetic-tests', 'rollback-on-failure']) {
    assert.equal(enabled(name, needs), false, `migration-only must skip ${name}`);
  }
  needs.preflight.outputs.migration_only = 'false';
  needs['approved-single-migration'].result = 'skipped';
  assert.equal(enabled('source-validation', needs), true, 'function-only mode remains skip tolerant');
  needs['source-validation'].result = 'success';
  assert.equal(enabled('deploy-one-function', needs), true);
  needs.preflight.result = 'failure';
  assert.equal(enabled('deploy-one-function', needs), false);
  assert.match(job('preflight'), /DEPLOY_FUNCTIONS: \$\{\{ steps\.scope\.outputs\.deploy_functions \}\}/);
  assert.match(job('approved-single-migration'), /git rev-parse origin\/rebuild\/backend-authority-v2/);
  const summary = job('publish-deployment-artifact');
  assert.match(summary, /- approved-single-migration/);
  assert.match(summary, /test "\$\{\{ needs\.approved-single-migration\.result \}\}" = 'success'/);
  for (const name of ['deploy-one-function', 'health-check', 'synthetic-tests', 'rollback-on-failure']) {
    assert.ok(summary.includes(`test "\x24{{ needs.${name}.result }}" = 'skipped'`));
  }
});
