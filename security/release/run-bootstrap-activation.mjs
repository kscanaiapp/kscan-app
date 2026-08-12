#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Staging activation orchestrator — the executable control path Phase 2B was
 * missing (DEF-REL-012).
 *
 * Phase 2B produced the release-verification MODEL: manifest/freeze, bootstrap
 * planning, candidate binding, receipts, exact verification, evidence
 * aggregation, baseline minting. Every piece was a library nobody called, and
 * the health contract read release-identity variables nothing set. This module
 * is the caller.
 *
 * It ORCHESTRATES; it does not reimplement. Every decision still belongs to the
 * merged Phase 2A/2B libraries — this file sequences them, carries state
 * between them, and enforces the ordering the activation brief requires.
 *
 * ─── ORDERING (the part that matters) ───────────────────────────────────────
 *
 * Supabase release metadata becomes visible to Edge Functions independently of
 * a code deploy. So metadata must NOT be written before the governed function
 * set is actually deployed, or /version would advertise a release that is not
 * yet running. The required order is:
 *
 *   deploy all governed functions EXCEPT staging-health
 *     -> all must PASS
 *   write the six KSCAN_* release-identity values
 *     -> must PASS
 *   deploy staging-health LAST, from the same frozen candidate
 *
 * A failure at any step stops the sequence and finalizes a truthful failed
 * receipt. Nothing is rolled back — rollback is Phase 3 — but enough state is
 * recorded for manual recovery.
 *
 * ─── MODES ──────────────────────────────────────────────────────────────────
 *
 *   PLAN_ONLY  read-only; no Supabase write, no deploy, no metadata, no tag
 *   EXECUTE    governed CI only; fails closed elsewhere
 *
 * Node built-ins only.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authority from '../scripts/lib/environment-authority.js';
import manifestModule from './generate-release-manifest.js';
import bindingModule from './candidate-binding.js';
import receiptModule from './deployment-receipt.js';
import verifierModule from './verify-exact-candidate.js';
import evidenceModule from './build-release-evidence.js';
import baselineModule from './verified-baseline.js';
import smokeModule from './run-release-smoke.js';
import metadataWriter from './set-staging-release-metadata.mjs';
import deployCore from './staging-deploy-core.mjs';
import packageModule from './verified-release-package.mjs';

const { STAGING_REF, PRODUCTION_REF, assertExpectedEnvironment } = authority;
const { generateReleaseManifest, freezeManifest, verifyFreeze } = manifestModule;
const { bindCandidate } = bindingModule;
const { createReceipt, finalizeReceipt } = receiptModule;
const { verifyExactCandidate, RESULT } = verifierModule;
const { buildReleaseEvidence, canEnterStagingVerified, STATUS } = evidenceModule;
const { planBootstrapFullAttestation, mintVerifiedBaseline, validateVerifiedBaseline } = baselineModule;
const { runReleaseSmoke } = smokeModule;
const { setStagingReleaseMetadata } = metadataWriter;
const { materializeCandidate, deployOneFromCandidate } = deployCore;
const { buildPackage, publishPackage } = packageModule;

export const MODE = Object.freeze({ PLAN_ONLY: 'PLAN_ONLY', EXECUTE: 'EXECUTE' });
export const HEALTH_FUNCTION = 'staging-health';

export class ActivationError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'ActivationError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * EXECUTE is a governed-CI-only capability.
 *
 * A developer running EXECUTE from a laptop would bypass the staging
 * environment's protection rules and the audited run record, so it fails
 * closed. PLAN_ONLY is always permitted — it writes nothing.
 */
export function assertExecuteAuthority(env = process.env) {
  const inGithubActions = String(env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
  const inStagingEnvironment = env.KSCAN_ACTIVATION_ENVIRONMENT === 'staging';
  if (!inGithubActions || !inStagingEnvironment) {
    throw new ActivationError(
      'EXECUTE is available only from the governed staging activation workflow '
      + '(requires GITHUB_ACTIONS=true and KSCAN_ACTIVATION_ENVIRONMENT=staging). '
      + 'Use PLAN_ONLY locally.',
      'EXECUTE_NOT_AUTHORIZED',
    );
  }
}

const git = (repoRoot, args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();

/** `staging-bootstrap-<shortsha>-<UTC compact>` — observational only, never hashed. */
export function buildReleaseId(candidateSha, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  return `staging-bootstrap-${candidateSha.slice(0, 7)}-${stamp}`;
}

/**
 * Partitions the approved bootstrap plan so staging-health is always last.
 * The count is never hardcoded — it comes from the planner.
 */
export function partitionBootstrapPlan(functions) {
  const set = [...functions];
  const healthEntries = set.filter((f) => f === HEALTH_FUNCTION);
  if (healthEntries.length === 0) {
    throw new ActivationError(
      `${HEALTH_FUNCTION} is absent from the governed bootstrap plan; it carries release identity and must be deployed`,
      'HEALTH_FUNCTION_MISSING_FROM_PLAN',
    );
  }
  if (healthEntries.length > 1) {
    throw new ActivationError(
      `more than one ${HEALTH_FUNCTION} entry in the bootstrap plan`,
      'MULTIPLE_HEALTH_IDENTITY_FUNCTIONS',
    );
  }
  return {
    nonHealth: set.filter((f) => f !== HEALTH_FUNCTION).sort(),
    health: HEALTH_FUNCTION,
  };
}

/**
 * Runs the activation.
 *
 * Adapters (`deps`) are injected so the whole sequence is unit-testable without
 * a Supabase project, a GitHub API, or a network.
 */
export async function runBootstrapActivation({
  repoRoot,
  mode = MODE.PLAN_ONLY,
  projectRef = STAGING_REF,
  liveFunctionNames,
  liveMigrationNames,
  priorVerifiedRelease = null,
  certification = null,
  deploymentRunId = 'local',
  now = () => new Date(),
  env = process.env,
  deps = {},
} = {}) {
  const steps = [];
  const record = (name, status, detail) => {
    steps.push({ name, status, detail: detail || null });
    return status;
  };

  const {
    deployFn = deployOneFromCandidate,
    setMetadata = setStagingReleaseMetadata,
    probeHealth = null,
    smokeFn = runReleaseSmoke,
    github = null,
    materialize = materializeCandidate,
  } = deps;

  // ── environment authority, before anything else ──────────────────────────
  if (projectRef === PRODUCTION_REF) {
    throw new ActivationError(
      `PRODUCTION PROJECT REJECTED: activation may never target ${PRODUCTION_REF}`,
      'PRODUCTION_TARGET_REJECTED',
    );
  }
  assertExpectedEnvironment('staging', projectRef);
  record('environment_authority', STATUS.PASS);

  if (mode === MODE.EXECUTE) assertExecuteAuthority(env);

  // ── candidate + manifest + freeze ────────────────────────────────────────
  const candidateSha = git(repoRoot, ['rev-parse', 'HEAD']);
  const candidateTreeSha = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const releaseId = buildReleaseId(candidateSha, now());

  const manifest = generateReleaseManifest({
    repoRoot,
    releaseId,
    sourceSha: candidateSha,
    sourceTreeSha: candidateTreeSha,
    candidateEnvironment: 'staging',
    candidateProjectRef: projectRef,
    liveFunctionNames,
    env,
  });
  const frozen = freezeManifest(manifest);
  const freezeCheck = verifyFreeze(frozen, manifest);
  record('freeze', freezeCheck.valid ? STATUS.PASS : STATUS.BLOCKED,
    freezeCheck.valid ? null : freezeCheck.reasons.join('; '));
  if (!freezeCheck.valid) {
    return { ok: false, mode, releaseId, steps, code: 'FREEZE_INVALID' };
  }

  // ── prior baseline: bootstrap is one-time ────────────────────────────────
  if (priorVerifiedRelease) {
    record('prior_baseline', STATUS.BLOCKED, 'a verified baseline already exists; bootstrap is an initialization exception');
    return { ok: false, mode, releaseId, steps, code: 'BOOTSTRAP_BASELINE_ALREADY_EXISTS' };
  }
  record('prior_baseline', STATUS.PASS, 'none (expected for bootstrap)');

  // ── bootstrap plan ───────────────────────────────────────────────────────
  const plan = planBootstrapFullAttestation({
    manifest,
    frozen,
    environment: 'staging',
    projectRef,
    liveFunctionNames,
    previousVerifiedState: null,
    freezeValid: freezeCheck.valid,
    candidateBindingOk: true,
  });
  if (!plan.ok) {
    record('bootstrap_plan', STATUS.BLOCKED, plan.refusals.map((r) => r.code).join('; '));
    return { ok: false, mode, releaseId, steps, code: plan.refusals[0]?.code || 'BOOTSTRAP_PLAN_REFUSED', refusals: plan.refusals };
  }
  const partition = partitionBootstrapPlan(plan.plan.functions);
  record('bootstrap_plan', STATUS.PASS, `${plan.plan.functions.length} functions; ${HEALTH_FUNCTION} last`);

  // ── migration state ──────────────────────────────────────────────────────
  const expectedMigrations = manifest.migrations.map((m) => m.name);
  const liveMigrations = new Set(liveMigrationNames || []);
  const missingMigrations = expectedMigrations.filter((n) => !liveMigrations.has(n));
  record('migration_state', missingMigrations.length === 0 ? STATUS.PASS : STATUS.BLOCKED,
    missingMigrations.length === 0 ? `${expectedMigrations.length} satisfied` : `missing: ${missingMigrations.join(', ')}`);
  if (missingMigrations.length > 0) {
    return { ok: false, mode, releaseId, steps, code: 'MIGRATION_STATE_UNSATISFIED', missingMigrations };
  }

  // ── candidate binding ────────────────────────────────────────────────────
  const binding = bindCandidate({
    repoRoot,
    candidateRef: candidateSha,
    frozen,
    manifest,
    expectedEnvironment: 'staging',
    projectRef,
    functions: plan.plan.functions,
    migrations: [],
    verifyFreeze,
  });
  record('candidate_binding', binding.ok ? STATUS.PASS : STATUS.BLOCKED,
    binding.ok ? null : binding.violations.map((v) => v.code).join('; '));
  if (!binding.ok) {
    return { ok: false, mode, releaseId, steps, code: 'CANDIDATE_BINDING_FAILED', violations: binding.violations };
  }

  const deploymentPlan = {
    order: [...partition.nonHealth, partition.health],
    nonHealth: partition.nonHealth,
    health: partition.health,
    metadataAfter: partition.nonHealth.length,
    migrations: [],
  };

  // ── PLAN_ONLY stops here, having written nothing ─────────────────────────
  if (mode === MODE.PLAN_ONLY) {
    const metadataPlan = setMetadata({
      fields: {
        releaseId,
        sourceSha: candidateSha,
        sourceTreeSha: candidateTreeSha,
        manifestDigest: manifest.identityDigest,
        healthContractVersion: manifest.healthContractVersion,
        deployedAt: now().toISOString(),
      },
      projectRef,
      planOnly: true,
    });
    record('plan_only_complete', STATUS.PASS, 'no Supabase write, no deploy, no metadata, no tag');
    return {
      ok: true,
      mode,
      releaseId,
      candidateSha,
      candidateTreeSha,
      manifestDigest: manifest.identityDigest,
      healthContractVersion: manifest.healthContractVersion,
      configFingerprint: manifest.configFingerprint,
      steps,
      plan: {
        functions: plan.plan.functions,
        excludedByGovernance: plan.plan.excludedByGovernance,
        deploymentPlan,
        metadataPlan: metadataPlan.plan,
        persistence: { tag: packageModule.buildStagingTag({ candidateSha, releaseId }), prerelease: true, assets: Object.values(packageModule.ASSET_NAMES) },
      },
      mutated: false,
    };
  }

  // ══ EXECUTE ══════════════════════════════════════════════════════════════

  const startedAt = now().toISOString();
  let receipt = createReceipt({ binding: binding.binding, deploymentRunId, deploymentAttempt: 1, startedAt,
    preDeployVerification: { status: STATUS.PASS, freeze: true, binding: true, migrations: true } });

  const materialized = materialize({ repoRoot, candidateSha });
  const deployResults = [];
  const functionsDeployed = [];
  let failure = null;

  try {
    // 1) every governed function EXCEPT staging-health
    for (const name of partition.nonHealth) {
      const result = deployFn({
        functionName: name,
        manifest,
        candidateRoot: materialized.root,
        expectedSourceHash: binding.binding.candidateSourceHashes[name],
        projectRef,
        env,
      });
      deployResults.push({ functionName: name, status: result.status, phase: 'pre-metadata' });
      if (!result.ok) { failure = { code: 'FUNCTION_DEPLOY_FAILED', functionName: name, result }; break; }
      functionsDeployed.push(name);
    }
    record('deploy_non_health', failure ? STATUS.OPERATIONAL_FAILURE : STATUS.PASS,
      failure ? `${failure.functionName} failed` : `${functionsDeployed.length} deployed`);

    // 2) metadata — only if every non-health deploy passed
    let metadataWritten = false;
    if (!failure) {
      try {
        setMetadata({
          fields: {
            releaseId,
            sourceSha: candidateSha,
            sourceTreeSha: candidateTreeSha,
            manifestDigest: manifest.identityDigest,
            healthContractVersion: manifest.healthContractVersion,
            deployedAt: now().toISOString(),
          },
          projectRef,
          env,
        });
        metadataWritten = true;
        record('release_metadata', STATUS.PASS, 'six allowlisted keys written to staging');
      } catch (error) {
        failure = { code: 'METADATA_WRITE_FAILED', detail: error.code || error.message };
        record('release_metadata', STATUS.OPERATIONAL_FAILURE, error.code || error.message);
      }
    } else {
      record('release_metadata', STATUS.NOT_APPLICABLE, 'skipped: a function deployment failed first');
    }

    // 3) staging-health LAST
    if (!failure && metadataWritten) {
      const result = deployFn({
        functionName: partition.health,
        manifest,
        candidateRoot: materialized.root,
        expectedSourceHash: binding.binding.candidateSourceHashes[partition.health],
        projectRef,
        env,
      });
      deployResults.push({ functionName: partition.health, status: result.status, phase: 'post-metadata' });
      if (!result.ok) failure = { code: 'HEALTH_DEPLOY_FAILED', functionName: partition.health, result };
      else functionsDeployed.push(partition.health);
      record('deploy_health_last', failure ? STATUS.OPERATIONAL_FAILURE : STATUS.PASS);
    } else {
      record('deploy_health_last', STATUS.NOT_APPLICABLE, 'skipped: prerequisite step failed');
    }
  } finally {
    materialized.cleanup();
  }

  // ── receipt: truthful, even on partial failure ───────────────────────────
  const finalReceipt = finalizeReceipt(receipt, {
    completedAt: now().toISOString(),
    status: failure ? 'BLOCKED' : 'PASS',
    functionsDeployed,
    migrationsApplied: [],
    deployResults,
    postDeployIdentity: failure ? null : { releaseId, sourceSha: candidateSha, manifestDigest: manifest.identityDigest },
  });
  record('deployment_receipt', STATUS.PASS, `attempt ${finalReceipt.deploymentAttempt}, status ${finalReceipt.status}`);

  if (failure) {
    return {
      ok: false, mode, releaseId, steps, code: failure.code,
      receipt: finalReceipt,
      recovery: { functionsDeployed, metadataWritten: steps.some((s) => s.name === 'release_metadata' && s.status === STATUS.PASS) },
    };
  }

  // ── health contract v1 ───────────────────────────────────────────────────
  const health = probeHealth
    ? await probeHealth({ projectRef })
    : { live: { status: STATUS.OPERATIONAL_FAILURE, detail: 'no health probe adapter supplied' },
        ready: { status: STATUS.OPERATIONAL_FAILURE }, version: { status: STATUS.OPERATIONAL_FAILURE }, versionBody: null };
  record('health_contract', health.live?.status === STATUS.PASS && health.ready?.status === STATUS.PASS
    ? STATUS.PASS : STATUS.OPERATIONAL_FAILURE);

  // ── exact candidate verification ─────────────────────────────────────────
  const verification = verifyExactCandidate({
    frozen,
    manifest,
    receipt: finalReceipt,
    liveVersion: health.versionBody,
    liveMigrationNames: liveMigrationNames || [],
    expectedEnvironment: 'staging',
    observedProjectRef: projectRef,
    previousRelease: null,
  });
  record('exact_candidate_verification', verification.result === RESULT.PASS ? STATUS.PASS : STATUS.BLOCKED, verification.result);

  // ── smoke ────────────────────────────────────────────────────────────────
  const smoke = smokeFn({
    repoRoot,
    projectRef,
    stagingUrl: env.SUPABASE_STAGING_URL || '',
    syntheticAvailable: Boolean(env.STAGING_SYNTHETIC_ACTIVE_EMAIL),
    env,
  });
  record('backend_smoke', smoke.requiredFailures.length === 0 ? STATUS.PASS : STATUS.BLOCKED,
    smoke.requiredFailures.join(', ') || null);

  // ── evidence + STAGING_VERIFIED ──────────────────────────────────────────
  const evidence = buildReleaseEvidence({
    repoRoot,
    release: { releaseId, sourceSha: candidateSha, sourceTreeSha: candidateTreeSha, manifestDigest: manifest.identityDigest },
    deployment: {
      deploymentRunId, deploymentAttempt: finalReceipt.deploymentAttempt, status: finalReceipt.status,
      receiptDigest: finalReceipt.receiptDigest, functionsDeployed, migrationsApplied: [],
    },
    exactCandidateVerification: verification,
    health: { live: health.live, ready: health.ready, version: health.version },
    smoke: smoke.categories,
    certification,
    controls: { freeze_valid: { status: STATUS.PASS }, candidate_binding: { status: STATUS.PASS } },
    productionEligibility: null,
  });

  const decision = canEnterStagingVerified(evidence);
  record('staging_verified', decision.allowed ? STATUS.PASS : STATUS.BLOCKED, decision.reasons.join('; ') || null);

  if (!decision.allowed) {
    return { ok: false, mode, releaseId, steps, code: 'STAGING_VERIFIED_NOT_REACHED',
      receipt: finalReceipt, evidence, verification, smoke };
  }

  // ── mint + validate baseline ─────────────────────────────────────────────
  const baseline = mintVerifiedBaseline({
    manifest, frozen, receipt: finalReceipt,
    exactCandidateVerification: verification,
    releaseEvidence: evidence,
    verifiedAt: now().toISOString(),
  });
  const baselineValidation = validateVerifiedBaseline(baseline, { manifest, priorReleaseEvidence: evidence });
  record('baseline_mint', baselineValidation.valid ? STATUS.PASS : STATUS.BLOCKED,
    baselineValidation.valid ? null : baselineValidation.errors.join('; '));
  if (!baselineValidation.valid) {
    return { ok: false, mode, releaseId, steps, code: 'BASELINE_VALIDATION_FAILED', evidence, baseline };
  }

  // ── persist (durable, after verification only) ───────────────────────────
  const pkg = buildPackage({ baseline, evidence, receipt: finalReceipt, manifest, candidateSha, releaseId });
  const persistence = github
    ? await publishPackage({ pkg, github })
    : { ok: false, persisted: false, code: 'VERIFIED_BASELINE_PERSISTENCE_GAP', failures: [{ code: 'NO_GITHUB_ADAPTER', detail: 'no persistence adapter supplied' }] };
  record('persistence', persistence.ok ? STATUS.PASS : STATUS.OPERATIONAL_FAILURE, persistence.ok ? persistence.tag : persistence.code);

  return {
    ok: persistence.ok,
    mode,
    releaseId,
    candidateSha,
    candidateTreeSha,
    manifestDigest: manifest.identityDigest,
    steps,
    receipt: finalReceipt,
    verification,
    smoke,
    evidence,
    baseline,
    persistence,
    // Verified in runtime evidence, but not retrievable for carry-forward.
    code: persistence.ok ? null : 'VERIFIED_BASELINE_PERSISTENCE_GAP',
    mutated: true,
  };
}

export default { MODE, HEALTH_FUNCTION, ActivationError, assertExecuteAuthority, buildReleaseId, partitionBootstrapPlan, runBootstrapActivation };

// CLI: PLAN_ONLY by default; EXECUTE must be asked for explicitly.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv.includes('--execute') ? MODE.EXECUTE : MODE.PLAN_ONLY;
  const inventoryPath = process.argv[process.argv.indexOf('--inventory') + 1];
  const inventory = inventoryPath && fs.existsSync(inventoryPath)
    ? JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) : null;
  if (!inventory) {
    console.error('FAIL  --inventory <file> is required (live staging function + migration inventory)');
    process.exit(2);
  }
  runBootstrapActivation({
    repoRoot: process.cwd(),
    mode,
    liveFunctionNames: inventory.functions,
    liveMigrationNames: inventory.migrations,
    deploymentRunId: process.env.GITHUB_RUN_ID || 'local',
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1);
  }).catch((error) => {
    console.error(`FAIL  ${error.code || 'ERROR'}: ${error.message}`);
    process.exit(1);
  });
}
