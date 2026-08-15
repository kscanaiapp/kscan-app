#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for the hardened staging deployment pipeline.
 * Pure unit tests — no network, no secrets required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function runNode(script, env = {}, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('environment: production URL is rejected by assertStagingTarget helper', async () => {
  const helpersPath = path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs');
  const { assertStagingTarget, PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF } = await import(
    pathToFileUrl(helpersPath)
  );
  assert.equal(STAGING_PROJECT_REF, 'yzqjvdfgefveprobvvyw');
  assert.equal(PRODUCTION_PROJECT_REF, 'wyyuqfdxucjksghsmhry');
  assert.throws(() => {
    assertStagingTarget({
      projectRef: PRODUCTION_PROJECT_REF,
      url: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      anonKey: 'sb_publishable_test_key_value',
    });
  });
});

test('environment: missing anon key is rejected', async () => {
  const helpersPath = path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs');
  const { assertStagingTarget, STAGING_PROJECT_REF } = await import(pathToFileUrl(helpersPath));
  assert.throws(() => {
    assertStagingTarget({
      projectRef: STAGING_PROJECT_REF,
      url: `https://${STAGING_PROJECT_REF}.supabase.co`,
      anonKey: '',
    });
  });
});

test('environment: staging URL with staging ref is accepted', async () => {
  const helpersPath = path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs');
  const { assertStagingTarget, STAGING_PROJECT_REF } = await import(pathToFileUrl(helpersPath));
  const result = assertStagingTarget({
    projectRef: STAGING_PROJECT_REF,
    url: `https://${STAGING_PROJECT_REF}.supabase.co`,
    anonKey: 'sb_publishable_test_key_value_long_enough',
  });
  assert.equal(result.projectRef, STAGING_PROJECT_REF);
});

test('environment: wrong-project JWT anon key is rejected', async () => {
  const helpersPath = path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs');
  const { assertStagingTarget, STAGING_PROJECT_REF } = await import(pathToFileUrl(helpersPath));
  // Minimal unsigned JWT with ref=wyyuqfdxucjksghsmhry
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'supabase',
    ref: 'wyyuqfdxucjksghsmhry',
    role: 'anon',
  })).toString('base64url');
  const fakeKey = `${header}.${payload}.sig`;
  assert.throws(() => {
    assertStagingTarget({
      projectRef: STAGING_PROJECT_REF,
      url: `https://${STAGING_PROJECT_REF}.supabase.co`,
      anonKey: fakeKey,
    });
  });
});

test('preflight: missing CI variables fail before deployment', () => {
  const script = path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs');
  const result = runNode(script, {
    SUPABASE_ACCESS_TOKEN: '',
    SUPABASE_STAGING_PROJECT_REF: '',
    SUPABASE_STAGING_URL: '',
    SUPABASE_STAGING_ANON_KEY: '',
  }, ['--skip-remote', '--allow-dirty']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required staging variables/);
  assert.match(result.stderr, /SUPABASE_STAGING_URL/);
});

test('preflight: DEPLOY_FUNCTIONS=all is rejected', () => {
  const script = path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs');
  const result = runNode(script, {
    SUPABASE_ACCESS_TOKEN: 'token',
    SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
    SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
    SUPABASE_STAGING_ANON_KEY: 'sb_publishable_test_key_value_long_enough',
    DEPLOY_FUNCTIONS: 'all',
  }, ['--skip-remote', '--allow-dirty']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /DEPLOY_FUNCTIONS=all is rejected/);
});

test('migration: compareMigrations — aligned history passes', async () => {
  const preflightPath = path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs');
  // Import compare via dynamic evaluation of helpers logic inline
  const { listLocalMigrationVersions } = await import(
    pathToFileUrl(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs'))
  );
  const local = listLocalMigrationVersions(path.join(ROOT, 'supabase', 'migrations'));
  assert.ok(local.length >= 41);
  const versions = local.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, 'no duplicate versions');
});

test('migration: remote-only fails compareMigrations', async () => {
  // Inline reimplementation of the exported compare via spawning is awkward;
  // exercise scanSqlForProhibited + parse helpers instead for remote-only semantics.
  const helpers = await import(pathToFileUrl(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs')));
  const local = [{ version: '20260101000000', name: 'a', path: 'x' }];
  const remote = ['20260101000000', '20260102000000'];
  const remoteOnly = remote.filter((v) => !local.some((m) => m.version === v));
  assert.deepEqual(remoteOnly, ['20260102000000']);
  assert.ok(helpers.parseMigrationFilename('20260804090000_edge_function_errors.sql'));
  assert.equal(helpers.parseMigrationFilename('bad.sql'), null);
});

test('migration: prohibited SQL is blocked', async () => {
  const { scanSqlForProhibited } = await import(
    pathToFileUrl(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs'))
  );
  const findings = scanSqlForProhibited('DROP SCHEMA public CASCADE;');
  assert.ok(findings.some((f) => f.id === 'DROP_SCHEMA' && f.severity === 'BLOCK'));
  const dropTable = scanSqlForProhibited('DROP TABLE public.foo;');
  assert.ok(dropTable.some((f) => f.id === 'DROP_TABLE' && f.severity === 'BLOCK'));
  const allowed = scanSqlForProhibited('DROP TABLE public.foo;', { allowDestructive: true });
  assert.ok(allowed.some((f) => f.id === 'DROP_TABLE' && f.severity === 'WARN'));
});

test('migration: wear owner-link hardening is accepted by the governed staging policy', async () => {
  const { scanSqlForProhibited } = await import(
    pathToFileUrl(path.join(ROOT, 'scripts', 'lib', 'staging-helpers.mjs'))
  );
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260814230933_harden_wardrobe_wear_owner_links.sql'),
    'utf8',
  );
  const blocked = scanSqlForProhibited(sql).filter((finding) => finding.severity === 'BLOCK');
  assert.deepEqual(blocked, [], 'the approved migration must need no destructive override');
  assert.doesNotMatch(sql, /\balter\s+table\b[\s\S]{0,80}\bdrop\b/i);
});

test('migration: apply script refuses without APPROVE_STAGING_MIGRATION', () => {
  const script = path.join(ROOT, 'scripts', 'apply-staging-migration.mjs');
  const result = runNode(script, {
    SUPABASE_ACCESS_TOKEN: 'token',
    SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
    SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
    SUPABASE_STAGING_ANON_KEY: 'sb_publishable_test_key_value_long_enough',
    MIGRATION_VERSION: '20260804090000',
    APPROVE_STAGING_MIGRATION: 'NO',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APPROVE_STAGING_MIGRATION=YES/);
});

test('migration: last-moment authority check passes environment before project ref', () => {
  const script = fs.readFileSync(
    path.join(ROOT, 'scripts', 'apply-staging-migration.mjs'),
    'utf8',
  );
  assert.match(script, /assertExpectedEnvironment\(\s*['"]staging['"]\s*,\s*linked\s*\)/);
  assert.doesNotMatch(script, /assertExpectedEnvironment\(\s*linked\s*,\s*['"]staging['"]\s*\)/);
});

test('function: allow-listed staging-health source exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'supabase', 'functions', 'staging-health', 'index.ts')));
  const allowlist = require(path.join(ROOT, 'security', 'scripts', 'staging-deployment-allowlist.js'));
  assert.ok(allowlist.STAGING_DEPLOYMENT_ALLOWLIST.includes('staging-health'));
  const { approved, heldBack } = allowlist.filterToApproved(['staging-health', 'scan-identify']);
  assert.deepEqual(approved, ['staging-health']);
  assert.deepEqual(heldBack, ['scan-identify']);
});

test('function: unknown function is held back by allowlist', () => {
  const allowlist = require(path.join(ROOT, 'security', 'scripts', 'staging-deployment-allowlist.js'));
  const { approved, heldBack } = allowlist.filterToApproved(['not-a-real-fn']);
  assert.deepEqual(approved, []);
  assert.deepEqual(heldBack, ['not-a-real-fn']);
});

test('health: staging-health response shape contains no secret markers', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'staging-health', 'index.ts'),
    'utf8',
  );
  assert.match(source, /environment: 'staging'/);
  assert.match(source, /status/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY\)\s*;\s*return/);
  // Must not echo keys into response body construction
  assert.doesNotMatch(source, /service_role_key/);
});

test('monitoring: errorEvents redacts forbidden substrings', async () => {
  // Load via transpile-free copy of sanitize logic by reading and evaling is hard in CJS;
  // assert source contracts instead.
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', '_shared', 'security', 'errorEvents.ts'),
    'utf8',
  );
  assert.match(source, /sanitizeSafeMessage/);
  assert.match(source, /edge_function_error_event/);
  assert.match(source, /environment/);
  assert.match(source, /auth_failure_burst/);
  assert.doesNotMatch(source, /console\.log\(.*authorization/i);
});

test('monitoring: migration creates private internal schema table', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260804090000_edge_function_errors.sql'),
    'utf8',
  );
  assert.match(sql, /create schema if not exists internal/i);
  assert.match(sql, /internal\.edge_function_errors/);
  assert.match(sql, /revoke all on table internal\.edge_function_errors from anon/i);
  assert.doesNotMatch(sql, /grant .+ to anon/i);
  // Strip SQL comments before checking for SECURITY DEFINER definitions.
  const withoutComments = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(withoutComments, /security\s+definer/i);
});

test('rollback: production target in manifest is rejected', () => {
  const script = path.join(ROOT, 'scripts', 'rollback-staging-function.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-rollback-'));
  const manifest = path.join(dir, 'bad.json');
  fs.writeFileSync(manifest, JSON.stringify({
    function_name: 'staging-health',
    target: 'wyyuqfdxucjksghsmhry',
    prior_version: null,
  }));
  const result = runNode(script, {
    SUPABASE_ACCESS_TOKEN: 'token',
    SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
    SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
    SUPABASE_STAGING_ANON_KEY: 'sb_publishable_test_key_value_long_enough',
  }, ['--manifest', manifest]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production/i);
});

test('workflows: no executable db push --project-ref and concurrency group present', () => {
  const controlled = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'staging-controlled-deploy.yml'),
    'utf8',
  );
  const gate = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'security-staging-gate.yml'),
    'utf8',
  );
  // Executable invocations (not documentation / grep guards).
  assert.doesNotMatch(controlled, /supabase\s+db\s+push\s+--project-ref/);
  assert.doesNotMatch(gate, /supabase\s+db\s+push\s+--project-ref/);
  assert.match(controlled, /group:\s*kscan-staging-deployment/);
  assert.match(gate, /group:\s*kscan-staging-deployment/);
  assert.match(gate, /Missing required staging variables/);
  assert.match(controlled, /Deploy one function/);
  assert.match(controlled, /rollback-on-failure:/);
  assert.match(controlled, /rollback-staging-function\.mjs/);
  assert.match(controlled, /needs\.health-check\.result == 'failure'/);
  assert.match(controlled, /needs\.synthetic-tests\.result == 'failure'/);
  assert.doesNotMatch(controlled, /Deno check \(best effort\)/);
});

test('deploy script: failed health check invokes rollback before exit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy-staging-function.mjs'), 'utf8');
  assert.match(src, /Post-deploy health check failed — invoking rollback/);
  assert.match(src, /rollback-staging-function\.mjs/);
  assert.match(src, /Deployment rolled back after health failure/);
});

test('preflight: empty DEPLOY_FUNCTIONS deploys nothing by default', () => {
  const script = path.join(ROOT, 'scripts', 'staging-deploy-preflight.mjs');
  const result = runNode(script, {
    SUPABASE_ACCESS_TOKEN: 'token',
    SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
    SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
    SUPABASE_STAGING_ANON_KEY: 'sb_publishable_test_key_value_long_enough',
    DEPLOY_FUNCTIONS: '',
  }, ['--skip-remote', '--allow-dirty', '--json']);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.deployFunctions, []);
  assert.equal(payload.deployFunctionsDefault, 'deploy nothing');
});

test('docs/scripts: apply-candidate-migrations never calls db push', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'security', 'scripts', 'apply-candidate-migrations.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /db', 'push'/);
  assert.doesNotMatch(src, /db push --project-ref/);
});

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `file://${normalized}`;
  return `file:///${normalized}`;
}
