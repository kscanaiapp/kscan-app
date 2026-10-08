#!/usr/bin/env node
/**
 * VTO backend E2E harness — CLI entry point.
 *
 * Usage:
 *   node scripts/vto-e2e/run.mjs --mode=contract
 *   node scripts/vto-e2e/run.mjs --mode=staging-dryrun
 *   node scripts/vto-e2e/run.mjs --mode=staging-full-certification --commit-sha=<40-hex>
 *   node scripts/vto-e2e/run.mjs --mode=cleanup --run-tag=<tag>
 *   node scripts/vto-e2e/run.mjs --mode=cleanup --user-ids=<uuid>[,<uuid>...]
 *   node scripts/vto-e2e/run.mjs --mode=staging-user-garment-dryrun
 *   node scripts/vto-e2e/run.mjs --mode=staging-user-garment-certification
 *   node scripts/vto-e2e/run.mjs --mode=staging-user-garment-log-audit \
 *        --audit-run-tag=<tag of the run under audit> --since=<iso> --until=<iso> --expect-dispatches=<0|1>
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
 * The `user_supplied_garment` source (a garment photo the customer gave
 * Elise, sent inline) has its own three modes, its own actor namespace and
 * its own cleanup ledger. K+ is granted and revoked only through the
 * canonical authority — these modes write no entitlement table:
 *   staging-user-garment-dryrun         zero spend; the contract boundary,
 *                                       including the request-size ceilings.
 *   staging-user-garment-certification  the ONE authorized real-provider
 *                                       request for this source. No retry.
 *   staging-user-garment-log-audit      read-only; what the Edge runtime
 *                                       logged during a run's window.
 *
 * Node 20+, ESM, built-ins + fetch only.
 */
'use strict';

import { assertVtoStagingTarget, StagingGuardError } from './lib/staging-target.mjs';
import { runSqlViaSupabaseCli, sqlQuote } from './lib/sql.mjs';
import { provisionVtoActors, actorIdsByRole } from './lib/provision.mjs';
import { runVtoStagingDryRun } from './lib/dryrun.mjs';
import { runVtoFullCertification } from './lib/fullcert.mjs';
import { cleanupVtoActors, allActorsClean, summarizeCleanupStatus } from './lib/cleanup.mjs';
import { snapshotActorPersistence, diffPersistence } from './lib/persistence.mjs';
import { writeReport } from './lib/report.mjs';
import {
  provisionUserGarmentActor,
  buildUserGarmentActor,
  userGarmentGrantKey,
  canonicalKPlusAuthorityPresent,
  cleanupUserGarmentActor,
  summarizeUserGarmentCleanup,
} from './lib/userGarmentActor.mjs';
import {
  runUserGarmentDryRun,
  runUserGarmentCertification,
  MAX_REAL_VTO_PROVIDER_DISPATCHES,
} from './lib/userGarmentProbe.mjs';
import { loadCommittedUserGarment } from './lib/userGarment.mjs';
import { runUserGarmentLogAudit, scanLogLines } from './lib/logAudit.mjs';
import { gitHeadSha } from '../lib/staging-helpers.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The commit the harness is actually RUNNING as — the certification
 * artifact's schema-required `authoritySha` (repair spec §7/§37). GITHUB_SHA
 * is set by every GitHub Actions job automatically; gitHeadSha() (a plain
 * `git rev-parse HEAD`) covers a manual/local invocation. Deliberately NOT
 * the same value as staging-full-certification's --commit-sha, which pins
 * only which commit the garment fixture ASSET is fetched from and may be
 * overridden to an older commit while running current harness code.
 */
function resolveAuthoritySha() {
  return process.env.GITHUB_SHA || gitHeadSha() || null;
}

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
    // fileURLToPath, NOT `.pathname`: on Windows a file URL's pathname is
    // `/C:/...`, which node:test cannot resolve -- so all three files failed
    // to LOAD and the mode reported `pass: 0, fail: 3` with the paths
    // themselves as the failure names. Contract mode was therefore unrunnable
    // on a Windows workstation (Linux CI was unaffected, which is why it
    // survived). A certification harness that cannot run where the repair is
    // being done is a harness the repair cannot use.
    const stream = run({ files: [
      fileURLToPath(new URL('../../__tests__/vtoE2eFixtures.test.js', import.meta.url)),
      fileURLToPath(new URL('../../__tests__/vtoE2eContractControls.test.js', import.meta.url)),
      fileURLToPath(new URL('../../__tests__/vtoE2eHarnessIntegrity.test.js', import.meta.url)),
      fileURLToPath(new URL('../../__tests__/vtoE2eUserGarmentProbe.test.js', import.meta.url)),
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

  const controls = dryRunResult?.results ?? [];
  const providerSubmits = dryRunResult?.realProviderSubmits ?? 0;
  const paidRequests = dryRunResult?.paidGenerations ?? 0;
  const cleanupStatus = summarizeCleanupStatus(cleanupEvidence);
  const ok = Boolean(controls.length > 0 && controls.every((r) => r.ok !== false))
    && cleanupStatus.clean
    && providerSubmits === 0
    && paidRequests === 0;

  return {
    // Certification artifact schema (repair spec §7/§37) — read by
    // scripts/vto-e2e/validate-report.mjs and by any consumer treating this
    // file, not the workflow conclusion, as the primary verdict.
    runId: runTag,
    projectRef: target.projectRef,
    mode: 'staging-dryrun',
    authoritySha: resolveAuthoritySha(),
    controls,
    providerSubmits,
    paidRequests,
    cleanupStatus,
    verdict: ok ? 'PASS' : 'FAIL',
    // Legacy/internal detail, kept for evidence and backward compatibility.
    target,
    runTag,
    provisioning: provisioned.evidence,
    results: controls,
    fixturesEvidence: dryRunResult?.fixturesEvidence ?? null,
    realProviderSubmits: providerSubmits,
    paidGenerations: paidRequests,
    persistence: persistenceBefore && persistenceAfter ? diffPersistence(persistenceBefore, persistenceAfter) : null,
    cleanupEvidence,
    cleanupClean: cleanupStatus.clean,
    ok,
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

  const controls = certResult?.results ?? [];
  // The ONE authorized real-provider happy path: exactly one real submit
  // and one paid request when this mode actually ran a request, zero if it
  // never got there (e.g. ACTIVE_KPLUS failed to authenticate).
  const providerSubmits = certResult?.requestsSent ?? 0;
  const paidRequests = certResult?.requestsSent ?? 0;
  const cleanupStatus = summarizeCleanupStatus(cleanupEvidence);
  const ok = certResult?.finalResultValidation === 'PASS' && cleanupStatus.clean;

  return {
    runId: runTag,
    projectRef: target.projectRef,
    mode: 'staging-full-certification',
    authoritySha: resolveAuthoritySha(),
    controls,
    providerSubmits,
    paidRequests,
    cleanupStatus,
    verdict: ok ? 'PASS' : 'FAIL',
    // Legacy/internal detail, kept for evidence and backward compatibility.
    target,
    runTag,
    provisioning: provisioned.evidence,
    results: controls,
    requestsSent: certResult?.requestsSent ?? 0,
    httpStatusClass: certResult?.httpStatusClass ?? null,
    totalRequestDurationBucket: certResult?.totalRequestDurationBucket ?? null,
    finalResultValidation: certResult?.finalResultValidation ?? 'FAIL',
    reservationSettlement: certResult?.reservationSettlement ?? null,
    paidRetryAttempted: certResult?.paidRetryAttempted ?? false,
    persistence: persistenceBefore && persistenceAfter ? diffPersistence(persistenceBefore, persistenceAfter) : null,
    cleanupEvidence,
    cleanupClean: cleanupStatus.clean,
    ok,
  };
}

/**
 * Shared front half of the two `user_supplied_garment` staging modes: assert
 * the target, prove the canonical K+ authority is deployed, create the actor.
 * Grants nothing — each mode grants for itself, through the authority.
 */
async function openUserGarmentRun({ runTag }) {
  const target = assertVtoStagingTarget();
  const base = process.env.SUPABASE_STAGING_URL;
  const publishableKey = process.env.SUPABASE_STAGING_PUBLISHABLE_KEY;
  const authority = await canonicalKPlusAuthorityPresent(runSqlViaSupabaseCli);
  const controls = [{
    name: 'the canonical K+ authority is deployed on the target (grant, revoke, predicate)',
    ok: authority.all,
    detail: `grant_kplus_complimentary=${authority.grant} revoke_kplus_grant=${authority.revoke} kplus_has_active_entitlement=${authority.predicate}`,
  }];
  let provisioned = null;
  if (authority.all) {
    provisioned = await provisionUserGarmentActor({ base, publishableKey, runSql: runSqlViaSupabaseCli, runTag });
    controls.push({
      name: 'synthetic actor: real signup, fresh password grant, no entitlement written',
      ok: Boolean(provisioned.accessToken && provisioned.actor.userId),
      detail: `signedUp=${provisioned.evidence.signedUp} signedIn=${provisioned.evidence.signedIn}`
        + `${provisioned.evidence.error ? ` error=${provisioned.evidence.error}` : ''}`
        + `${provisioned.evidence.signInError ? ` signInError=${provisioned.evidence.signInError}` : ''}`,
    });
  }
  return { target, base, publishableKey, controls, provisioned };
}

/**
 * The uploaded artifact is checked with the same rules the log audit applies
 * to the Edge logs: no payload and no credential may be in it. The garment
 * fingerprint is deliberately NOT a rule here — it identifies a committed,
 * public, synthetic file and is part of the evidence.
 */
function assertArtifactCarriesNoPayload(report) {
  const scan = scanLogLines([JSON.stringify(report)]);
  const leaked = scan.hits.filter((hit) => hit.matches > 0).map((hit) => hit.id);
  if (leaked.length > 0) {
    throw new Error(`report hygiene violation: the artifact would carry ${leaked.join(', ')}`);
  }
  return report;
}

async function runStagingUserGarmentDryRunMode({ runTag }) {
  const windowStartedAt = new Date().toISOString();
  const { target, base, publishableKey, controls, provisioned } = await openUserGarmentRun({ runTag });
  let dryRun = null;
  let ledger = null;
  let runError = null;
  try {
    if (provisioned?.accessToken && provisioned.actor.userId) {
      dryRun = await runUserGarmentDryRun({
        base, publishableKey, accessToken: provisioned.accessToken, userId: provisioned.actor.userId,
        runSql: runSqlViaSupabaseCli, runTag, grantKey: userGarmentGrantKey(runTag),
      });
      controls.push(...dryRun.results);
    }
  } catch (err) {
    runError = err.message;
    controls.push({ name: 'the dry run completed without an unexpected error', ok: false, detail: err.message });
  } finally {
    if (provisioned?.actor.userId) {
      ledger = await cleanupUserGarmentActor(runSqlViaSupabaseCli, { userId: provisioned.actor.userId, grantId: dryRun?.grantId ?? null });
    }
  }

  const cleanupStatus = summarizeUserGarmentCleanup(ledger);
  const ok = Boolean(dryRun) && !runError && controls.every((entry) => entry.ok !== false) && cleanupStatus.clean;
  return assertArtifactCarriesNoPayload({
    runId: runTag,
    projectRef: target.projectRef,
    mode: 'staging-user-garment-dryrun',
    authoritySha: resolveAuthoritySha(),
    controls,
    // Structural, not measured: runUserGarmentDryRun refuses to send any
    // request that could reach the provider.
    providerSubmits: 0,
    paidRequests: 0,
    cleanupStatus,
    verdict: ok ? 'PASS' : 'FAIL',
    target,
    runTag,
    provisioning: provisioned?.evidence ?? null,
    sizeEvidence: dryRun?.sizeEvidence ?? null,
    nearCeilingRuntimeProof: dryRun?.sizeEvidence?.nearCeilingRuntimeProof ?? 'PENDING',
    // What the log audit needs to find exactly this run.
    logAuditWindow: { since: windowStartedAt, until: new Date().toISOString(), runTag },
    cleanupClean: cleanupStatus.clean,
    ok,
  });
}

async function runStagingUserGarmentCertificationMode({ runTag }) {
  const { target, base, publishableKey, controls, provisioned } = await openUserGarmentRun({ runTag });
  let cert = null;
  let ledger = null;
  let runError = null;
  try {
    if (provisioned?.accessToken && provisioned.actor.userId) {
      cert = await runUserGarmentCertification({
        base, publishableKey, accessToken: provisioned.accessToken, userId: provisioned.actor.userId,
        runSql: runSqlViaSupabaseCli, runTag, grantKey: userGarmentGrantKey(runTag),
      });
      controls.push(...cert.results);
    }
  } catch (err) {
    runError = err.message;
    controls.push({ name: 'the certification completed without an unexpected error', ok: false, detail: err.message });
  } finally {
    // Removes the actor; it never "un-spends" the one provider call.
    if (provisioned?.actor.userId) {
      ledger = await cleanupUserGarmentActor(runSqlViaSupabaseCli, { userId: provisioned.actor.userId, grantId: cert?.grantId ?? null });
    }
  }

  const cleanupStatus = summarizeUserGarmentCleanup(ledger);
  const budgetUsed = cert?.budgetUsed ?? 0;
  const ok = cert?.finalResultValidation === 'PASS' && !runError && cleanupStatus.clean;
  return assertArtifactCarriesNoPayload({
    runId: runTag,
    projectRef: target.projectRef,
    mode: 'staging-user-garment-certification',
    authoritySha: resolveAuthoritySha(),
    controls,
    providerSubmits: budgetUsed,
    paidRequests: budgetUsed,
    cleanupStatus,
    verdict: ok ? 'PASS' : 'FAIL',
    target,
    runTag,
    provisioning: provisioned?.evidence ?? null,
    maxRealProviderDispatches: MAX_REAL_VTO_PROVIDER_DISPATCHES,
    budgetUsed,
    requestsSent: cert?.requestsSent ?? 0,
    dispatchClassification: cert?.dispatchClassification ?? 'not_sent',
    // `budgetUsed` is the harness's CONSERVATIVE count: an outcome it cannot
    // prove was refused before the provider is counted as a dispatch. The
    // server's own record is the `vto_generate_start` count the log audit
    // reads back for this run tag; for an ambiguous outcome that record is
    // the authority.
    budgetAuthority: 'harness count is conservative; staging-user-garment-log-audit dispatchesLogged is the server record',
    paidRetryAttempted: false,
    proof: cert?.proof ?? null,
    finalResultValidation: cert?.finalResultValidation ?? 'FAIL',
    reservationSettlement: cert?.reservationSettlement ?? null,
    httpStatusClass: cert?.httpStatusClass ?? null,
    totalRequestDurationBucket: cert?.totalRequestDurationBucket ?? null,
    requestBodyChars: cert?.requestBodyChars ?? null,
    featureControl: cert?.featureControl ?? null,
    garmentEvidence: cert?.garmentEvidence ?? null,
    personEvidence: cert?.personEvidence ?? null,
    responseEvidence: cert?.evidence ?? null,
    // What the log audit needs to find exactly this run.
    logAuditWindow: { since: cert?.windowStartedAt ?? null, until: cert?.windowEndedAt ?? null, runTag },
    cleanupClean: cleanupStatus.clean,
    ok,
  });
}

async function runStagingUserGarmentLogAuditMode({ runTag, auditedRunTag, since, until, expectDispatches }) {
  const target = assertVtoStagingTarget();
  if (!auditedRunTag) throw new Error('--audit-run-tag=<run tag of the run under audit> is required');
  if (![0, 1].includes(expectDispatches)) throw new Error('--expect-dispatches must be 0 or 1');
  const audit = await runUserGarmentLogAudit({
    projectRef: target.projectRef,
    supabaseUrl: process.env.SUPABASE_STAGING_URL,
    managementCredential: process.env.SUPABASE_ACCESS_TOKEN?.trim(),
    since,
    until,
    runMarker: auditedRunTag,
    contentHash: loadCommittedUserGarment().contentHash,
    expectDispatches,
  });
  const ok = audit.results.every((entry) => entry.ok);
  return assertArtifactCarriesNoPayload({
    runId: runTag,
    projectRef: target.projectRef,
    mode: 'staging-user-garment-log-audit',
    authoritySha: resolveAuthoritySha(),
    controls: audit.results,
    providerSubmits: 0,
    paidRequests: 0,
    // Read-only: this mode creates nothing, so there is nothing to remove.
    cleanupStatus: { usersRemaining: 0, entitlementsRemaining: 0, vtoRequestsRemaining: 0, clean: true, readOnly: true },
    verdict: ok ? 'PASS' : 'FAIL',
    target,
    runTag,
    auditedRunTag,
    window: { since, until },
    sources: audit.sources,
    linesScanned: audit.linesScanned,
    runEvents: audit.runEvents,
    dispatchesLogged: audit.dispatchesLogged,
    serverLoggedCategory: audit.serverLoggedCategory,
    serverLoggedSlot: audit.serverLoggedSlot,
    serverLoggedProvider: audit.serverLoggedProvider,
    noRawImageLogging: ok ? 'PASS' : 'FAIL',
    ok,
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function runCleanupMode({ runTag, userIds = [] }) {
  if (!runTag && userIds.length === 0) {
    throw new Error('--run-tag=<tag> or --user-ids=<uuid[,uuid...]> is required for cleanup mode');
  }
  for (const id of userIds) {
    if (!UUID_PATTERN.test(id)) throw new Error(`--user-ids contains a value that is not a UUID: ${JSON.stringify(id)}`);
  }
  // Unlike the other two live-mutation modes, cleanup issues real DELETEs
  // with no other structural staging/production check anywhere in its own
  // call path — it must assert the target itself rather than rely solely on
  // the workflow's env being correctly staging-scoped.
  assertVtoStagingTarget();

  const ids = {};
  if (runTag) {
    // Cleanup-mode recovery: re-derive the same deterministic emails the
    // original run would have provisioned, look each up, and remove exactly
    // those rows if present. No broad sweep, ever.
    const { buildActorPlan } = await import('./lib/actors.mjs');
    const plan = buildActorPlan(runTag);
    for (const [role, actor] of Object.entries(plan)) {
      const rows = await runSqlViaSupabaseCli(
        `select id from auth.users where email = ${sqlQuote(actor.email)} limit 1;`,
      );
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.id) ids[role] = row.id;
    }
  }
  // Explicit, incident-driven targeting by exact known id — the same
  // guarded cleanupActor path, still never a broad sweep, used when a
  // specific orphaned actor id is already known from evidence (e.g. a prior
  // run's crash log) rather than re-derivable from a run tag.
  userIds.forEach((id, i) => { ids[`MANUAL_${i}`] = id; });

  // A `user_supplied_garment` run under this tag has its own actor, in its own
  // namespace. It is recovered through its OWN ledger, which revokes K+ via
  // the canonical authority before the identity goes -- never through the
  // entitlement-table cleanup the older actors use.
  let userGarmentLedger = null;
  if (runTag) {
    const rows = await runSqlViaSupabaseCli(
      `select id from auth.users where email = ${sqlQuote(buildUserGarmentActor(runTag).email)} limit 1;`,
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row?.id) userGarmentLedger = await cleanupUserGarmentActor(runSqlViaSupabaseCli, { userId: row.id });
  }

  const cleanupEvidence = await cleanupVtoActors(runSqlViaSupabaseCli, ids);
  return {
    mode: 'cleanup',
    runTag: runTag ?? null,
    userIds,
    cleanupEvidence,
    userGarmentLedger,
    ok: allActorsClean(cleanupEvidence) && (userGarmentLedger === null || userGarmentLedger.clean),
  };
}

async function main() {
  const mode = getArg('--mode');
  const runTagArg = getArg('--run-tag');
  const commitSha = getArg('--commit-sha');
  const userIdsArg = getArg('--user-ids');
  const userIds = userIdsArg ? userIdsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const expectDispatchesArg = getArg('--expect-dispatches');

  let report;
  try {
    if (mode === 'contract') {
      report = await runContractMode();
    } else if (mode === 'staging-dryrun') {
      report = await runStagingDryRunMode({ runTag: runTagArg || newRunTag() });
    } else if (mode === 'staging-full-certification') {
      report = await runStagingFullCertificationMode({ runTag: runTagArg || newRunTag(), commitSha });
    } else if (mode === 'cleanup') {
      // Deliberately NOT falling back to a freshly-generated tag here (unlike
      // the two modes above): cleanup must fail closed on a missing target
      // rather than silently look up a tag nothing was ever provisioned
      // under and vacuously report ok:true having cleaned nothing.
      report = await runCleanupMode({ runTag: runTagArg || null, userIds });
    } else if (mode === 'staging-user-garment-dryrun') {
      report = await runStagingUserGarmentDryRunMode({ runTag: runTagArg || newRunTag() });
    } else if (mode === 'staging-user-garment-certification') {
      report = await runStagingUserGarmentCertificationMode({ runTag: runTagArg || newRunTag() });
    } else if (mode === 'staging-user-garment-log-audit') {
      report = await runStagingUserGarmentLogAuditMode({
        runTag: runTagArg || newRunTag(),
        auditedRunTag: getArg('--audit-run-tag'),
        since: getArg('--since'),
        until: getArg('--until'),
        expectDispatches: expectDispatchesArg === null ? NaN : Number(expectDispatchesArg),
      });
    } else {
      console.error(`Unknown or missing --mode (got ${JSON.stringify(mode)}). Expected one of: contract, staging-dryrun, staging-full-certification, cleanup, staging-user-garment-dryrun, staging-user-garment-certification, staging-user-garment-log-audit.`);
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

// Only run when invoked as a script; importing (e.g. from a contract-mode
// test exercising runCleanupMode's own guard directly) must not dispatch
// anything or touch process.argv/exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  runContractMode, runStagingDryRunMode, runStagingFullCertificationMode, runCleanupMode, resolveAuthoritySha,
  runStagingUserGarmentDryRunMode, runStagingUserGarmentCertificationMode, runStagingUserGarmentLogAuditMode,
  assertArtifactCarriesNoPayload,
};
