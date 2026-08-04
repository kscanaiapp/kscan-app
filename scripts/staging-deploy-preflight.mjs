#!/usr/bin/env node
/**
 * Staging deployment preflight.
 *
 * Validates environment identity, required CI variables, git metadata,
 * migration history alignment, and explicit function allow-list.
 *
 * Usage:
 *   node scripts/staging-deploy-preflight.mjs [--json] [--skip-remote] [--allow-dirty]
 *
 * Env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_STAGING_PROJECT_REF
 *   SUPABASE_STAGING_URL
 *   SUPABASE_STAGING_ANON_KEY
 *   DEPLOY_FUNCTIONS          (comma-separated; default empty = deploy nothing)
 *   APPROVED_MIGRATION_VERSION (optional single pending migration allow-list)
 */

import {
  assertStagingTarget,
  missingRequiredVars,
  listLocalMigrationVersions,
  parseDeployFunctionsAllowList,
  runSupabase,
  gitHeadSha,
  gitWorkingTreeClean,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  fail,
} from './lib/staging-helpers.mjs';

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    skipRemote: argv.includes('--skip-remote'),
    allowDirty: argv.includes('--allow-dirty') || process.env.CI === 'true',
  };
}

function getRemoteVersions() {
  // Prefer Management-API migration list against linked project.
  const out = runSupabase(['migration', 'list', '--linked', '--output-format', 'json']);
  const parsed = JSON.parse(out);
  const rows = parsed.migrations || parsed || [];
  const versions = new Set();
  for (const row of rows) {
    // CLI formats vary: {version}, {remote}, or {local, remote}
    if (row.version) versions.add(String(row.version));
    if (row.remote) versions.add(String(row.remote));
    if (row.local && row.remote) versions.add(String(row.remote));
  }
  // Fallback: query schema_migrations for authoritative applied versions.
  try {
    const sql = 'select version from supabase_migrations.schema_migrations order by version';
    const q = runSupabase(['db', 'query', sql, '--linked', '--output-format', 'json']);
    const qParsed = JSON.parse(q);
    for (const row of qParsed.rows || []) {
      if (row.version) versions.add(String(row.version));
    }
  } catch {
    // migration list alone is acceptable when db query is unavailable
  }
  return [...versions].sort();
}

function compareMigrations(local, remote, approvedVersion) {
  const localSet = new Set(local.map((m) => m.version));
  const remoteSet = new Set(remote);
  const remoteOnly = remote.filter((v) => !localSet.has(v));
  const localOnly = local.filter((m) => !remoteSet.has(m.version));

  const duplicates = [];
  const seen = new Set();
  for (const m of local) {
    if (seen.has(m.version)) duplicates.push(m.version);
    seen.add(m.version);
  }

  const result = {
    localCount: local.length,
    remoteCount: remote.length,
    commonCount: local.filter((m) => remoteSet.has(m.version)).length,
    remoteOnly,
    localOnly: localOnly.map((m) => ({ version: m.version, name: m.name, path: m.path })),
    duplicates,
    ok: true,
    blockers: [],
  };

  if (remoteOnly.length > 0) {
    result.ok = false;
    result.blockers.push(`remote-only migrations exist: ${remoteOnly.join(', ')}`);
  }
  if (duplicates.length > 0) {
    result.ok = false;
    result.blockers.push(`duplicate local versions: ${duplicates.join(', ')}`);
  }
  if (localOnly.length > 1) {
    result.ok = false;
    result.blockers.push(`multiple pending migrations (${localOnly.length}); approve exactly one`);
  }
  if (localOnly.length === 1) {
    const pending = localOnly[0];
    if (!approvedVersion) {
      result.ok = false;
      result.blockers.push(
        `pending migration ${pending.version} requires APPROVED_MIGRATION_VERSION=${pending.version}`,
      );
    } else if (approvedVersion !== pending.version) {
      result.ok = false;
      result.blockers.push(
        `pending migration ${pending.version} does not match APPROVED_MIGRATION_VERSION=${approvedVersion}`,
      );
    } else {
      result.approvedPending = pending;
    }
  }

  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = missingRequiredVars();
  if (missing.length > 0) {
    console.error('Missing required staging variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  let identity;
  let deployFunctions;
  try {
    identity = assertStagingTarget();
    deployFunctions = parseDeployFunctionsAllowList(process.env.DEPLOY_FUNCTIONS);
  } catch (err) {
    fail(err.message);
  }

  const commit = gitHeadSha();
  const clean = gitWorkingTreeClean();
  if (!args.allowDirty && !clean) {
    fail('Working tree is dirty; use a clean worktree or pass --allow-dirty');
  }

  const local = listLocalMigrationVersions();
  let migrationReport;

  if (args.skipRemote) {
    migrationReport = {
      skipped: true,
      localCount: local.length,
      ok: true,
      blockers: [],
      remoteOnly: [],
      localOnly: [],
    };
  } else {
    try {
      runSupabase(['link', '--project-ref', STAGING_PROJECT_REF, '--yes']);
    } catch (err) {
      fail(`Failed to link staging project: ${err.message}`);
    }
    let remote;
    try {
      remote = getRemoteVersions();
    } catch (err) {
      fail(`Failed to read remote migration inventory: ${err.message}`);
    }
    migrationReport = compareMigrations(
      local,
      remote,
      process.env.APPROVED_MIGRATION_VERSION || '',
    );
  }

  const report = {
    ok: migrationReport.ok,
    environment: {
      expectedStagingRef: STAGING_PROJECT_REF,
      forbiddenProductionRef: PRODUCTION_PROJECT_REF,
      ...identity,
    },
    git: {
      commit,
      workingTreeClean: clean,
    },
    deployFunctions,
    deployFunctionsDefault: deployFunctions.length === 0 ? 'deploy nothing' : deployFunctions,
    migrations: migrationReport,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Staging preflight');
    console.log(`  target: ${identity.projectRef}`);
    console.log(`  url: ${identity.url}`);
    console.log(`  anon key: ${identity.anonKeyFingerprint}`);
    console.log(`  commit: ${commit}`);
    console.log(`  deploy functions: ${deployFunctions.length ? deployFunctions.join(', ') : '(none)'}`);
    console.log(`  local migrations: ${migrationReport.localCount}`);
    if (!migrationReport.skipped) {
      console.log(`  remote migrations: ${migrationReport.remoteCount}`);
      console.log(`  remote-only: ${migrationReport.remoteOnly.length ? migrationReport.remoteOnly.join(', ') : 'none'}`);
      console.log(`  local-only: ${migrationReport.localOnly.length ? migrationReport.localOnly.map((m) => m.version).join(', ') : 'none'}`);
    }
    if (migrationReport.blockers?.length) {
      console.log('  blockers:');
      for (const b of migrationReport.blockers) console.log(`    - ${b}`);
    }
  }

  if (!report.ok) {
    process.exit(1);
  }
}

main();

export { compareMigrations };
