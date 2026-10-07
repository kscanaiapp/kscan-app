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

import crypto from 'node:crypto';
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
import { loadLedgerReconciliation, OBSOLETE_REMOTE_ONLY } from './staging-deploy-preflight.mjs';
import { compareMigrations } from './staging-deploy-preflight.mjs';

/**
 * The single decision "may THIS invocation execute THIS version?", answered by the
 * same gate the preflight uses so the two can never disagree.
 *
 * Many known pending migrations may exist (an October-style campaign), but one
 * invocation executes at most the one version it was explicitly approved for.
 * Everything else the authority declares stays pending and untouched. It refuses:
 *   - a version declared as a remote-only ledger row (OBSOLETE_REMOTE_ONLY etc.)
 *   - a version already in the ledger (no replay)
 *   - HOLD / EXCLUDE / undeclared versions, an unmet applyAfter order
 *   - any unexplained local or remote drift anywhere in the ledger
 *
 * @returns {{ok: boolean, blockers: string[], migration: object|null, report: object|null}}
 */
export function selectMigrationForApply({ version, local, remote, reconciliation }) {
  const remoteOnlyRow = (reconciliation?.remoteOnly ?? []).find((r) => r?.remoteVersion === version);
  if (remoteOnlyRow) {
    return {
      ok: false,
      blockers: [
        `MIGRATION_VERSION=${version} is a declared ${remoteOnlyRow.classification} ledger row — it never executes through this path`,
      ],
      migration: null,
      report: null,
    };
  }

  const report = compareMigrations(local, remote, version, reconciliation);
  const blockers = [...report.blockers];
  if (report.ok && report.approvedAlreadyApplied) {
    blockers.push(`Version ${version} is already recorded on staging — refusing re-apply`);
  } else if (report.ok && (report.approvedSelectedForExecution !== 1 || report.approvedPending?.version !== version)) {
    blockers.push(`Expected exactly one approved pending migration ${version}; the gate selected ${report.selectedMigration}`);
  }
  return {
    ok: blockers.length === 0,
    blockers,
    migration: blockers.length === 0 ? report.approvedPending : null,
    report,
  };
}

/** LF-normalised content hash, so a CRLF checkout and an LF checkout agree. */
export function normalizedSha256(sql) {
  return crypto.createHash('sha256').update(String(sql).replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Applies the scanner policy for ONE version.
 *
 * The scanner's patterns are never weakened. A BLOCK finding may be cleared only
 * by a scannerOverrides entry on THIS version's knownPending declaration that
 * names that finding id AND the LF-normalised sha256 of the exact SQL about to
 * run. Editing the file voids the override; another version cannot inherit it.
 * Every override that is used is returned, so it is logged rather than silent.
 */
export function applyScannerPolicy({ findings, declaration, sql }) {
  const overrides = Array.isArray(declaration?.scannerOverrides) ? declaration.scannerOverrides : [];
  const digest = normalizedSha256(sql);
  const used = [];
  const remaining = [];
  for (const finding of findings) {
    if (finding.severity !== 'BLOCK') continue;
    const override = overrides.find(
      (o) => o?.findingId === finding.id && o?.sha256 === digest
        && typeof o.reason === 'string' && o.reason.trim() !== '',
    );
    if (override) used.push({ findingId: finding.id, sha256: digest, reason: override.reason });
    else remaining.push(finding);
  }
  return { blocked: remaining, overridden: used };
}

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
    // An override path may only restate the governed file. Without this, a file
    // outside supabase/migrations could run under an approved version string.
    const governed = listLocalMigrationVersions().find((m) => m.version === version);
    if (!governed || path.resolve(governed.path) !== abs) {
      fail(`MIGRATION_FILE is not the governed supabase/migrations file for version ${version}`);
    }
    return { ...parsed, path: abs };
  }

  const local = listLocalMigrationVersions();
  const match = local.find((m) => m.version === version);
  if (!match) fail(`No local migration file for version ${version}`);
  return match;
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
  const reconciliation = loadLedgerReconciliation(STAGING_PROJECT_REF);
  const declaration = (reconciliation.knownPending ?? []).find((k) => k.localVersion === version);
  const { blocked, overridden } = applyScannerPolicy({ findings, declaration, sql });
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

  if (remoteHasVersion(version, remote)) {
    fail(`Version ${version} is already recorded on staging — refusing re-apply`);
  }

  // Many known pending migrations may exist; exactly this one approved version
  // may run. The decision comes from the same gate the preflight uses.
  const local = listLocalMigrationVersions();
  const selection = selectMigrationForApply({ version, local, remote, reconciliation });
  if (!selection.ok) {
    fail(`Refusing to apply ${version}: ${selection.blockers.join('; ')}`);
  }

  console.log(JSON.stringify({
    phase: 'pre-apply',
    target: identity.projectRef,
    version,
    name: migration.name,
    path: migration.path,
    sha256: hash,
    findings,
    scannerOverridesUsed: overridden,
    otherKnownPendingUntouched: selection.report.knownPending
      .map((m) => m.version)
      .filter((v) => v !== version),
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
  const afterLocal = afterLocalMigrations.map((m) => m.version);
  const { reconciled, remoteOnly: remoteOnlyDeclarations } = loadLedgerReconciliation(STAGING_PROJECT_REF);
  const reconciledLocal = new Set(reconciled.map((r) => r.localVersion));
  const reconciledRemote = new Set(reconciled.flatMap((r) => r.remoteVersions ?? []));
  // Declared OBSOLETE_REMOTE_ONLY rows (validated by the preflight that gates this
  // job) are accounted for, not drift -- the same rule the preflight applies.
  const excludedRemote = new Set(
    remoteOnlyDeclarations
      .filter((r) => r?.classification === OBSOLETE_REMOTE_ONLY && !afterLocal.includes(r.remoteVersion))
      .map((r) => r.remoteVersion),
  );
  const remoteOnly = afterRemote.filter(
    (v) => !afterLocal.includes(v) && !reconciledRemote.has(v) && !excludedRemote.has(v),
  );
  const localOnly = afterLocal.filter((v) => !afterRemote.includes(v) && !reconciledLocal.has(v));

  // Known pending is not drift: re-run the same gate over the post-apply ledger so
  // the artifact separates "declared and deliberately unapplied" from unexplained.
  const post = compareMigrations(afterLocalMigrations, afterRemote, version, reconciliation);
  const knownPendingRemaining = post.knownPending.map((m) => m.version);

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
    knownPendingRemaining,
    unexplainedLocal: post.unexplainedLocal.map((m) => m.version),
    scannerOverridesUsed: overridden,
    outcome: !post.ok
      ? 'DRIFT'
      : knownPendingRemaining.length === 0 && localOnly.length === 0
        ? 'ALIGNED'
        : 'ALIGNED_WITH_KNOWN_PENDING',
  };

  const dir = ensureArtifactsDir('staging-migrations');
  const artifactPath = path.join(dir, `${version}-${migration.name}.json`);
  writeJsonArtifact(artifactPath, artifact);

  console.log(JSON.stringify({ ok: true, artifact: artifactPath, ...artifact }, null, 2));

  if (remoteOnly.length > 0 || !post.ok) process.exit(1);
}

// Only run when invoked as a script; importing must not apply anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { pendingVersions, remoteHasVersion };
