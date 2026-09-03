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

const VALID_RECONCILIATION_CLASSIFICATIONS = new Set([
  'EXACT_CONTENT_RENUMBER',
  'EQUIVALENT_RENUMBER',
  'CONSOLIDATED_IN_REMOTE',
  'SUPERSEDED_BY_LATER_MIGRATION',
]);

/**
 * Loads the reconciliation authority for one project ref.
 * An unknown ref (production included) resolves to an empty authority, so the
 * gate keeps its original strict behaviour wherever nothing was ever proven.
 */
function loadLedgerReconciliation(projectRef, manifestPath) {
  const file =
    manifestPath ||
    path.join(process.cwd(), 'config', 'migration-authority-manifest.json');
  if (!fs.existsSync(file)) return { reconciled: [], genuinelyUnapplied: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`migration authority manifest is unparseable: ${err.message}`);
  }
  const env = manifest?.ledgerReconciliation?.environments?.[projectRef];
  if (!env) return { reconciled: [], genuinelyUnapplied: [] };
  return {
    reconciled: Array.isArray(env.reconciled) ? env.reconciled : [],
    genuinelyUnapplied: Array.isArray(env.genuinelyUnapplied) ? env.genuinelyUnapplied : [],
  };
}

/**
 * Validates the declared reconciliation against the real local tree and the real
 * remote ledger. A declaration that has rotted (names a version that no longer
 * exists on either side, claims a remote row twice, contradicts itself, or carries
 * an unknown classification) is a blocker, not a licence.
 */
function validateReconciliation(reconciled, localSet, remoteSet) {
  const problems = [];
  const aliasedLocal = new Map();
  const claimedRemote = new Map();

  for (const item of reconciled) {
    const label = `${item?.localVersion ?? '(no localVersion)'} (${item?.logicalName ?? 'unnamed'})`;

    if (!item || typeof item.localVersion !== 'string' || !item.localVersion) {
      problems.push(`reconciliation entry ${label}: localVersion is missing`);
      continue;
    }
    if (!VALID_RECONCILIATION_CLASSIFICATIONS.has(item.classification)) {
      problems.push(
        `reconciliation entry ${label}: unknown classification "${item.classification}"`,
      );
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      problems.push(`reconciliation entry ${label}: evidence is required`);
    }
    if (!localSet.has(item.localVersion)) {
      problems.push(
        `reconciliation entry ${label}: localVersion is not present in supabase/migrations — stale authority`,
      );
    }
    if (aliasedLocal.has(item.localVersion)) {
      problems.push(`reconciliation entry ${label}: localVersion declared more than once`);
    } else {
      aliasedLocal.set(item.localVersion, item);
    }

    const remoteVersions = Array.isArray(item.remoteVersions) ? item.remoteVersions : [];
    if (remoteVersions.length === 0 && item.classification !== 'SUPERSEDED_BY_LATER_MIGRATION') {
      problems.push(
        `reconciliation entry ${label}: only SUPERSEDED_BY_LATER_MIGRATION may declare no remoteVersions`,
      );
    }
    for (const remoteVersion of remoteVersions) {
      if (!remoteSet.has(remoteVersion)) {
        problems.push(
          `reconciliation entry ${label}: claims remote version ${remoteVersion}, which the remote ledger does not contain — stale authority`,
        );
        continue;
      }
      if (claimedRemote.has(remoteVersion)) {
        problems.push(
          `reconciliation entry ${label}: remote version ${remoteVersion} is already claimed by ${claimedRemote.get(remoteVersion)}`,
        );
      } else {
        claimedRemote.set(remoteVersion, label);
      }
    }
  }

  return { problems, aliasedLocal, claimedRemote };
}

function compareMigrations(local, remote, approvedVersion, reconciliation = null) {
  const localSet = new Set(local.map((m) => m.version));
  const remoteSet = new Set(remote);

  const reconciled = reconciliation?.reconciled ?? [];
  const { problems, aliasedLocal, claimedRemote } = validateReconciliation(
    reconciled,
    localSet,
    remoteSet,
  );

  // A remote-only version is drift ONLY if no proven reconciliation accounts for it.
  const remoteOnly = remote.filter((v) => !localSet.has(v) && !claimedRemote.has(v));
  const reconciledRemote = remote.filter((v) => !localSet.has(v) && claimedRemote.has(v));

  // A local-only version is pending ONLY if it is not itself reconciled.
  const pending = local.filter((m) => !remoteSet.has(m.version) && !aliasedLocal.has(m.version));
  const reconciledLocal = local.filter(
    (m) => !remoteSet.has(m.version) && aliasedLocal.has(m.version),
  );

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
    localOnly: pending.map((m) => ({ version: m.version, name: m.name, path: m.path })),
    reconciledLocal: reconciledLocal.map((m) => ({
      version: m.version,
      name: m.name,
      classification: aliasedLocal.get(m.version).classification,
      remoteVersions: aliasedLocal.get(m.version).remoteVersions ?? [],
    })),
    reconciledRemote,
    reconciliationProblems: problems,
    duplicates,
    ok: true,
    blockers: [],
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
  if (pending.length > 1) {
    result.ok = false;
    result.blockers.push(
      `multiple pending migrations (${pending.length}); approve exactly one: ${pending
        .map((m) => m.version)
        .join(', ')}`,
    );
  }
  if (pending.length === 1) {
    const item = pending[0];
    if (!approvedVersion) {
      result.ok = false;
      result.blockers.push(
        `pending migration ${item.version} requires APPROVED_MIGRATION_VERSION=${item.version}`,
      );
    } else if (approvedVersion !== item.version) {
      result.ok = false;
      result.blockers.push(
        `pending migration ${item.version} does not match APPROVED_MIGRATION_VERSION=${approvedVersion}`,
      );
    } else {
      result.approvedPending = item;
    }
  } else if (approvedVersion) {
    result.ok = false;
    result.blockers.push(
      `APPROVED_MIGRATION_VERSION=${approvedVersion} was supplied but no migration is pending`,
    );
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

export { compareMigrations, loadLedgerReconciliation, validateReconciliation };
