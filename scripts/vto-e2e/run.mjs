#!/usr/bin/env node
/**
 * VTO backend E2E harness — CLI entry point.
 *
 * Usage:
 *   node scripts/vto-e2e/run.mjs --mode=contract
 *   node scripts/vto-e2e/run.mjs --mode=staging-dryrun
 *   node scripts/vto-e2e/run.mjs --mode=staging-full-certification --commit-sha=<40-hex>
 *   node scripts/vto-e2e/run.mjs --mode=cleanup --run-tag=<tag>
 *
 * Modes (spec Phase 4.2):
 *   contract                    no live staging mutation; harness unit/
 *                                contract/negative controls only.
 *   staging-dryrun               real deployed vto-generate, real auth/
 *                                entitlement/reservation/release wiring,
 *                                zero-spend fixture — REAL PROVIDER SUBMIT
 *                                stays 0 for the whole run. Mandatory before
 *                                full certification.
 *   staging-full-certification   the ONE authorized real-provider happy
 *                                path. Maximum one paid request, no retry.
 *   cleanup                      removes only artifacts this harness
 *                                created, targeted by exact synthetic actor
 *                                id — never a broad sweep.
 *
 * Node 20+, ESM, built-ins + fetch only.
 */
'use strict';

import { assertVtoStagingTarget, StagingGuardError } from './lib/staging-target.mjs';
import { runSqlViaSupabaseCli } from './lib/sql.mjs';
import { provisionVtoActors, actorIdsByRole } from './lib/provision.mjs';
import { runVtoStagingDryRun } from './lib/dryrun.mjs';
import { runVtoFullCertification } from './lib/fullcert.mjs';
import { cleanupVtoActors, allActorsClean } from './lib/cleanup.mjs';
import { snapshotActorPersistence, diffPersistence } from './lib/persistence.mjs';
import { writeReport } from './lib/report.mjs';

function getArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return fallback;
}

function newRunTag() {
  return `kscan-vto-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runContractMode() {
  // No live staging mutation. The harness's own unit/contract/negative
  // controls live under __tests__/vtoE2e*.test.js (node:test) — this mode
  // simply runs them and reports pass/fail, exactly like `node --test`.
  const { run } = await import('node:test');
  return new Promise((resolve) => {
    const stream = run({ files: [
      new URL('../../__tests__/vtoE2eFixtures.test.js', import.meta.url).pathname,
      new URL('../../__tests__/vtoE2eContractControls.test.js', import.meta.url).pathname,
    ] });
    let pass = 0;
    let fail = 0;
    const failures = [];
    stream.on('test:pass', () => { pass += 1; });
    stream.on('test:fail', (data) => { fail += 1; failures.push(data?.name ?? 'unnamed test'); });
    stream.on('end', () => resolve({ mode: 'contract', pass, fail, failures, ok: fail === 0 }));
    // TestsStream is a Readable; nothing else here consumes it, so it must be
    // explicitly put in flowing mode or 'end' never fires and the run hangs
    // after the first buffered chunk.
    stream.resume();
  });
}

async function runStagingDryRunMode({ runTag }) {
  const target = assertVtoStagingTarget();
  const base = process.env.SUPABASE_STAGING_URL;
  const publishableKey = process.env.SUPABASE_STAGING_PUBLISHABLE_KEY;

  const provisioned = await provisionVtoActors({ base, publishableKey, runSql: runSqlViaSupabaseCli, runTag });
  const ids = actorIdsByRole(provisioned.plan);

  let dryRunResult = null;
  let persistenceBefore = null;
  let persistenceAfter = null;
  let cleanupEvidence = null;
  try {
    if (ids.ACTIVE_KPLUS) persistenceBefore = await snapshotActorPersistence(runSqlViaSupabaseCli, ids.ACTIVE_KPLUS);
    dryRunResult = await runVtoStagingDryRun({
      base, publishableKey, plan: provisioned.plan, tokens: provisioned.tokens, runSql: runSqlViaSupabaseCli, runTag,
    });
    if (ids.ACTIVE_KPLUS) persistenceAfter = await snapshotActorPersistence(runSqlViaSupabaseCli, ids.ACTIVE_KPLUS);
  } finally {
    cleanupEvidence = await cleanupVtoActors(runSqlViaSupabaseCli, ids);
  }

  return {
    mode: 'staging-dryrun',
    target,
    runTag,
    provisioning: provisioned.evidence,
    results: dryRunResult?.results ?? [],
    fixturesEvidence: dryRunResult?.fixturesEvidence ?? null,
    realProviderSubmits: dryRunResult?.realProviderSubmits ?? null,
    paidGenerations: dryRunResult?.paidGenerations ?? null,
    persistence: persistenceBefore && persistenceAfter ? diffPersistence(persistenceBefore, persistenceAfter) : null,
    cleanupEvidence,
    cleanupClean: allActorsClean(cleanupEvidence),
    ok: Boolean(dryRunResult?.results?.every((r) => r.ok !== false)) && allActorsClean(cleanupEvidence),
  };
}

async function runStagingFullCertificationMode({ runTag, commitSha }) {
  if (!commitSha) {
    throw new Error('--commit-sha=<40-hex merge SHA> is required for staging-full-certification (the committed garment fixture must be fetched from an exact, pinned commit)');
  }
  const target = assertVtoStagingTarget();
  const base = process.env.SUPABASE_STAGING_URL;
  const publishableKey = process.env.SUPABASE_STAGING_PUBLISHABLE_KEY;

  const provisioned = await provisionVtoActors({
    base, publishableKey, runSql: runSqlViaSupabaseCli, runTag,
  });
  const ids = actorIdsByRole(provisioned.plan);

  let certResult = null;
  let persistenceBefore = null;
  let persistenceAfter = null;
  let cleanupEvidence = null;
  try {
    if (!provisioned.tokens.ACTIVE_KPLUS) {
      throw new Error('ACTIVE_KPLUS actor did not authenticate — refusing to spend without a proven active actor');
    }
    persistenceBefore = await snapshotActorPersistence(runSqlViaSupabaseCli, ids.ACTIVE_KPLUS);
    certResult = await runVtoFullCertification({
      base, publishableKey, accessToken: provisioned.tokens.ACTIVE_KPLUS,
      userId: ids.ACTIVE_KPLUS, runSql: runSqlViaSupabaseCli, commitSha, runTag,
    });
    persistenceAfter = await snapshotActorPersistence(runSqlViaSupabaseCli, ids.ACTIVE_KPLUS);
  } finally {
    // Cleanup here removes the ACTOR (identity + entitlement); it never
    // "un-spends" the one paid provider call, which is by design permanent.
    cleanupEvidence = await cleanupVtoActors(runSqlViaSupabaseCli, ids);
  }

  return {
    mode: 'staging-full-certification',
    target,
    runTag,
    provisioning: provisioned.evidence,
    results: certResult?.results ?? [],
    requestsSent: certResult?.requestsSent ?? 0,
    httpStatusClass: certResult?.httpStatusClass ?? null,
    totalRequestDurationBucket: certResult?.totalRequestDurationBucket ?? null,
    finalResultValidation: certResult?.finalResultValidation ?? 'FAIL',
    reservationSettlement: certResult?.reservationSettlement ?? null,
    paidRetryAttempted: certResult?.paidRetryAttempted ?? false,
    persistence: persistenceBefore && persistenceAfter ? diffPersistence(persistenceBefore, persistenceAfter) : null,
    cleanupEvidence,
    cleanupClean: allActorsClean(cleanupEvidence),
    ok: certResult?.finalResultValidation === 'PASS',
  };
}

async function runCleanupMode({ runTag }) {
  if (!runTag) throw new Error('--run-tag=<tag> is required for cleanup mode');
  // Cleanup-mode recovery: re-derive the same deterministic emails the
  // original run would have provisioned, look each up, and remove exactly
  // those rows if present. No broad sweep, ever.
  const { buildActorPlan } = await import('./lib/actors.mjs');
  const plan = buildActorPlan(runTag);
  const ids = {};
  for (const [role, actor] of Object.entries(plan)) {
    const rows = await runSqlViaSupabaseCli(
      `select id from auth.users where email = '${actor.email.replace(/'/g, "''")}' limit 1;`,
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row?.id) ids[role] = row.id;
  }
  const cleanupEvidence = await cleanupVtoActors(runSqlViaSupabaseCli, ids);
  return { mode: 'cleanup', runTag, cleanupEvidence, ok: allActorsClean(cleanupEvidence) };
}

async function main() {
  const mode = getArg('--mode');
  const runTag = getArg('--run-tag') || newRunTag();
  const commitSha = getArg('--commit-sha');

  let report;
  try {
    if (mode === 'contract') {
      report = await runContractMode();
    } else if (mode === 'staging-dryrun') {
      report = await runStagingDryRunMode({ runTag });
    } else if (mode === 'staging-full-certification') {
      report = await runStagingFullCertificationMode({ runTag, commitSha });
    } else if (mode === 'cleanup') {
      report = await runCleanupMode({ runTag });
    } else {
      console.error(`Unknown or missing --mode (got ${JSON.stringify(mode)}). Expected one of: contract, staging-dryrun, staging-full-certification, cleanup.`);
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof StagingGuardError) {
      console.error(`STAGING GUARD REFUSED: ${err.message}`);
      process.exit(2);
    }
    console.error(err.stack || err.message);
    process.exit(1);
  }

  process.stdout.write(writeReport(report));
  process.exit(report.ok ? 0 : 1);
}

main();
