#!/usr/bin/env node
'use strict';

/**
 * Production-write safety gate for the Staging v2 rebuild.
 *
 * These tests are the enforcement half of Phase 1 Step 1. They prove that EVERY
 * write-capable entry point rejects the production project reference, rejects the
 * preserved old staging reference, fails closed on a missing/unresolved target,
 * and never infers a target from the currently linked Supabase project.
 *
 * Pure process-level tests: each guarded script is spawned for real, so a future
 * refactor that bypasses the guard fails here rather than in production.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const OLD_STAGING_REF = 'yzqjvdfgefveprobvvyw';

/**
 * Every write-capable operation named in the Phase 1 brief, plus the two
 * validator-shaped ones (manual workflow dispatch, future ZAP target).
 */
const WRITE_ENTRY_POINTS = [
  {
    name: 'migration application',
    script: 'scripts/staging-v2/apply-migrations.mjs',
    args: (ref) => ['--project-ref', ref, '--dry-run'],
  },
  {
    name: 'Edge Function deployment',
    script: 'scripts/staging-v2/deploy-function.mjs',
    args: (ref) => ['--project-ref', ref, '--function', 'scan-identify', '--dry-run'],
  },
  {
    name: 'Storage configuration',
    script: 'scripts/staging-v2/configure-storage.mjs',
    args: (ref) => ['--project-ref', ref, '--dry-run'],
  },
  {
    name: 'staging seed execution',
    script: 'scripts/staging-v2/seed-fixtures.mjs',
    args: (ref) => ['--project-ref', ref, '--dry-run'],
  },
  {
    name: 'project reset',
    script: 'scripts/staging-v2/reset-project.mjs',
    args: (ref) => ['--project-ref', ref, '--confirm', 'RESET-STAGING-V2', '--dry-run'],
  },
  {
    name: 'manual workflow dispatch',
    script: 'scripts/staging-v2/validate-target.mjs',
    args: (ref) => ['--operation', 'workflow-dispatch', '--project-ref', ref],
  },
  {
    name: 'ZAP target validation',
    script: 'scripts/staging-v2/validate-target.mjs',
    args: (ref) => ['--operation', 'zap-target', '--project-ref', ref],
  },
];

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Cleared so a stray developer variable cannot make a rejection test pass
      // for the wrong reason.
      SUPABASE_STAGING_V2_PROJECT_REF: '',
      ...env,
    },
  });
}

function combined(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

for (const entry of WRITE_ENTRY_POINTS) {
  test(`${entry.name}: rejects the production project reference`, () => {
    const result = run(entry.script, entry.args(PRODUCTION_REF));
    assert.notEqual(result.status, 0, `${entry.script} must not succeed against production`);
    assert.match(combined(result), /PRODUCTION_WRITE_REJECTED/);
    assert.match(combined(result), new RegExp(PRODUCTION_REF));
  });

  test(`${entry.name}: rejects the preserved old staging reference`, () => {
    const result = run(entry.script, entry.args(OLD_STAGING_REF));
    assert.notEqual(result.status, 0, `${entry.script} must not write to old staging`);
    assert.match(combined(result), /OLD_STAGING_WRITE_REJECTED/);
  });

  test(`${entry.name}: fails closed when no target is supplied`, () => {
    const args = entry.args('').filter((a, i, arr) => {
      if (a === '--project-ref') return false;
      return arr[i - 1] !== '--project-ref';
    });
    const result = run(entry.script, args);
    assert.notEqual(result.status, 0, `${entry.script} must fail closed without a target`);
    assert.match(combined(result), /TARGET_MISSING|WRITE_ALLOW_LIST_EMPTY/);
  });

  test(`${entry.name}: rejects an unresolvable target reference`, () => {
    const result = run(entry.script, entry.args('not-a-project-ref'));
    assert.notEqual(result.status, 0);
    assert.match(combined(result), /TARGET_UNRESOLVED/);
  });

  test(`${entry.name}: does not infer a target from the linked project`, () => {
    // SUPABASE_PROJECT_ID / SUPABASE_PROJECT_REF are what `supabase link` and CI
    // conventionally set. None of them may be honoured as a target.
    const args = entry.args('').filter((a, i, arr) => {
      if (a === '--project-ref') return false;
      return arr[i - 1] !== '--project-ref';
    });
    const result = run(entry.script, args, {
      SUPABASE_PROJECT_ID: PRODUCTION_REF,
      SUPABASE_PROJECT_REF: PRODUCTION_REF,
      SUPABASE_DB_URL: `postgresql://postgres@db.${PRODUCTION_REF}.supabase.co:5432/postgres`,
    });
    assert.notEqual(result.status, 0, `${entry.script} must ignore linked-project variables`);
    assert.match(combined(result), /TARGET_MISSING|WRITE_ALLOW_LIST_EMPTY/);
  });
}

test('ZAP target validation rejects a production URL, not just a bare ref', () => {
  const result = run('scripts/staging-v2/validate-target.mjs', [
    '--operation',
    'zap-target',
    '--target-url',
    `https://${PRODUCTION_REF}.supabase.co`,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(combined(result), /PRODUCTION_WRITE_REJECTED/);
});

/** assert.throws matches on `message`; the guard carries its reason on `code`. */
function hasCode(...codes) {
  return (err) => {
    assert.equal(err.name, 'TargetRejectedError');
    assert.ok(codes.includes(err.code), `expected code in ${codes.join('|')}, got ${err.code}`);
    return true;
  };
}

test('reset requires typed confirmation even for an allow-listed target', async () => {
  const guard = await import(
    require('node:url').pathToFileURL(path.join(ROOT, 'scripts/lib/staging-v2-guard.mjs')).href
  );
  const ref = guard.STAGING_V2_PROJECT_REF;
  if (!ref) {
    // Allow-list not yet seeded: the reset path must still fail closed.
    assert.throws(
      () =>
        guard.assertResetAuthorized({
          projectRef: 'aaaaaaaaaaaaaaaaaaaa',
          confirmation: 'RESET-STAGING-V2',
        }),
      hasCode('WRITE_TARGET_NOT_ALLOWED', 'WRITE_ALLOW_LIST_EMPTY'),
    );
    return;
  }
  assert.throws(
    () => guard.assertResetAuthorized({ projectRef: ref, confirmation: 'yes' }),
    hasCode('RESET_CONFIRMATION_MISSING'),
  );
  assert.doesNotThrow(() =>
    guard.assertResetAuthorized({ projectRef: ref, confirmation: 'RESET-STAGING-V2', logger: null }),
  );
});

test('production and old staging remain readable for comparison tooling', async () => {
  const guard = await import(
    require('node:url').pathToFileURL(path.join(ROOT, 'scripts/lib/staging-v2-guard.mjs')).href
  );
  assert.equal(
    guard.assertReadOnlyTarget('parity-compare', PRODUCTION_REF, null).projectRef,
    PRODUCTION_REF,
  );
  assert.equal(
    guard.assertReadOnlyTarget('reference-inspect', OLD_STAGING_REF, null).projectRef,
    OLD_STAGING_REF,
  );
  // …but a read-only allowance never grants write authority.
  assert.throws(
    () => guard.assertStagingV2WriteTarget('parity-compare', PRODUCTION_REF, null),
    hasCode('PRODUCTION_WRITE_REJECTED'),
  );
  assert.throws(
    () => guard.assertStagingV2WriteTarget('reference-inspect', OLD_STAGING_REF, null),
    hasCode('OLD_STAGING_WRITE_REJECTED'),
  );
});

test('the write allow-list never contains production or old staging', async () => {
  const guard = await import(
    require('node:url').pathToFileURL(path.join(ROOT, 'scripts/lib/staging-v2-guard.mjs')).href
  );
  assert.ok(!guard.WRITE_ALLOW_LIST.includes(PRODUCTION_REF));
  assert.ok(!guard.WRITE_ALLOW_LIST.includes(OLD_STAGING_REF));
});
