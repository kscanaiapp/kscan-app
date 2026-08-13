#!/usr/bin/env node
'use strict';

/**
 * Regression tests for DEF-B29-SVV-012.
 *
 * The bootstrap migration_state gate compared manifest migration NAMES
 * ("apple_auth_credentials") against the live activation inventory, which
 * returns the Supabase CLI's `remote` field -- the VERSION applied to the
 * database ("20260810120000"). A name never equals a version, so with all 105
 * migrations genuinely live the gate reported all 105 missing and refused a
 * correct staging:
 *
 *   migration_state = BLOCKED
 *   MIGRATION_STATE_UNSATISFIED
 *   missing: profiles_base, profiles_privacy_status, ... apple_auth_credentials
 *
 * The pre-existing tests fed NAMES on both sides, so they agreed with each
 * other while disagreeing with the production wiring, which passes
 * `inventory.migrations` (versions). That is why the suite was green while the
 * real gate could never pass. These tests pin the identity explicitly:
 *
 *   EXPECTED MIGRATION IDENTIFIER = VERSION
 *   LIVE MIGRATION IDENTIFIER     = VERSION
 *
 * No network, no Supabase, no GitHub API.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const { STAGING_REF } = require('../../security/scripts/lib/environment-authority');
const { generateReleaseManifest } = require('../../security/release/generate-release-manifest');

const load = (rel) => import(`file://${path.join(REPO_ROOT, rel).split(path.sep).join('/')}`);

const BASE = Object.freeze({
  repoRoot: REPO_ROOT,
  releaseId: 'rel-svv012-test',
  sourceSha: 'a'.repeat(40),
  sourceTreeSha: 'b'.repeat(40),
  candidateEnvironment: 'staging',
  candidateProjectRef: STAGING_REF,
  createdAt: '2026-08-12T00:00:00.000Z',
  env: {},
});

const manifest = () => generateReleaseManifest(BASE);
const liveFunctions = (m) => m.edgeFunctions.map((f) => f.name);

/** Runs PLAN_ONLY with deploy adapters that throw, so nothing can mutate. */
async function planOnly({ m, liveMigrationVersions }) {
  const { runBootstrapActivation, MODE } = await load('security/release/run-bootstrap-activation.mjs');
  return runBootstrapActivation({
    repoRoot: REPO_ROOT,
    mode: MODE.PLAN_ONLY,
    liveFunctionNames: liveFunctions(m),
    liveMigrationVersions,
    deps: {
      deployFn: () => { throw new Error('PLAN_ONLY must not deploy'); },
      setMetadata: () => ({ plan: { keys: [] } }),
      github: { createTag: () => { throw new Error('PLAN_ONLY must not tag'); } },
    },
  });
}

const migrationStep = (result) => result.steps.find((s) => s.name === 'migration_state');

test('SVV-012: the manifest carries an explicit canonical version for every migration', () => {
  const m = manifest();
  assert.ok(m.migrations.length > 0);
  for (const entry of m.migrations) {
    assert.match(entry.version, /^\d{12,14}$/, `${entry.name} must carry a canonical numeric version`);
    assert.notEqual(entry.version, entry.name, 'version and name are distinct identities');
  }
});

test('SVV-012: exact version parity satisfies migration_state', async () => {
  const m = manifest();
  const result = await planOnly({ m, liveMigrationVersions: m.migrations.map((x) => x.version) });
  const step = migrationStep(result);
  assert.equal(step.status, 'PASS', JSON.stringify(step));
  assert.match(step.detail, /satisfied/);
});

test('SVV-012: the full Build 29 candidate reports 106 expected, 106 live, 0 missing', async () => {
  const m = manifest();
  // 106 since the Build 29 deletion closeout added
  // 20260813222000_backfill_legacy_pending_deletion_requests. The count is
  // pinned deliberately: this gate exists because a name/version confusion once
  // reported every live migration as missing, so an unexplained change in the
  // total is exactly what it is meant to catch.
  assert.equal(m.migrations.length, 106, 'the Build 29 candidate carries 106 migrations');
  const result = await planOnly({ m, liveMigrationVersions: m.migrations.map((x) => x.version) });
  const step = migrationStep(result);
  assert.equal(step.status, 'PASS');
  assert.equal(step.detail, '106 satisfied');
});

test('SVV-012: a missing migration blocks and names the missing VERSION', async () => {
  const m = manifest();
  const omitted = m.migrations[1];
  const live = m.migrations.filter((x) => x.version !== omitted.version).map((x) => x.version);

  const result = await planOnly({ m, liveMigrationVersions: live });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MIGRATION_STATE_UNSATISFIED');
  assert.equal(migrationStep(result).status, 'BLOCKED');
  assert.ok(
    result.missingMigrations.includes(omitted.version),
    'the missing entry must be reported by version, the canonical identity',
  );
  assert.equal(result.missingMigrations.length, 1, 'exactly one migration is missing');
});

test('SVV-012: a live migration NAME does not satisfy a candidate VERSION', async () => {
  // The exact shape of the defect: apple_auth_credentials is version
  // 20260810120000. Supplying the name as if it were the live identity must not
  // be accepted, or the gate would pass on a database that never ran it.
  const m = manifest();
  const apple = m.migrations.find((x) => x.name === 'apple_auth_credentials');
  assert.ok(apple, 'the Build 29 candidate includes apple_auth_credentials');
  assert.equal(apple.version, '20260810120000');

  const namesAsLive = m.migrations.map((x) => x.name);
  const byName = await planOnly({ m, liveMigrationVersions: namesAsLive });
  assert.equal(byName.ok, false, 'names must not satisfy version identity');
  assert.equal(byName.code, 'MIGRATION_STATE_UNSATISFIED');
  assert.ok(byName.missingMigrations.includes(apple.version));

  const versionsAsLive = m.migrations.map((x) => x.version);
  const byVersion = await planOnly({ m, liveMigrationVersions: versionsAsLive });
  assert.equal(migrationStep(byVersion).status, 'PASS', 'versions must satisfy');
});

test('SVV-012: extra live migrations do not block -- the existing policy is preserved', async () => {
  // Staging legitimately carries website-heritage objects the candidate does
  // not know about. The gate asks only whether every CANDIDATE migration is
  // live; it has never treated surplus live migrations as candidate drift, and
  // this fix must not change that.
  const m = manifest();
  const live = [...m.migrations.map((x) => x.version), '19990101000000', '19990101000001'];
  const result = await planOnly({ m, liveMigrationVersions: live });
  assert.equal(migrationStep(result).status, 'PASS');
  assert.equal(result.ok, true, JSON.stringify(result.steps));
});

test('SVV-012: an empty live inventory still blocks rather than passing vacuously', async () => {
  const m = manifest();
  const result = await planOnly({ m, liveMigrationVersions: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MIGRATION_STATE_UNSATISFIED');
  assert.equal(result.missingMigrations.length, m.migrations.length);
});

test('SVV-012: the exact-candidate verifier also compares by version', async () => {
  // The same liveMigration* input feeds verify-exact-candidate, which had the
  // identical name-vs-version comparison. Its source is asserted here because
  // a full verification run needs a frozen record and receipt; the behavioural
  // coverage lives in releaseVerification.test.js, which now feeds versions.
  const fs = require('node:fs');
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'security', 'release', 'verify-exact-candidate.js'),
    'utf8',
  );
  assert.match(src, /\.map\(\(m\) => m\.version\)/, 'expected side must use version');
  assert.match(src, /new Set\(liveMigrationVersions\)/, 'live side must be versions');
  assert.doesNotMatch(src, /liveMigrationNames/, 'the misleading name must be gone');
  // Extra live migrations stay a reported limitation, never a failure.
  assert.match(src, /staging carries \$\{extra\.length\} migration\(s\) not in the candidate manifest/);
});
