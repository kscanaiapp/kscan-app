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
import { pathToFileURL } from 'node:url';
import {
  assertStagingTarget,
  missingRequiredVars,
  listLocalMigrationVersions,
  parseMigrationFilename,
  scanSqlForProhibited,
  sha256File,
  runSupabase,
  readRemoteMigrationVersions,
  writeJsonArtifact,
  ensureArtifactsDir,
  gitHeadSha,
  STAGING_PROJECT_REF,
  fail,
} from './lib/staging-helpers.mjs';
import { loadLedgerReconciliation, compareMigrations } from './staging-deploy-preflight.mjs';

function requireApproval() {
  if (String(process.env.APPROVE_STAGING_MIGRATION || '').toUpperCase() !== 'YES') {
    fail('Set APPROVE_STAGING_MIGRATION=YES to apply a staging migration');
  }
}

function resolveMigrationFile(version, explicitPath) {
  const matches = listLocalMigrationVersions().filter((m) => m.version === version);
  if (matches.length !== 1) fail(`Expected exactly one governed migration file for version ${version}`);
  const governed = matches[0];
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    if (!fs.existsSync(abs)) fail(`Migration file not found: ${abs}`);
    const parsed = parseMigrationFilename(abs);
    if (!parsed) fail(`Migration filename does not match required pattern: ${path.basename(abs)}`);
    if (parsed.version !== version) {
      fail(`Filename version ${parsed.version} does not equal MIGRATION_VERSION ${version}`);
    }
    if (fs.realpathSync(abs) !== fs.realpathSync(governed.path)) {
      fail('MIGRATION_FILE must resolve to the governed local migration');
    }
  }
  return governed;
}

// Both of these read the SAME inventory, so they can never disagree about what
// staging has applied -- and both fail closed rather than reporting an
// unreadable ledger as an empty one. See readRemoteMigrationVersions().
function listRemoteVersions() {
  return readRemoteMigrationVersions(runSupabase);
}

function remoteHasVersion(version, remote = listRemoteVersions()) {
  return remote.includes(version);
}

/**
 * The versions genuinely absent from staging: local files minus everything the
 * ledger already carries, minus everything the reconciliation authority proves
 * is present under another version identity (renumbered, consolidated,
 * superseded). Without this the gate counts historical renumbering as pending
 * work and can never see exactly one approved migration.
 */
function pendingVersions(local, remote) {
  const remoteSet = new Set(remote);
  const { reconciled } = loadLedgerReconciliation(STAGING_PROJECT_REF);
  const reconciledLocal = new Set(reconciled.map((r) => r.localVersion));
  return local.filter((m) => !remoteSet.has(m.version) && !reconciledLocal.has(m.version));
}

/** Use the same reconciliation/approval policy as preflight and Production. */
function selectApprovedMigration({ local, remote, approvedVersion, reconciliation }) {
  const report = compareMigrations(local, remote, approvedVersion, reconciliation);
  const blockers = [...report.blockers];
  if (!String(approvedVersion || '').trim()) blockers.push('No approved migration supplied');
  if (report.approvedAlreadyApplied) blockers.push('Approved migration is already recorded; refusing re-apply');
  const selected = report.approvedPending;
  if (!selected || selected.version !== approvedVersion) blockers.push('Exactly the approved pending migration must be selected');
  return { selected: blockers.length === 0 ? selected : null, pending: report.localOnly, blockers };
}

function verifyAppliedMigration({ local, beforeRemote, afterRemote, approvedVersion, reconciliation }) {
  const report = compareMigrations(local, afterRemote, approvedVersion, reconciliation);
  const unexpectedLedgerAdditions = afterRemote.filter((v) => v !== approvedVersion && !beforeRemote.includes(v));
  const unexpectedLedgerRemovals = beforeRemote.filter((v) => !afterRemote.includes(v));
  const blockers = [...report.blockers];
  if (report.approvedAlreadyApplied !== approvedVersion) blockers.push('Approved migration was not recorded after apply');
  if (unexpectedLedgerAdditions.length || unexpectedLedgerRemovals.length) blockers.push('Ledger changed beyond exactly the approved migration');
  return { report, unexpectedLedgerAdditions, unexpectedLedgerRemovals, blockers };
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

  let remote;
  try {
    remote = listRemoteVersions();
  } catch (err) {
    fail(err.message);
  }

  const local = listLocalMigrationVersions();
  const selection = selectApprovedMigration({ local, remote, approvedVersion: version,
    reconciliation: loadLedgerReconciliation(STAGING_PROJECT_REF) });
  if (!selection.selected || selection.blockers.length) fail(`Refusing migration: ${selection.blockers.join('; ')}`);

  console.log(JSON.stringify({
    phase: 'pre-apply',
    target: identity.projectRef,
    version,
    name: migration.name,
    path: migration.path,
    sha256: hash,
    findings,
    approvedPendingCount: 1,
    otherKnownPending: selection.pending.map((m) => m.version).filter((v) => v !== version),
    otherMigrationsSelectedForExecution: 0,
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
  const afterLocalMigrations = listLocalMigrationVersions();
  const after = verifyAppliedMigration({ local: afterLocalMigrations, beforeRemote: remote,
    afterRemote, approvedVersion: version, reconciliation: loadLedgerReconciliation(STAGING_PROJECT_REF) });

  const artifact = {
    timestamp: new Date().toISOString(),
    commit: gitHeadSha(),
    target: STAGING_PROJECT_REF,
    version,
    name: migration.name,
    sha256: hash,
    path: migration.path,
    localCount: afterLocalMigrations.length,
    remoteCount: afterRemote.length,
    remoteOnly: after.report.unexplainedRemote,
    localOnly: after.report.unexplainedLocal.map((m) => m.version),
    knownPendingRemaining: after.report.knownPending.map((m) => m.version),
    unexpectedLedgerAdditions: after.unexpectedLedgerAdditions,
    unexpectedLedgerRemovals: after.unexpectedLedgerRemovals,
    outcome: after.blockers.length === 0 ? 'ALIGNED' : 'DRIFT',
    blockers: after.blockers,
  };

  const dir = ensureArtifactsDir('staging-migrations');
  const artifactPath = path.join(dir, `${version}-${migration.name}.json`);
  writeJsonArtifact(artifactPath, artifact);

  console.log(JSON.stringify({ ok: after.blockers.length === 0, artifact: artifactPath, ...artifact }, null, 2));

  if (after.blockers.length > 0) process.exit(1);
}

// Only run when invoked as a script; importing must not apply anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { pendingVersions, remoteHasVersion, selectApprovedMigration, verifyAppliedMigration, resolveMigrationFile };
