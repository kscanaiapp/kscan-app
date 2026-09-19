#!/usr/bin/env node
/**
 * Apply exactly one approved migration to K Scan App Production.
 *
 * Never uses blanket `db push`, `db reset`, or `migration up`. Records the
 * applied version via `migration repair --status applied --linked` only as
 * the intentional counterpart to a successful SQL apply.
 *
 * Production mirror of scripts/apply-staging-migration.mjs.
 *
 * Required env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_PRODUCTION_PROJECT_REF=wyyuqfdxucjksghsmhry
 *   SUPABASE_PRODUCTION_URL
 *   SUPABASE_PRODUCTION_ANON_KEY
 *   MIGRATION_VERSION
 *   APPROVE_PRODUCTION_MIGRATION=YES
 *
 * Optional:
 *   MIGRATION_FILE (defaults to matching file under supabase/migrations/)
 *   ALLOW_DESTRUCTIVE_MIGRATION=YES (required for DROP TABLE / destructive ALTER)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  listLocalMigrationVersions,
  parseMigrationFilename,
  scanSqlForProhibited,
  sha256File,
  readRemoteMigrationVersions,
  writeJsonArtifact,
  ensureArtifactsDir,
  gitHeadSha,
  fail,
} from './lib/staging-helpers.mjs';
import {
  assertProductionTarget,
  missingRequiredProductionVars,
  runSupabaseProduction,
  PRODUCTION_PROJECT_REF,
} from './lib/production-helpers.mjs';
import { assertGovernedCommit } from './production-deploy-preflight.mjs';
import {
  loadLedgerReconciliation,
  validateReconciliation,
  validateRemoteOnlyExclusions,
  validateKnownPending,
  resolveApprovedMigration,
} from './lib/migration-reconciliation.mjs';

const DEFAULT_GOVERNED_BRANCH = 'rebuild/backend-authority-v2';

function requireApproval() {
  if (String(process.env.APPROVE_PRODUCTION_MIGRATION || '').toUpperCase() !== 'YES') {
    fail('Set APPROVE_PRODUCTION_MIGRATION=YES to apply a production migration');
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

function listRemoteVersions() {
  return readRemoteMigrationVersions(runSupabaseProduction);
}

function remoteHasVersion(version, remote = listRemoteVersions()) {
  return remote.includes(version);
}

/**
 * The legitimately pending set: local versions the remote ledger does not hold
 * and that no reconciliation declares already-present.
 */
function pendingVersions(local, remote, reconciliation = loadLedgerReconciliation(PRODUCTION_PROJECT_REF)) {
  const remoteSet = new Set(remote);
  const reconciledLocal = new Set((reconciliation.reconciled ?? []).map((r) => r.localVersion));
  return local.filter((m) => !remoteSet.has(m.version) && !reconciledLocal.has(m.version));
}

/**
 * The whole selection decision, in one place, fail-closed.
 *
 * Replaces the old `pending.length === 1` invariant, which could not express
 * "apply exactly this one approved migration while other legitimate Build 34
 * migrations remain pending". The new invariant is:
 *
 *   APPROVED_VERSION is in the legitimate pending set
 *   AND it occurs exactly once
 *   AND all production drift has passed reconciliation validation
 *   AND no other migration is selected
 *
 * Returns { selected, pending, blockers }. `selected` is null whenever ANY
 * blocker exists, so a caller that refuses on blockers can never act on a
 * partially-validated decision.
 */
function selectApprovedMigration({ local, remote, approvedVersion, reconciliation }) {
  const localSet = new Set(local.map((m) => m.version));
  const remoteSet = new Set(remote);

  const { problems, aliasedLocal, claimedRemote } = validateReconciliation(
    reconciliation.reconciled ?? [],
    localSet,
    remoteSet,
  );
  const exclusions = validateRemoteOnlyExclusions(
    reconciliation.remoteOnly ?? [],
    localSet,
    remoteSet,
    claimedRemote,
  );
  const known = validateKnownPending(
    reconciliation.knownPending ?? [],
    localSet,
    remoteSet,
    aliasedLocal,
  );
  const blockers = [...problems, ...exclusions.problems, ...known.problems];

  // 11. every production-only remote version must be reconciled or explicitly
  // classified. Unknown drift fails closed, exactly as before.
  const unexplainedRemote = remote.filter(
    (v) => !localSet.has(v) && !claimedRemote.has(v) && !exclusions.excludedRemote.has(v),
  );
  if (unexplainedRemote.length > 0) {
    blockers.push(
      `remote-only migrations exist with no declared reconciliation: ${unexplainedRemote.join(', ')}`,
    );
  }

  const pending = pendingVersions(local, remote, reconciliation);
  // Derived from the DECLARATIONS, not from how many are still outstanding, so a
  // sequential campaign keeps its authority as entries become FULFILLED.
  const hasKnownPendingAuthority = (reconciliation.knownPending ?? []).length > 0;

  // Unexplained LOCAL divergence fails closed too, once the environment is
  // operating under an explicit authority.
  if (hasKnownPendingAuthority) {
    const unexplainedLocal = pending
      .filter((m) => !known.declaredPending.has(m.version))
      .map((m) => m.version);
    if (unexplainedLocal.length > 0) {
      blockers.push(
        `local migrations diverge from the remote ledger with no declared reconciliation or knownPending disposition: ${unexplainedLocal.join(', ')}`,
      );
    }
  } else if (pending.length > 1) {
    blockers.push(
      `multiple pending migrations (${pending.length}) and no production reconciliation authority to explain them: ${pending
        .map((m) => m.version)
        .join(', ')}`,
    );
  }

  if (!String(approvedVersion || '').trim()) {
    blockers.push('No approved migration was supplied; nothing may be executed');
    return { selected: null, pending, blockers };
  }

  const approval = resolveApprovedMigration({
    approvedVersion,
    pending,
    declaredPending: known.declaredPending,
    aliasedLocal,
    remoteSet,
    localSet,
    requireDeclaration: hasKnownPendingAuthority,
  });
  blockers.push(...approval.blockers);

  // The applier NEVER re-applies. Unlike the preflight -- which the deploy job
  // re-runs after a successful apply and which therefore treats an
  // already-applied approval as satisfied -- reaching the applier with a version
  // the ledger already holds is a refusal.
  if (approval.alreadyApplied) {
    blockers.push(
      `Version ${approval.alreadyApplied} is already recorded on production — refusing re-apply`,
    );
  }

  return { selected: blockers.length === 0 ? approval.selected : null, pending, blockers };
}

function main() {
  const missing = missingRequiredProductionVars();
  if (missing.length) {
    console.error('Missing required production variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  requireApproval();
  let identity;
  try {
    identity = assertProductionTarget();
  } catch (err) {
    fail(err.message);
  }

  const governedBranch = process.env.GOVERNED_BRANCH || DEFAULT_GOVERNED_BRANCH;
  try {
    assertGovernedCommit(governedBranch);
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

  runSupabaseProduction(['link', '--project-ref', PRODUCTION_PROJECT_REF, '--yes']);

  let remote;
  try {
    remote = listRemoteVersions();
  } catch (err) {
    fail(err.message);
  }

  const local = listLocalMigrationVersions();
  let reconciliation;
  try {
    reconciliation = loadLedgerReconciliation(PRODUCTION_PROJECT_REF);
  } catch (err) {
    fail(err.message);
  }

  const selection = selectApprovedMigration({
    local,
    remote,
    approvedVersion: version,
    reconciliation,
  });
  if (selection.blockers.length > 0 || !selection.selected) {
    fail(
      `Refusing to apply ${version}:\n  - ${selection.blockers.join('\n  - ')}`,
    );
  }
  if (selection.selected.version !== version) {
    // Unreachable by construction; asserted because this is the line that
    // decides what actually runs against production.
    fail(
      `Selection gate returned ${selection.selected.version} for approved version ${version} — refusing`,
    );
  }

  const otherPending = selection.pending
    .map((m) => m.version)
    .filter((v) => v !== version);

  console.log(JSON.stringify({
    phase: 'pre-apply',
    target: identity.projectRef,
    version,
    name: migration.name,
    path: migration.path,
    sha256: hash,
    findings,
    // Explicit, auditable proof that exactly one migration was selected and the
    // rest were left alone.
    approvedPendingCount: 1,
    otherKnownPending: otherPending,
    otherMigrationsSelectedForExecution: 0,
  }, null, 2));

  try {
    runSupabaseProduction(['db', 'query', '--linked', '-f', migration.path]);
  } catch (err) {
    fail(`SQL apply failed: ${err.message}`);
  }

  try {
    runSupabaseProduction(['migration', 'repair', version, '--status', 'applied', '--linked']);
  } catch (err) {
    fail(`Failed to record applied migration version ${version}: ${err.message}`);
  }

  if (!remoteHasVersion(version)) {
    fail(`Post-apply verification failed: version ${version} not present in schema_migrations`);
  }

  const afterRemote = listRemoteVersions();
  const afterLocalMigrations = listLocalMigrationVersions();
  const afterLocal = afterLocalMigrations.map((m) => m.version);
  const after = loadLedgerReconciliation(PRODUCTION_PROJECT_REF);
  const reconciledLocal = new Set((after.reconciled ?? []).map((r) => r.localVersion));
  const reconciledRemote = new Set((after.reconciled ?? []).flatMap((r) => r.remoteVersions ?? []));
  const classifiedRemote = new Set((after.remoteOnly ?? []).map((r) => r.remoteVersion));
  const declaredPending = new Set((after.knownPending ?? []).map((k) => k.localVersion));

  // Post-apply drift: a remote row that neither the local tree, a reconciliation
  // nor an explicit remote-only classification accounts for is UNEXPECTED -- the
  // ledger changed in a way this invocation did not intend.
  const remoteOnly = afterRemote.filter(
    (v) => !afterLocal.includes(v) && !reconciledRemote.has(v) && !classifiedRemote.has(v),
  );
  // Local versions still absent from the ledger are expected: they are the other
  // known, deliberately-unapplied Build 34 migrations. Only UNDECLARED ones are
  // drift.
  const localOnly = afterLocal.filter(
    (v) => !afterRemote.includes(v) && !reconciledLocal.has(v) && !declaredPending.has(v),
  );
  const stillPending = afterLocal.filter(
    (v) => !afterRemote.includes(v) && declaredPending.has(v),
  );

  // The ledger must have gained EXACTLY this version and nothing else.
  const unexpectedLedgerAdditions = afterRemote.filter(
    (v) => v !== version && !remote.includes(v),
  );

  const artifact = {
    timestamp: new Date().toISOString(),
    commit: gitHeadSha(),
    target: PRODUCTION_PROJECT_REF,
    version,
    name: migration.name,
    sha256: hash,
    path: migration.path,
    localCount: afterLocal.length,
    remoteCount: afterRemote.length,
    remoteOnly,
    localOnly,
    knownPendingRemaining: stillPending,
    unexpectedLedgerAdditions,
    // Computed, never asserted: the count of ledger rows that appeared beyond
    // the one approved version. This artifact is audit evidence, so it must
    // report what happened rather than what was intended.
    otherMigrationsApplied: unexpectedLedgerAdditions.length,
    outcome:
      remoteOnly.length === 0 && localOnly.length === 0 && unexpectedLedgerAdditions.length === 0
        ? stillPending.length === 0
          ? 'ALIGNED'
          : 'ALIGNED_WITH_KNOWN_PENDING'
        : 'UNEXPECTED_DRIFT',
  };

  const dir = ensureArtifactsDir('production-migrations');
  const artifactPath = path.join(dir, `${version}-${migration.name}.json`);
  writeJsonArtifact(artifactPath, artifact);

  console.log(JSON.stringify({ ok: true, artifact: artifactPath, ...artifact }, null, 2));

  // Unexpected drift after the apply is a failure even though the SQL succeeded:
  // the ledger is no longer the ledger this invocation was authorised against.
  if (remoteOnly.length > 0 || localOnly.length > 0 || unexpectedLedgerAdditions.length > 0) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { pendingVersions, remoteHasVersion, selectApprovedMigration };
