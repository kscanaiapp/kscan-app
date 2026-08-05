#!/usr/bin/env node
'use strict';

/**
 * Production-write safety gate for the in-place K Scan AI Staging rebuild.
 *
 * These tests prove that EVERY write-capable entry point rejects the production
 * project reference, rejects any reference outside the staging allow-list, fails
 * closed on a missing/unresolved target, and never infers a target from the
 * currently linked Supabase project.
 *
 * They also prove the Waitlist and website privacy tables cannot be dropped,
 * truncated, deleted from, altered, or updated by a rebuild statement — even when
 * the target project itself is correctly authorized.
 *
 * Pure process-level tests: each guarded script is spawned for real, so a future
 * refactor that bypasses the guard fails here rather than against staging.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_REF = 'yzqjvdfgefveprobvvyw';
/** A syntactically valid but unauthorized reference. */
const FOREIGN_REF = 'abcdefghijklmnopqrst';

const guardUrl = pathToFileURL(path.join(ROOT, 'scripts/lib/staging-v2-guard.mjs')).href;
const loadGuard = () => import(guardUrl);

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
    name: 'scoped schema rebuild',
    script: 'scripts/staging-v2/rebuild-app-schema.mjs',
    args: (ref) => ['--project-ref', ref, '--confirm', `REBUILD-${STAGING_REF}`, '--dry-run'],
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
      SUPABASE_STAGING_PROJECT_REF: '',
      ...env,
    },
  });
}

const combined = (result) => `${result.stdout || ''}${result.stderr || ''}`;

/** Strip `--project-ref <ref>` so the entry point is invoked with no target. */
function withoutTarget(args) {
  return args.filter((a, i, arr) => a !== '--project-ref' && arr[i - 1] !== '--project-ref');
}

for (const entry of WRITE_ENTRY_POINTS) {
  test(`${entry.name}: rejects the production project reference`, () => {
    const result = run(entry.script, entry.args(PRODUCTION_REF));
    assert.notEqual(result.status, 0, `${entry.script} must not succeed against production`);
    assert.match(combined(result), /PRODUCTION_WRITE_REJECTED/);
    assert.match(combined(result), new RegExp(PRODUCTION_REF));
  });

  test(`${entry.name}: rejects a project outside the staging allow-list`, () => {
    const result = run(entry.script, entry.args(FOREIGN_REF));
    assert.notEqual(result.status, 0, `${entry.script} must only ever target ${STAGING_REF}`);
    assert.match(combined(result), /WRITE_TARGET_NOT_ALLOWED/);
  });

  test(`${entry.name}: fails closed when no target is supplied`, () => {
    const result = run(entry.script, withoutTarget(entry.args('')));
    assert.notEqual(result.status, 0, `${entry.script} must fail closed without a target`);
    assert.match(combined(result), /TARGET_MISSING/);
  });

  test(`${entry.name}: rejects an unresolvable target reference`, () => {
    const result = run(entry.script, entry.args('not-a-project-ref'));
    assert.notEqual(result.status, 0);
    assert.match(combined(result), /TARGET_UNRESOLVED/);
  });

  test(`${entry.name}: does not infer a target from the linked project`, () => {
    // SUPABASE_PROJECT_ID / SUPABASE_PROJECT_REF / SUPABASE_DB_URL are what
    // `supabase link` and CI conventionally set. None may be honoured as a target.
    const result = run(entry.script, withoutTarget(entry.args('')), {
      SUPABASE_PROJECT_ID: PRODUCTION_REF,
      SUPABASE_PROJECT_REF: PRODUCTION_REF,
      SUPABASE_DB_URL: `postgresql://postgres@db.${PRODUCTION_REF}.supabase.co:5432/postgres`,
    });
    assert.notEqual(result.status, 0, `${entry.script} must ignore linked-project variables`);
    assert.match(combined(result), /TARGET_MISSING/);
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

test('ZAP target validation accepts the staging URL', () => {
  const result = run('scripts/staging-v2/validate-target.mjs', [
    '--operation',
    'zap-target',
    '--target-url',
    `https://${STAGING_REF}.supabase.co`,
  ]);
  assert.equal(result.status, 0, combined(result));
  assert.match(combined(result), new RegExp(`zap-target -> ${STAGING_REF}`));
});

/** assert.throws matches on `message`; the guard carries its reason on `code`. */
function hasCode(...codes) {
  return (err) => {
    assert.equal(err.name, 'TargetRejectedError');
    assert.ok(codes.includes(err.code), `expected code in ${codes.join('|')}, got ${err.code}`);
    return true;
  };
}

test('the write allow-list contains staging and nothing else', async () => {
  const guard = await loadGuard();
  assert.deepEqual([...guard.WRITE_ALLOW_LIST], [STAGING_REF]);
  assert.ok(!guard.WRITE_ALLOW_LIST.includes(PRODUCTION_REF));
});

test('production remains readable for parity comparison but never writable', async () => {
  const guard = await loadGuard();
  assert.equal(
    guard.assertReadOnlyTarget('parity-compare', PRODUCTION_REF, null).projectRef,
    PRODUCTION_REF,
  );
  assert.throws(
    () => guard.assertStagingWriteTarget('parity-compare', PRODUCTION_REF, null),
    hasCode('PRODUCTION_WRITE_REJECTED'),
  );
});

test('scoped rebuild requires typed confirmation bound to the staging ref', async () => {
  const guard = await loadGuard();
  assert.equal(guard.RESET_CONFIRMATION_PHRASE, `REBUILD-${STAGING_REF}`);
  assert.throws(
    () =>
      guard.assertRebuildAuthorized({
        projectRef: STAGING_REF,
        confirmation: 'yes',
        protectedBackupVerified: true,
      }),
    hasCode('REBUILD_CONFIRMATION_MISSING'),
  );
});

test('scoped rebuild refuses to run without a verified protected-table backup', async () => {
  const guard = await loadGuard();
  assert.throws(
    () =>
      guard.assertRebuildAuthorized({
        projectRef: STAGING_REF,
        confirmation: `REBUILD-${STAGING_REF}`,
        protectedBackupVerified: false,
      }),
    hasCode('PROTECTED_BACKUP_UNVERIFIED'),
  );
  assert.doesNotThrow(() =>
    guard.assertRebuildAuthorized({
      projectRef: STAGING_REF,
      confirmation: `REBUILD-${STAGING_REF}`,
      protectedBackupVerified: true,
      logger: null,
    }),
  );
});

test('scoped rebuild confirmation cannot be replayed against production', async () => {
  const guard = await loadGuard();
  assert.throws(
    () =>
      guard.assertRebuildAuthorized({
        projectRef: PRODUCTION_REF,
        confirmation: `REBUILD-${STAGING_REF}`,
        protectedBackupVerified: true,
      }),
    hasCode('PRODUCTION_WRITE_REJECTED'),
  );
});

/* ---------------------------------------------------------------------- */
/* Waitlist / website privacy protection                                    */
/* ---------------------------------------------------------------------- */

test('protected table list covers the Waitlist and website privacy tables', async () => {
  const guard = await loadGuard();
  assert.deepEqual(
    [...guard.PROTECTED_TABLES].sort(),
    ['public.waitlist_signups', 'public.website_sale_share_opt_out_requests'],
  );
});

const DESTRUCTIVE_STATEMENTS = [
  'drop table public.waitlist_signups;',
  'DROP TABLE IF EXISTS waitlist_signups CASCADE;',
  'truncate table public.waitlist_signups;',
  'TRUNCATE waitlist_signups;',
  'delete from public.waitlist_signups where true;',
  'alter table public.waitlist_signups drop column email;',
  "update waitlist_signups set email = 'x';",
  'drop table public.website_sale_share_opt_out_requests;',
  'truncate public.website_sale_share_opt_out_requests;',
  'delete from website_sale_share_opt_out_requests;',
  'DROP TABLE "waitlist_signups";',
];

for (const sql of DESTRUCTIVE_STATEMENTS) {
  test(`protected-table guard blocks: ${sql.slice(0, 52)}`, async () => {
    const guard = await loadGuard();
    assert.throws(
      () => guard.assertDoesNotTouchProtectedTables(sql, { operation: 'test' }),
      hasCode('PROTECTED_TABLE_TOUCHED'),
    );
  });
}

test('protected-table guard permits statements on unrelated app tables', async () => {
  const guard = await loadGuard();
  assert.ok(
    guard.assertDoesNotTouchProtectedTables(
      'drop table if exists public.style_chat_messages cascade;\n' +
        'truncate table public.product_catalog;\n' +
        'alter table public.profiles add column display_name text;',
      { operation: 'test' },
    ),
  );
});

test('scoped rebuild plan in source control never touches protected tables', async () => {
  const fs = require('node:fs');
  const guard = await loadGuard();
  const planPath = path.join(ROOT, 'supabase/staging-v2/rebuild-plan.sql');
  if (!fs.existsSync(planPath)) return; // plan is authored later in the phase
  assert.ok(
    guard.assertDoesNotTouchProtectedTables(fs.readFileSync(planPath, 'utf8'), {
      operation: 'rebuild-plan',
    }),
  );
});
