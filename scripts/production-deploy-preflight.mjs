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
 *   node scripts/production-deploy-preflight.mjs --static [--json]
 *
 * --static is the credential-free pre-approval precheck (see staticMain); the
 * default mode is the live remote gate and requires the four variables below.
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

import fs from 'node:fs';
import {
  listLocalMigrationVersions,
  parseDeployFunctionsAllowList,
  scanSqlForProhibited,
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
import { compareMigrations } from './staging-deploy-preflight.mjs';
import { loadLedgerReconciliation, staticApprovalCheck } from './lib/migration-reconciliation.mjs';

const DEFAULT_GOVERNED_BRANCH = 'rebuild/backend-authority-v2';

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    skipRemote: argv.includes('--skip-remote'),
    // --static is the CREDENTIAL-FREE pre-approval mode. See staticMain().
    static: argv.includes('--static'),
  };
}

/**
 * CREDENTIAL-FREE PRE-APPROVAL PRECHECK.
 *
 * Production credentials belong behind the `production` GitHub Environment --
 * that is the whole point of the environment gate. But the job that shows a
 * reviewer WHAT they are approving necessarily runs BEFORE that gate, so it
 * cannot hold those credentials. Previously it demanded all four and failed on
 * "Missing required production variables" whenever they were correctly scoped
 * to the environment, which made a correctly-secured repository unable to
 * deploy at all.
 *
 * This mode answers everything answerable from the local tree and the declared
 * authority: the governed tip, a clean worktree, the function/migration scope,
 * that the approved version exists canonically exactly once, that it is not
 * reconciled, HOLD or EXCLUDE, and that its SQL passes the prohibited-pattern
 * scan.
 *
 * It does NOT touch production, and it is NOT the gate. Everything requiring
 * the live ledger -- target identity, already-applied, the pending set,
 * unexplained drift -- is verified by scripts/apply-production-migration.mjs
 * INSIDE `environment: production`, immediately before the write. This check
 * narrows what can reach that gate; it never replaces it.
 */
function staticMain(args) {
  const governedBranch = process.env.GOVERNED_BRANCH || DEFAULT_GOVERNED_BRANCH;

  if (!gitWorkingTreeClean()) {
    fail('Working tree is dirty; production never deploys from a dirty worktree');
  }

  let governance;
  try {
    governance = assertGovernedCommit(governedBranch);
  } catch (err) {
    fail(err.message);
  }

  let deployFunctions;
  try {
    deployFunctions = parseDeployFunctionsAllowList(process.env.DEPLOY_FUNCTIONS);
  } catch (err) {
    fail(err.message);
  }

  const local = listLocalMigrationVersions();
  const approvedVersion = String(process.env.APPROVED_MIGRATION_VERSION || '').trim();

  let reconciliation;
  try {
    reconciliation = loadLedgerReconciliation(PRODUCTION_PROJECT_REF);
  } catch (err) {
    fail(err.message);
  }

  const blockers = [];
  let approved = null;
  let findings = [];

  if (approvedVersion) {
    const check = staticApprovalCheck({ local, approvedVersion, reconciliation });
    blockers.push(...check.blockers);
    approved = check.migration;

    if (check.ok && approved) {
      const allowDestructive =
        String(process.env.ALLOW_DESTRUCTIVE_MIGRATION || '').toUpperCase() === 'YES';
      findings = scanSqlForProhibited(fs.readFileSync(approved.path, 'utf8'), { allowDestructive });
      const blocked = findings.filter((f) => f.severity === 'BLOCK');
      if (blocked.length) {
        blockers.push(
          `Migration blocked by prohibited SQL patterns: ${blocked.map((f) => f.id).join(', ')}`,
        );
      }
    }
  }

  const report = {
    ok: blockers.length === 0,
    mode: 'static-precheck',
    credentialFree: true,
    remoteVerified: false,
    remoteGate:
      'Target identity, already-applied, pending set and unexplained drift are verified by ' +
      'scripts/apply-production-migration.mjs inside environment: production, immediately before the write.',
    environment: {
      expectedProductionRef: PRODUCTION_PROJECT_REF,
      forbiddenStagingRef: STAGING_PROJECT_REF,
    },
    governance,
    git: { commit: gitHeadSha(), workingTreeClean: true },
    deployFunctions,
    deployFunctionsDefault: deployFunctions.length === 0 ? 'deploy nothing' : deployFunctions,
    approvedMigration: approved
      ? { version: approved.version, name: approved.name, path: approved.path }
      : null,
    prohibitedSqlFindings: findings,
    localCount: local.length,
    blockers,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Production static precheck (credential-free, pre-approval)');
    console.log(`  governed branch: ${governance.governedBranch} @ ${governance.sha}`);
    console.log(`  deploy functions: ${deployFunctions.length ? deployFunctions.join(', ') : '(none)'}`);
    console.log(`  approved migration: ${approved ? `${approved.version} ${approved.name}` : '(none)'}`);
    console.log(`  local migrations: ${local.length}`);
    console.log('  REMOTE VERIFICATION: deferred to environment: production (see remoteGate)');
    if (blockers.length) {
      console.log('  blockers:');
      for (const b of blockers) console.log(`    - ${b}`);
    }
  }

  if (!report.ok) process.exit(1);
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
  if (args.static) return staticMain(args);

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
      knownPending: [],
      approvableKnownPending: [],
      hold: [],
      exclude: [],
      fulfilled: [],
      unexplainedRemote: [],
      unexplainedLocal: [],
      remoteOnlyAllowed: [],
      approvedSelectedForExecution: 0,
      otherKnownPendingCount: 0,
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
    // Named so a caller can PROVE which mode produced a report rather than
    // inferring it. The live gate inside `environment: production` asserts
    // remoteVerified === true, so a --skip-remote (or --static) report can
    // never be mistaken for a remote verification.
    mode: args.skipRemote ? 'local-only' : 'live-remote-gate',
    credentialFree: false,
    remoteVerified: !args.skipRemote,
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
      console.log(`  RECONCILED: ${migrationReport.reconciledLocal?.length ?? 0} local, ${migrationReport.reconciledRemote?.length ?? 0} remote`);
      console.log(`  REMOTE_ONLY_ALLOWED: ${migrationReport.remoteOnlyAllowed?.length ?? 0}`);
      console.log(`  UNEXPLAINED_REMOTE: ${migrationReport.unexplainedRemote?.length ? migrationReport.unexplainedRemote.join(', ') : '0'}`);
      console.log(`  KNOWN_PENDING: ${migrationReport.knownPending?.length ?? 0}`);
      console.log(`    approvable (KNOWN_FUTURE_UNAPPLIED): ${migrationReport.approvableKnownPending?.length ?? 0}`);
      console.log(`    HOLD: ${migrationReport.hold?.length ?? 0}`);
      console.log(`    EXCLUDE: ${migrationReport.exclude?.length ?? 0}`);
      console.log(`  FULFILLED: ${migrationReport.fulfilled?.length ?? 0}`);
      console.log(
        `  APPROVED_PENDING: ${migrationReport.approvedPending ? migrationReport.approvedPending.version : '(none)'}`,
      );
      console.log(`  APPROVED_PENDING_COUNT: ${migrationReport.approvedSelectedForExecution ?? 0}`);
      console.log(`  OTHER_KNOWN_PENDING: ${migrationReport.otherKnownPendingCount ?? 0}`);
      console.log('  OTHER_MIGRATIONS_SELECTED_FOR_EXECUTION: 0');
      if (migrationReport.approvedAlreadyApplied) {
        console.log(`  APPROVED_ALREADY_APPLIED: ${migrationReport.approvedAlreadyApplied}`);
      }
      for (const item of migrationReport.reconciledLocal ?? []) {
        console.log(`    RECONCILED ${item.version} ${item.name} — ${item.classification} -> ${item.remoteVersions.join(', ') || '(none)'}`);
      }
      for (const item of migrationReport.remoteOnlyAllowed ?? []) {
        console.log(`    REMOTE_ONLY_ALLOWED ${item.version} ${item.logicalName} — ${item.classification}`);
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

export { assertGovernedCommit, getRemoteVersions, staticMain };
