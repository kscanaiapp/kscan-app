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

/**
 * `supabase db query` cannot be used to READ remote state on the pinned CLI
 * (2.109.1) — DEF-B29-SVV-007. Three independent reasons, all verified against
 * the real binary:
 *
 *   1. `db query` has no `--output-format` flag. Passing it is silently
 *      ignored, so the caller never learns the request was malformed.
 *   2. Its envelope is `{_tag, error|result}`, never `{rows}`. Reading
 *      `parsed.rows` therefore always yielded `undefined`.
 *   3. Decisively: it exits 0 even when the query fails to connect.
 *
 * Together those made every remote lookup answer "nothing found" on any
 * failure — which reported all 105 local migrations as pending AND silently
 * disarmed the already-applied re-apply guard. Remote state is now read
 * through the one contract this CLI actually documents and that the release
 * bootstrap already relies on: `migration list --linked --output-format json`.
 */
function listRemoteVersions() {
  const out = runSupabase(['migration', 'list', '--linked', '--output-format', 'json']);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (err) {
    fail(`Could not parse the remote migration ledger as JSON: ${err.message}`);
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.migrations;
  if (!Array.isArray(rows)) {
    fail('Remote migration ledger has an unexpected shape; refusing to guess remote state');
  }
  return rows
    .map((row) => (row && row.remote ? String(row.remote).trim() : ''))
    .filter((version) => version.length > 0);
}

function remoteHasVersion(version, knownRemoteVersions) {
  const remote = knownRemoteVersions ?? listRemoteVersions();
  return remote.includes(version);
}

/**
 * `db query` is still the only way to EXECUTE the migration SQL, but its exit
 * code cannot be trusted (reason 3 above). Without this guard a failed apply
 * would exit 0, `migration repair --status applied` would then record the
 * version anyway, and post-apply verification would read that self-written
 * ledger row back and PASS — booking a migration that never ran.
 */
function assertQuerySucceeded(rawOutput, context) {
  const text = String(rawOutput ?? '');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed && (parsed._tag === 'Error' || parsed.error)) {
      const code = parsed.error?.code ?? 'unknown';
      const message = parsed.error?.message ?? 'no message';
      fail(`${context} reported an error envelope despite exit 0: ${code}: ${message}`);
    }
  }
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

  // One read of the remote ledger backs both the re-apply guard and the
  // pending calculation, so the two can never disagree about remote state.
  const remote = listRemoteVersions();

  if (remoteHasVersion(version, remote)) {
    fail(`Version ${version} is already recorded on staging — refusing re-apply`);
  }

  const local = listLocalMigrationVersions();
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
    const applyOutput = runSupabase(['db', 'query', '--linked', '-f', migration.path]);
    assertQuerySucceeded(applyOutput, 'SQL apply');
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
