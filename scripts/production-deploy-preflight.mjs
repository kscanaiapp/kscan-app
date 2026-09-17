#!/usr/bin/env node
/**
 * Production deployment preflight.
 *
 * Validates environment identity, required CI variables, git metadata (HEAD
 * must be exactly the canonical backend-authority branch tip -- see
 * assertGovernedCommit below), migration history alignment against the
 * production ledger, and an explicit single-function allow-list.
 *
 * This is the production mirror of scripts/staging-deploy-preflight.mjs.
 * The migration-comparison and ledger-reconciliation logic is NOT
 * duplicated -- it is imported from that file, which despite its name is
 * environment-agnostic in those functions (see scripts/lib/production-
 * helpers.mjs for why forking that logic is deliberately avoided).
 *
 * Usage:
 *   node scripts/production-deploy-preflight.mjs [--json] [--skip-remote]
 *
 * Env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_PRODUCTION_PROJECT_REF
 *   SUPABASE_PRODUCTION_URL
 *   SUPABASE_PRODUCTION_ANON_KEY
 *   DEPLOY_FUNCTIONS           (comma-separated; default empty = deploy nothing)
 *   APPROVED_MIGRATION_VERSION (optional single pending migration allow-list)
 *   GOVERNED_BRANCH            (default rebuild/backend-authority-v2)
 *
 * Unlike the staging preflight, --allow-dirty is not offered: production
 * never runs against an unclean worktree, full stop.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  listLocalMigrationVersions,
  parseDeployFunctionsAllowList,
  StagingGuardError,
  gitHeadSha,
  gitWorkingTreeClean,
  fail,
} from './lib/staging-helpers.mjs';
import {
  assertProductionTarget,
  missingRequiredProductionVars,
  runSupabaseProduction,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
} from './lib/production-helpers.mjs';
import { compareMigrations, loadLedgerReconciliation } from './staging-deploy-preflight.mjs';

const DEFAULT_GOVERNED_BRANCH = 'rebuild/backend-authority-v2';

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    skipRemote: argv.includes('--skip-remote'),
  };
}

function getRemoteVersions() {
  const out = runSupabaseProduction(['migration', 'list', '--linked', '--output-format', 'json']);
  const parsed = JSON.parse(out);
  const rows = parsed.migrations || parsed || [];
  const versions = new Set();
  for (const row of rows) {
    if (row.version) versions.add(String(row.version));
    if (row.remote) versions.add(String(row.remote));
    if (row.local && row.remote) versions.add(String(row.remote));
  }
  try {
    const sql = 'select version from supabase_migrations.schema_migrations order by version';
    const q = runSupabaseProduction(['db', 'query', sql, '--linked', '--output-format', 'json']);
    const qParsed = JSON.parse(q);
    for (const row of qParsed.rows || []) {
      if (row.version) versions.add(String(row.version));
    }
  } catch {
    // migration list alone is acceptable when db query is unavailable
  }
  return [...versions].sort();
}

/**
 * "Operate only from a merged governed commit": HEAD must BE the current tip
 * of the canonical branch -- not merely descend from it, not a local branch
 * that happens to be ahead, not a PR branch. A fresh `git fetch` of the
 * governed branch and a strict SHA equality is the only thing that can't be
 * faked by an unmerged worktree.
 */
function assertGovernedCommit(governedBranch) {
  let remoteSha;
  try {
    execFileSync('git', ['fetch', 'origin', governedBranch, '--quiet'], { encoding: 'utf8' });
    remoteSha = execFileSync('git', ['rev-parse', `origin/${governedBranch}`], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new StagingGuardError(`Could not resolve origin/${governedBranch}: ${err.message}`);
  }
  const head = gitHeadSha();
  if (!head) throw new StagingGuardError('Could not resolve HEAD');
  if (head !== remoteSha) {
    throw new StagingGuardError(
      `HEAD (${head}) is not the current tip of ${governedBranch} (${remoteSha}). ` +
        'Production deploys only from a merged commit on the governed backend authority branch.',
    );
  }
  return { governedBranch, sha: head };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const governedBranch = process.env.GOVERNED_BRANCH || DEFAULT_GOVERNED_BRANCH;

  const missing = missingRequiredProductionVars();
  if (missing.length > 0) {
    console.error('Missing required production variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  let identity;
  let deployFunctions;
  let governance;
  try {
    identity = assertProductionTarget();
    deployFunctions = parseDeployFunctionsAllowList(process.env.DEPLOY_FUNCTIONS);
  } catch (err) {
    fail(err.message);
  }

  if (!gitWorkingTreeClean()) {
    fail('Working tree is dirty; production never deploys from a dirty worktree');
  }

  try {
    governance = assertGovernedCommit(governedBranch);
  } catch (err) {
    fail(err.message);
  }

  const commit = gitHeadSha();
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
      reconciledLocal: [],
      reconciledRemote: [],
      reconciliationProblems: [],
    };
  } else {
    try {
      runSupabaseProduction(['link', '--project-ref', PRODUCTION_PROJECT_REF, '--yes']);
    } catch (err) {
      fail(`Failed to link production project: ${err.message}`);
    }
    let remote;
    try {
      remote = getRemoteVersions();
    } catch (err) {
      fail(`Failed to read remote migration inventory: ${err.message}`);
    }
    let reconciliation;
    try {
      reconciliation = loadLedgerReconciliation(identity.projectRef);
    } catch (err) {
      fail(err.message);
    }
    migrationReport = compareMigrations(
      local,
      remote,
      process.env.APPROVED_MIGRATION_VERSION || '',
      reconciliation,
    );
  }

  const report = {
    ok: migrationReport.ok,
    environment: {
      expectedProductionRef: PRODUCTION_PROJECT_REF,
      forbiddenStagingRef: STAGING_PROJECT_REF,
      ...identity,
    },
    governance,
    git: {
      commit,
      workingTreeClean: true,
    },
    deployFunctions,
    deployFunctionsDefault: deployFunctions.length === 0 ? 'deploy nothing' : deployFunctions,
    migrations: migrationReport,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Production preflight');
    console.log(`  target: ${identity.projectRef}`);
    console.log(`  url: ${identity.url}`);
    console.log(`  anon key: ${identity.anonKeyFingerprint}`);
    console.log(`  governed branch: ${governedBranch} @ ${governance.sha}`);
    console.log(`  commit: ${commit}`);
    console.log(`  deploy functions: ${deployFunctions.length ? deployFunctions.join(', ') : '(none)'}`);
    console.log(`  local migrations: ${migrationReport.localCount}`);
    if (!migrationReport.skipped) {
      console.log(`  remote migrations: ${migrationReport.remoteCount}`);
      console.log(`  remote-only: ${migrationReport.remoteOnly.length ? migrationReport.remoteOnly.join(', ') : 'none'}`);
      console.log(`  local-only (pending): ${migrationReport.localOnly.length ? migrationReport.localOnly.map((m) => m.version).join(', ') : 'none'}`);
      console.log(`  reconciled local: ${migrationReport.reconciledLocal?.length ?? 0}`);
      console.log(`  reconciled remote: ${migrationReport.reconciledRemote?.length ?? 0}`);
      for (const item of migrationReport.reconciledLocal ?? []) {
        console.log(`    ${item.version} ${item.name} — ${item.classification} -> ${item.remoteVersions.join(', ') || '(none)'}`);
      }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { assertGovernedCommit, getRemoteVersions };
