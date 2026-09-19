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
 *
 * MIGRATION RECONCILIATION AUTHORITY
 *
 * A version present locally but absent from the remote ledger is not automatically
 * a missing migration: this project's history contains migrations that were applied
 * under a different version stamp (renumber), split across several ledger rows
 * (consolidation), or made unnecessary by other applied state (supersession). Those
 * are declared, with evidence, in
 *   config/migration-authority-manifest.json -> ledgerReconciliation
 * keyed by project ref. This gate consults that authority so historical renumbering
 * stops reading as deployment drift — and ONLY that. A version that is not declared
 * there is still treated as genuinely pending and still requires
 * APPROVED_MIGRATION_VERSION; an undeclared remote-only version still fails; a stale
 * or self-contradictory declaration fails; an unknown project ref gets no
 * reconciliation at all, so production fails closed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

import {
  OBSOLETE_REMOTE_ONLY,
  PRODUCTION_ONLY_HISTORICAL,
  VALID_RECONCILIATION_CLASSIFICATIONS,
  VALID_REMOTE_ONLY_CLASSIFICATIONS,
  VALID_KNOWN_PENDING_DISPOSITIONS,
  KNOWN_FUTURE_UNAPPLIED,
  HOLD,
  EXCLUDE,
  loadLedgerReconciliation,
  validateReconciliation,
  validateRemoteOnlyExclusions,
  validateKnownPending,
  resolveApprovedMigration,
} from './lib/migration-reconciliation.mjs';

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

/**
 * The reconciliation vocabulary, its validators and the single approval gate now
 * live in scripts/lib/migration-reconciliation.mjs so that the production
 * preflight and the production applier reach the same decision from the same
 * code. They are re-exported here unchanged: this module remains the import
 * site the rest of the tooling and the existing tests already use.
 */

/**
 * Compares the local migration tree against a remote ledger under the declared
 * reconciliation authority, and decides which single migration (if any) this
 * invocation may execute.
 *
 * The model is:
 *
 *   EXACTLY_ONE_EXPLICITLY_APPROVED_PENDING_MIGRATION + ZERO_UNEXPLAINED_DRIFT
 *
 * not the older EXACTLY_ONE_PENDING_MIGRATION. Other known, legitimate,
 * deliberately-unapplied migrations may remain pending; they simply never
 * execute. Anything the authority does NOT explain -- an undeclared remote-only
 * row, an undeclared local divergence -- still fails closed.
 *
 * An environment that declares no `knownPending` (staging, and every unknown
 * ref) keeps the original behaviour exactly: with nothing declared, every
 * pending migration is undeclared, so more than one pending migration is still a
 * blocker and the message is unchanged.
 */
function compareMigrations(local, remote, approvedVersion, reconciliation = null) {
  const localSet = new Set(local.map((m) => m.version));
  const remoteSet = new Set(remote);

  const reconciled = reconciliation?.reconciled ?? [];
  const { problems, aliasedLocal, claimedRemote } = validateReconciliation(
    reconciled,
    localSet,
    remoteSet,
  );
  const exclusions = validateRemoteOnlyExclusions(
    reconciliation?.remoteOnly ?? [],
    localSet,
    remoteSet,
    claimedRemote,
  );
  problems.push(...exclusions.problems);
  const { excludedRemote } = exclusions;

  const knownPendingDeclarations = reconciliation?.knownPending ?? [];
  const known = validateKnownPending(knownPendingDeclarations, localSet, remoteSet, aliasedLocal);
  problems.push(...known.problems);
  const { declaredPending } = known;

  // A remote-only version is drift ONLY if no proven reconciliation accounts for
  // it and no validated remote-only exclusion names it.
  const remoteOnly = remote.filter(
    (v) => !localSet.has(v) && !claimedRemote.has(v) && !excludedRemote.has(v),
  );
  const reconciledRemote = remote.filter((v) => !localSet.has(v) && claimedRemote.has(v));
  const excludedRemoteOnly = remote.filter((v) => !localSet.has(v) && excludedRemote.has(v));

  // A local-only version is pending ONLY if it is not itself reconciled.
  const pending = local.filter((m) => !remoteSet.has(m.version) && !aliasedLocal.has(m.version));
  const reconciledLocal = local.filter(
    (m) => !remoteSet.has(m.version) && aliasedLocal.has(m.version),
  );

  // Pending splits into KNOWN (explained by the authority) and UNEXPLAINED.
  const knownPending = pending.filter((m) => declaredPending.has(m.version));
  const unexplainedLocal = pending.filter((m) => !declaredPending.has(m.version));

  const duplicates = [];
  const seen = new Set();
  for (const m of local) {
    if (seen.has(m.version)) duplicates.push(m.version);
    seen.add(m.version);
  }

  // The environment is operating under an explicit reconciliation authority as
  // soon as it declares any knownPending entry. Only then may more than one
  // migration legitimately remain pending.
  const hasKnownPendingAuthority = declaredPending.size > 0;

  const approval = resolveApprovedMigration({
    approvedVersion,
    pending,
    declaredPending,
    aliasedLocal,
    remoteSet,
    localSet,
    requireDeclaration: hasKnownPendingAuthority,
  });

  const describe = (m) => {
    const declaration = declaredPending.get(m.version);
    return {
      version: m.version,
      name: m.name,
      path: m.path,
      ...(declaration ? { disposition: declaration.disposition } : {}),
    };
  };

  const result = {
    localCount: local.length,
    remoteCount: remote.length,
    commonCount: local.filter((m) => remoteSet.has(m.version)).length,
    remoteOnly,
    localOnly: pending.map((m) => ({ version: m.version, name: m.name, path: m.path })),
    reconciledLocal: reconciledLocal.map((m) => ({
      version: m.version,
      name: m.name,
      classification: aliasedLocal.get(m.version).classification,
      remoteVersions: aliasedLocal.get(m.version).remoteVersions ?? [],
    })),
    reconciledRemote,
    excludedRemoteOnly,
    reconciliationProblems: problems,
    duplicates,
    ok: true,
    blockers: [],

    // --- the report the production campaign reads -------------------------
    // Each bucket answers one question and only that question.
    knownPending: knownPending.map(describe),
    unexplainedRemote: remoteOnly,
    unexplainedLocal: unexplainedLocal.map(describe),
    remoteOnlyAllowed: excludedRemoteOnly.map((v) => ({
      version: v,
      classification: excludedRemote.get(v).classification,
      logicalName: excludedRemote.get(v).logicalName,
    })),
    approvedSelectedForExecution: 0,
    otherKnownPendingCount: 0,
  };

  if (problems.length > 0) {
    result.ok = false;
    for (const problem of problems) result.blockers.push(problem);
  }
  if (remoteOnly.length > 0) {
    result.ok = false;
    result.blockers.push(
      `remote-only migrations exist with no declared reconciliation: ${remoteOnly.join(', ')}`,
    );
  }
  if (duplicates.length > 0) {
    result.ok = false;
    result.blockers.push(`duplicate local versions: ${duplicates.join(', ')}`);
  }

  if (hasKnownPendingAuthority) {
    // Under an explicit authority, many known pending migrations are fine and
    // only UNEXPLAINED local divergence is drift.
    if (unexplainedLocal.length > 0) {
      result.ok = false;
      result.blockers.push(
        `local migrations diverge from the remote ledger with no declared reconciliation or knownPending disposition: ${unexplainedLocal
          .map((m) => m.version)
          .join(', ')}`,
      );
    }
  } else if (pending.length > 1) {
    // Original behaviour, unchanged, for every environment without an authority.
    result.ok = false;
    result.blockers.push(
      `multiple pending migrations (${pending.length}); approve exactly one: ${pending
        .map((m) => m.version)
        .join(', ')}`,
    );
  }

  for (const blocker of approval.blockers) {
    result.ok = false;
    result.blockers.push(blocker);
  }

  if (approval.selected) {
    result.approvedPending = approval.selected;
    result.approvedSelectedForExecution = 1;
    result.otherKnownPendingCount = pending.length - 1;
  } else if (approval.alreadyApplied) {
    // Nothing to select. The deploy job re-runs this preflight AFTER the
    // approved migration has been applied, carrying the same
    // APPROVED_MIGRATION_VERSION through -- so an approved version the ledger
    // already contains is a satisfied approval. It is reported, and it selects
    // nothing for execution.
    result.approvedAlreadyApplied = approval.alreadyApplied;
    result.otherKnownPendingCount = pending.length;
  } else {
    result.otherKnownPendingCount = pending.length;
    if (!approvedVersion && pending.length === 1 && !hasKnownPendingAuthority) {
      const item = pending[0];
      result.ok = false;
      result.blockers.push(
        `pending migration ${item.version} requires APPROVED_MIGRATION_VERSION=${item.version}`,
      );
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
      reconciledLocal: [],
      reconciledRemote: [],
      reconciliationProblems: [],
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
      console.log(`  local-only (pending): ${migrationReport.localOnly.length ? migrationReport.localOnly.map((m) => m.version).join(', ') : 'none'}`);
      console.log(`  reconciled local: ${migrationReport.reconciledLocal?.length ?? 0}`);
      console.log(`  reconciled remote: ${migrationReport.reconciledRemote?.length ?? 0}`);
      console.log(`  excluded obsolete remote-only: ${migrationReport.excludedRemoteOnly?.length ? migrationReport.excludedRemoteOnly.join(', ') : 'none'}`);
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

// Only run the gate when invoked as a script; importing this module (tests,
// tooling) must not execute the preflight or call process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  compareMigrations,
  loadLedgerReconciliation,
  validateReconciliation,
  validateRemoteOnlyExclusions,
  validateKnownPending,
  resolveApprovedMigration,
  OBSOLETE_REMOTE_ONLY,
  PRODUCTION_ONLY_HISTORICAL,
  KNOWN_FUTURE_UNAPPLIED,
  HOLD,
  EXCLUDE,
  VALID_RECONCILIATION_CLASSIFICATIONS,
  VALID_REMOTE_ONLY_CLASSIFICATIONS,
  VALID_KNOWN_PENDING_DISPOSITIONS,
};
