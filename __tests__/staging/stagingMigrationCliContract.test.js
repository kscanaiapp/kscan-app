#!/usr/bin/env node
'use strict';

/**
 * Regression tests for DEF-B29-SVV-007.
 *
 * `scripts/apply-staging-migration.mjs` read the remote migration ledger with
 * `supabase db query ... --output-format json` and parsed `.rows`. Against the
 * pinned CLI (2.109.1) that is wrong three ways: `db query` has no
 * `--output-format` flag (silently ignored), its envelope is `{_tag, ...}` and
 * never `{rows}`, and it exits 0 even when the query fails outright.
 *
 * The observable damage was twofold:
 *   - every remote lookup answered "nothing found", so all 105 local
 *     migrations were reported pending and the governed single-migration
 *     apply could never run;
 *   - the "already recorded — refusing re-apply" guard was silently inert,
 *     and a failed SQL apply would still be booked into the ledger by
 *     `migration repair --status applied`.
 *
 * These tests drive the real script with a stubbed `supabase` on PATH — no
 * network, no credentials, no staging contact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'apply-staging-migration.mjs');
const TARGET_VERSION = '20260810120000';

function localVersions() {
  return fs
    .readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.split('_')[0])
    .sort();
}

/**
 * Writes a fake `supabase` executable that answers from a scripted scenario and
 * appends every invocation to a log the test can assert against.
 */
function makeStub(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-supabase-stub-'));
  const logPath = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario), 'utf8');

  fs.writeFileSync(
    path.join(dir, 'stub.js'),
    `
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, 'calls.log'), args.join(' ') + '\\n');

if (args[0] === 'link') process.exit(0);

if (args[0] === 'migration' && args[1] === 'list') {
  process.stdout.write(scenario.migrationList);
  process.exit(scenario.migrationListExit || 0);
}

if (args[0] === 'migration' && args[1] === 'repair') process.exit(0);

if (args[0] === 'db' && args[1] === 'query') {
  process.stdout.write(scenario.dbQuery || '');
  // The real CLI exits 0 even on failure — reproduce that faithfully.
  process.exit(0);
}

process.exit(0);
`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(dir, 'supabase'),
    `#!/bin/sh\nexec node "$(dirname "$0")/stub.js" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, 'supabase.cmd'), `@echo off\r\nnode "%~dp0stub.js" %*\r\n`, 'utf8');

  return { dir, logPath };
}

function runScript(stubDir) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      Path: `${stubDir}${path.delimiter}${process.env.PATH}`,
      SUPABASE_ACCESS_TOKEN: 'stub-token',
      SUPABASE_STAGING_PROJECT_REF: 'yzqjvdfgefveprobvvyw',
      SUPABASE_STAGING_URL: 'https://yzqjvdfgefveprobvvyw.supabase.co',
      SUPABASE_STAGING_ANON_KEY: 'sb_publishable_test_key_value',
      MIGRATION_VERSION: TARGET_VERSION,
      APPROVE_STAGING_MIGRATION: 'YES',
    },
  });
}

/** `migration list --linked --output-format json` shape: [{local, remote, name}] */
function ledger(remoteVersions) {
  return JSON.stringify(
    localVersions().map((v) => ({
      local: v,
      remote: remoteVersions.includes(v) ? v : '',
      name: 'stub',
    })),
  );
}

test('DEF-B29-SVV-007: remote state is read from the migration ledger, not `db query`', () => {
  // Everything except the target is already applied — the real staging shape.
  const remote = localVersions().filter((v) => v !== TARGET_VERSION);
  const { dir, logPath } = makeStub({ migrationList: ledger(remote), dbQuery: '' });
  runScript(dir);

  const calls = fs.readFileSync(logPath, 'utf8');
  assert.match(calls, /migration list --linked --output-format json/, 'must read the ledger');

  // No SELECT against schema_migrations may be issued through `db query`, and
  // `--output-format` must never be passed to a subcommand that ignores it.
  for (const line of calls.split('\n')) {
    if (line.startsWith('db query')) {
      assert.doesNotMatch(line, /schema_migrations/, '`db query` must not read remote state');
      assert.doesNotMatch(line, /--output-format/, '`db query` has no --output-format flag');
    }
  }
});

test('DEF-B29-SVV-007: an already-applied version is refused rather than re-applied', () => {
  // The guard was inert before the fix: remote lookups always returned nothing.
  const { dir, logPath } = makeStub({ migrationList: ledger(localVersions()), dbQuery: '' });
  const res = runScript(dir);

  assert.notEqual(res.status, 0, 'must refuse');
  assert.match(`${res.stdout}${res.stderr}`, /already recorded on staging/);
  assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /db query --linked -f/, 'must not apply SQL');
});

test('DEF-B29-SVV-007: an unreadable ledger fails closed instead of looking empty', () => {
  const { dir, logPath } = makeStub({ migrationList: '{"unexpected":"shape"}', dbQuery: '' });
  const res = runScript(dir);

  assert.notEqual(res.status, 0, 'must fail closed');
  assert.match(`${res.stdout}${res.stderr}`, /unexpected shape|refusing to guess/i);
  assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /db query --linked -f/, 'must not apply SQL');
});

test('DEF-B29-SVV-007: a failed SQL apply is never booked into the ledger', () => {
  // The CLI exits 0 on failure. Without the envelope guard the script would
  // call `migration repair --status applied` for SQL that never ran, and
  // post-apply verification would then read its own write back and pass.
  const remote = localVersions().filter((v) => v !== TARGET_VERSION);
  const { dir, logPath } = makeStub({
    migrationList: ledger(remote),
    dbQuery: JSON.stringify({
      _tag: 'Error',
      error: { code: 'LegacyDbConnectError', message: 'failed to connect to postgres' },
    }),
  });
  const res = runScript(dir);

  assert.notEqual(res.status, 0, 'a failed apply must fail the script');
  assert.doesNotMatch(
    fs.readFileSync(logPath, 'utf8'),
    /migration repair/,
    'a migration whose SQL failed must never be recorded as applied',
  );
});
