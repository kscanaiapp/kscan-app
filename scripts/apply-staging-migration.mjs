#!/usr/bin/env node
/**
 * Apply exactly one approved migration to K Scan AI Staging.
 *
 * Never uses blanket `db push`, `db reset`, or `migration up`.
 * Records the applied version via `migration repair --status applied --linked`
 * only as the intentional counterpart to a successful SQL apply (not for drift repair).
 *
 * Required env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_STAGING_PROJECT_REF=yzqjvdfgefveprobvvyw
 *   SUPABASE_STAGING_URL
 *   SUPABASE_STAGING_ANON_KEY
 *   MIGRATION_VERSION
 *   APPROVE_STAGING_MIGRATION=YES
 *
 * Optional:
 *   MIGRATION_FILE (defaults to matching file under supabase/migrations/)
 *   ALLOW_DESTRUCTIVE_MIGRATION=YES (required for DROP TABLE / destructive ALTER)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  assertStagingTarget,
  missingRequiredVars,
  listLocalMigrationVersions,
  parseMigrationFilename,
  scanSqlForProhibited,
  sha256File,
  runSupabase,
  writeJsonArtifact,
  ensureArtifactsDir,
  gitHeadSha,
  STAGING_PROJECT_REF,
  fail,
} from './lib/staging-helpers.mjs';

function requireApproval() {
  if (String(process.env.APPROVE_STAGING_MIGRATION || '').toUpperCase() !== 'YES') {
    fail('Set APPROVE_STAGING_MIGRATION=YES to apply a staging migration');
  }
}

function resolveMigrationFile(version, explicitPath) {
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    if (!fs.existsSync(abs)) fail(`Migration file not found: ${abs}`);
    const parsed = parseMigrationFilename(abs);
    if (!parsed) fail(`Migration filename does not match required pattern: ${path.basename(abs)}`);
    if (parsed.version !== version) {
      fail(`Filename version ${parsed.version} does not equal MIGRATION_VERSION ${version}`);
    }
    return { ...parsed, path: abs };
  }

  const local = listLocalMigrationVersions();
  const match = local.find((m) => m.version === version);
  if (!match) fail(`No local migration file for version ${version}`);
  return match;
}

function remoteHasVersion(version) {
  const sql = `select version, name from supabase_migrations.schema_migrations where version = '${version}'`;
  const out = runSupabase(['db', 'query', sql, '--linked', '--output-format', 'json']);
  const parsed = JSON.parse(out);
  return (parsed.rows || []).length > 0;
}

function listRemoteVersions() {
  const sql = 'select version from supabase_migrations.schema_migrations order by version';
  const out = runSupabase(['db', 'query', sql, '--linked', '--output-format', 'json']);
  const parsed = JSON.parse(out);
  return (parsed.rows || []).map((r) => String(r.version));
}

function main() {
  const missing = missingRequiredVars();
  if (missing.length) {
    console.error('Missing required staging variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  requireApproval();
  let identity;
  try {
    identity = assertStagingTarget();
  } catch (err) {
    fail(err.message);
  }
  const version = String(process.env.MIGRATION_VERSION || '').trim();
  if (!/^\d{12,14}$/.test(version)) fail('MIGRATION_VERSION must be a 12-14 digit migration version');

  const migration = resolveMigrationFile(version, process.env.MIGRATION_FILE);
  const hash = sha256File(migration.path);
  const sql = fs.readFileSync(migration.path, 'utf8');
  const allowDestructive = String(process.env.ALLOW_DESTRUCTIVE_MIGRATION || '').toUpperCase() === 'YES';
  const findings = scanSqlForProhibited(sql, { allowDestructive });
  const blocked = findings.filter((f) => f.severity === 'BLOCK');
  if (blocked.length) {
    fail(`Migration blocked by prohibited SQL patterns: ${blocked.map((f) => f.id).join(', ')}`);
  }

  runSupabase(['link', '--project-ref', STAGING_PROJECT_REF, '--yes']);

  if (remoteHasVersion(version)) {
    fail(`Version ${version} is already recorded on staging — refusing re-apply`);
  }

  const local = listLocalMigrationVersions();
  const remote = listRemoteVersions();
  const remoteSet = new Set(remote);
  const pending = local.filter((m) => !remoteSet.has(m.version));
  if (pending.length !== 1 || pending[0].version !== version) {
    fail(
      `Expected exactly one approved pending migration ${version}; pending=[${pending.map((p) => p.version).join(', ')}]`,
    );
  }

  console.log(JSON.stringify({
    phase: 'pre-apply',
    target: identity.projectRef,
    version,
    name: migration.name,
    path: migration.path,
    sha256: hash,
    findings,
  }, null, 2));

  try {
    runSupabase(['db', 'query', '--linked', '-f', migration.path]);
  } catch (err) {
    fail(`SQL apply failed: ${err.message}`);
  }

  // Intentional history record for the SQL just applied — not a drift-repair operation.
  try {
    runSupabase(['migration', 'repair', version, '--status', 'applied', '--linked']);
  } catch (err) {
    fail(`Failed to record applied migration version ${version}: ${err.message}`);
  }

  if (!remoteHasVersion(version)) {
    fail(`Post-apply verification failed: version ${version} not present in schema_migrations`);
  }

  const afterRemote = listRemoteVersions();
  const afterLocal = listLocalMigrationVersions().map((m) => m.version);
  const remoteOnly = afterRemote.filter((v) => !afterLocal.includes(v));
  const localOnly = afterLocal.filter((v) => !afterRemote.includes(v));

  const artifact = {
    timestamp: new Date().toISOString(),
    commit: gitHeadSha(),
    target: STAGING_PROJECT_REF,
    version,
    name: migration.name,
    sha256: hash,
    path: migration.path,
    localCount: afterLocal.length,
    remoteCount: afterRemote.length,
    remoteOnly,
    localOnly,
    outcome: remoteOnly.length === 0 && localOnly.length === 0 ? 'ALIGNED' : 'ALIGNED_WITH_PENDING',
  };

  const dir = ensureArtifactsDir('staging-migrations');
  const artifactPath = path.join(dir, `${version}-${migration.name}.json`);
  writeJsonArtifact(artifactPath, artifact);

  console.log(JSON.stringify({ ok: true, artifact: artifactPath, ...artifact }, null, 2));

  if (remoteOnly.length > 0) process.exit(1);
}

main();
