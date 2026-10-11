#!/usr/bin/env node
/**
 * Deploy exactly one Edge Function to K Scan App Production.
 *
 * Production mirror of scripts/deploy-staging-function.mjs. The one added
 * requirement Phase 4 calls for that staging's script does not need: verify
 * the deployed bundle hash after deployment, not just before. `functions
 * list --output-format json` on a recent CLI returns the deployed bundle's
 * digest (seen as `ezbr_sha256` via the Supabase Management API); this
 * script looks for it under a few known field names and refuses success when
 * the deployed digest, version, status or JWT posture cannot be verified.
 *
 * Usage:
 *   DEPLOY_FUNCTIONS=scan-identify EXPECTED_VERIFY_JWT=false \
 *     node scripts/deploy-production-function.mjs
 *
 * Required env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_PRODUCTION_PROJECT_REF
 *   SUPABASE_PRODUCTION_URL
 *   SUPABASE_PRODUCTION_ANON_KEY
 *   DEPLOY_FUNCTIONS            (exactly one function name)
 *   FUNCTION_NAME               (must match DEPLOY_FUNCTIONS)
 *   EXPECTED_VERIFY_JWT         (true|false)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseDeployFunctionsAllowList,
  sha256File,
  ensureArtifactsDir,
  writeJsonArtifact,
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
import { runWithTransientEdgeRuntimePullRetry } from './lib/supabase-deploy-retry.mjs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { packRecovery, unpackRecovery, recoveryHash, managedRecoveryStore, recoverAfterFailure, RECOVERY_BUCKET } from './lib/production-recovery.mjs';
import { checkProductionContract } from './lib/production-contract-check.mjs';
import { runPrivateCapture } from './lib/private-function-capture.mjs';

const DEFAULT_GOVERNED_BRANCH = 'rebuild/backend-authority-v2';
const BUNDLE_HASH_FIELDS = ['ezbr_sha256', 'sha256', 'bundle_sha256', 'hash'];

export function parseFunctionInventory(out) {
  const parsed = JSON.parse(out);
  const rows = Array.isArray(parsed) ? parsed : parsed?.functions;
  if (!Array.isArray(rows) || !rows.length || rows.some((row) => !row ||
      !/^[a-z0-9][a-z0-9-]*$/.test(row.slug || row.name || ''))) {
    throw new Error('Live function inventory unreadable; replacement refused');
  }
  if (new Set(rows.map((row) => row.slug || row.name)).size !== rows.length) throw new Error('Ambiguous live function inventory');
  return rows;
}

function listFunctions() {
  const out = runSupabaseProduction([
    'functions',
    'list',
    '--project-ref',
    PRODUCTION_PROJECT_REF,
    '--output-format',
    'json',
  ]);
  return parseFunctionInventory(out);
}

function findFunction(list, name) {
  const rows = Array.isArray(list) ? list : (list.functions || []);
  return rows.find((f) => f.name === name || f.slug === name || f.id === name) || null;
}

function readBundleHash(fnRecord) {
  if (!fnRecord) return null;
  for (const field of BUNDLE_HASH_FIELDS) {
    if (typeof fnRecord[field] === 'string' && fnRecord[field].trim()) {
      return fnRecord[field].trim().toLowerCase();
    }
  }
  return null;
}

function functionSourceHash(fnName) {
  const dir = path.join(process.cwd(), 'supabase', 'functions', fnName);
  const indexPath = path.join(dir, 'index.ts');
  if (!fs.existsSync(indexPath)) fail(`Missing function source: ${indexPath}`);
  return sha256File(indexPath);
}

async function shallowHealthCheck(fnName, verifyJwt) {
  const base = process.env.SUPABASE_PRODUCTION_URL.replace(/\/$/, '');
  const anon = process.env.SUPABASE_PRODUCTION_ANON_KEY;
  const url = `${base}/functions/v1/${fnName}`;
  const headers = { apikey: anon, Authorization: `Bearer ${anon}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const method = 'OPTIONS';
    const res = await fetch(url, { method, headers, signal: controller.signal });
    const text = await res.text();
    const sensitive = /service_role|eyJ|password|sbp_/i.test(text);
    return {
      ok: res.status !== 503 && !/BOOT_ERROR/i.test(text) && !sensitive,
      status: res.status,
      verifyJwtExpected: verifyJwt,
      sensitiveFieldsExposed: sensitive,
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'health check timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const missing = missingRequiredProductionVars();
  if (missing.length) {
    console.error('Missing required production variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  const identity = (() => {
    try {
      return assertProductionTarget();
    } catch (err) {
      fail(err.message);
      return null;
    }
  })();

  const governedBranch = process.env.GOVERNED_BRANCH || DEFAULT_GOVERNED_BRANCH;
  try {
    assertGovernedCommit(governedBranch);
  } catch (err) {
    fail(err.message);
  }

  let allowList;
  try {
    allowList = parseDeployFunctionsAllowList(process.env.DEPLOY_FUNCTIONS);
  } catch (err) {
    fail(err.message);
  }
  const fnName = String(process.env.FUNCTION_NAME || allowList[0] || '').trim();
  const verifyJwt = String(process.env.EXPECTED_VERIFY_JWT || 'true').toLowerCase() === 'true';

  if (!fnName) fail('FUNCTION_NAME / DEPLOY_FUNCTIONS is required (exactly one function)');
  if (allowList.length !== 1) fail('DEPLOY_FUNCTIONS must contain exactly one function name');
  if (allowList[0] !== fnName) fail(`FUNCTION_NAME ${fnName} does not match DEPLOY_FUNCTIONS ${allowList[0]}`);

  if (process.env.SKIP_PRODUCTION_PREFLIGHT !== 'true') {
    execFileSync(process.execPath, [
      path.join('scripts', 'production-deploy-preflight.mjs'),
      '--json',
      ...(process.env.SKIP_PREFLIGHT_REMOTE === 'true' ? ['--skip-remote'] : []),
    ], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_FUNCTIONS: fnName },
      stdio: 'inherit',
    });
  }

  const sourceHash = functionSourceHash(fnName);

  runSupabaseProduction(['link', '--project-ref', PRODUCTION_PROJECT_REF, '--yes']);
  const beforeList = listFunctions();
  const prior = findFunction(beforeList, fnName);
  const priorVersion = prior?.version ?? prior?.id ?? null;
  const priorBundleHash = readBundleHash(prior);

  // AD-PRE-001: CAPTURE BEFORE REPLACE.
  //
  // An EXISTING function may not be replaced until its live bundle has been
  // captured, because prior_version and prior_bundle_hash are metadata and
  // cannot be redeployed. Without a capture, rollback has nothing to restore
  // from and the deploy is a one-way door (B34-BE-G2).
  //
  // A NEW function needs no capture: deleting it restores the prior state
  // exactly, which is what planRollback() does for that shape.
  let capturePath = null;
  if (prior) {
    try {
      const captured = runPrivateCapture(fnName);
      console.log(JSON.stringify(captured));
      capturePath = captured.capture_path;
    } catch (err) {
      fail(
        `Could not capture the live production bundle for ${fnName}. ` +
          'Refusing to replace an existing production function without exact rollback material.',
      );
    }
    if (!capturePath || !fs.existsSync(capturePath)) {
      fail(`Capture reported success but no capture manifest exists for ${fnName}`);
    }
  }

  const commit = gitHeadSha();
  const deployArgs = ['functions', 'deploy', fnName, '--project-ref', PRODUCTION_PROJECT_REF];
  if (!verifyJwt) deployArgs.push('--no-verify-jwt');

  console.log(JSON.stringify({
    phase: 'deploy',
    target: identity.projectRef,
    function: fnName,
    priorVersion,
    priorBundleHash,
    capturePath,
    sourceCommit: commit,
    sourceHash,
    verifyJwt,
  }, null, 2));

  const dir = ensureArtifactsDir('production-deployments');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(dir, `${stamp}-${fnName}.json`);
  const priorManifest = { function_name: fnName, target: PRODUCTION_PROJECT_REF,
    prior_version: priorVersion, prior_bundle_hash: priorBundleHash, capture_path: capturePath,
    new_source_commit: commit, verify_jwt: verifyJwt,
    rollback_strategy: priorVersion ? 'restore_captured_bundle' : 'remove_or_disable_new_function' };
  // Durably preserve recovery BEFORE a write. GitHub receives only this non-sensitive reference.
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!/^[0-9]+$/.test(run || '') || !/^[0-9]+$/.test(attempt || '')) fail('Governed run identity required for private recovery');
  const bytes = packRecovery(priorManifest, capturePath);
  const reference = { bucket: RECOVERY_BUCKET, object: `controlled/${run}-${attempt}/${commit}.json`,
    sha256: recoveryHash(bytes), function_name: fnName, source_commit: commit, target: PRODUCTION_PROJECT_REF };
  const store = await managedRecoveryStore({ token: process.env.SUPABASE_ACCESS_TOKEN,
    anonKey: process.env.SUPABASE_PRODUCTION_ANON_KEY, prepare: true });
  const verifiedBytes = await store.upload(bytes, reference);
  const checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-recovery-check-'));
  try { unpackRecovery(verifiedBytes, checkDir, reference); }
  finally { fs.rmSync(checkDir, { recursive: true, force: true }); }
  writeJsonArtifact(path.join(dir, 'recovery-reference.json'), reference);
  console.log(JSON.stringify({ phase: 'private-recovery-ready', recovery: reference }));
  writeJsonArtifact(manifestPath, { ...priorManifest, recovery: reference, replacement_attempted: false });
  let replacementAttempted = false;
  await recoverAfterFailure({
    attempted: () => replacementAttempted,
    record: (result) => {
      writeJsonArtifact(path.join(dir, 'deployment-failure.json'), { ...result, recovery: reference });
      console.error(JSON.stringify(result));
    },
    operation: async () => {
      const immediatelyBefore = findFunction(listFunctions(), fnName);
      if ((immediatelyBefore?.version ?? null) !== (prior?.version ?? null) ||
          readBundleHash(immediatelyBefore) !== priorBundleHash ||
          (prior && immediatelyBefore?.verify_jwt !== prior.verify_jwt)) {
        throw new Error('Live function changed after capture; replacement refused');
      }
      replacementAttempted = true;
      writeJsonArtifact(manifestPath, { ...priorManifest, recovery: reference, replacement_attempted: true });
        await runWithTransientEdgeRuntimePullRetry(
          () => runSupabaseProduction(deployArgs),
          {
            onRetry: ({ attempt, nextAttempt, attempts, delayMs }) => {
              console.warn(
                `Transient GHCR Edge Runtime pull throttle on deploy attempt ${attempt}; ` +
                  `retrying attempt ${nextAttempt}/${attempts} in ${delayMs}ms.`,
              );
            },
          },
        );

      const afterList = listFunctions();
      const deployed = findFunction(afterList, fnName);
      const newVersion = deployed?.version ?? deployed?.id ?? null;
      const status = deployed?.status || deployed?.function_status || 'UNKNOWN';
      const deployedBundleHash = readBundleHash(deployed);

      // "Verify source/bundle hashes after deployment" (Phase 4). The bundle
      // hash Supabase reports is over the uploaded bundle, not the raw source
      // file, so it cannot be compared byte-for-byte against sourceHash -- it CAN
      // be compared against itself before/after to prove the deploy actually
      // changed the served bundle (or, for a same-source redeploy, did not).
      const bundleHashChanged = deployedBundleHash && priorBundleHash
        ? deployedBundleHash !== priorBundleHash
        : null;
      const bundleHashVerifiable = Boolean(deployedBundleHash);

      const health = await shallowHealthCheck(fnName, verifyJwt);
      const contract = await checkProductionContract({ functionName: fnName,
        url: process.env.SUPABASE_PRODUCTION_URL, anonKey: process.env.SUPABASE_PRODUCTION_ANON_KEY, verifyJwt });
      const identityVerified = Boolean(newVersion && deployedBundleHash &&
        deployed?.verify_jwt === verifyJwt && status === 'ACTIVE');

      const manifest = {
        function_name: fnName,
        prior_version: priorVersion,
        prior_bundle_hash: priorBundleHash,
        // The rollback script resolves the capture from here when --capture is not
        // passed explicitly, so an operator holding only the deployment manifest can
        // still perform an exact restore.
        capture_path: capturePath,
        new_version: newVersion,
        new_source_commit: commit,
        new_source_hash: sourceHash,
        new_bundle_hash: deployedBundleHash,
        bundle_hash_verifiable: bundleHashVerifiable,
        bundle_hash_changed: bundleHashChanged,
        deployment_timestamp: new Date().toISOString(),
        target: PRODUCTION_PROJECT_REF,
        verify_jwt: verifyJwt,
        status,
        health,
        contract,
        identity_verified: identityVerified,
        replacement_attempted: true,
        recovery: reference,
        rollback_strategy: priorVersion ? 'restore_captured_bundle' : 'remove_or_disable_new_function',
      };

      writeJsonArtifact(manifestPath, manifest);

      console.log(JSON.stringify({ ok: health.ok && contract.ok && identityVerified, manifestPath, manifest }, null, 2));

      if (!health.ok || !contract.ok || !identityVerified) throw new Error('Post-deploy validation failed');
      // Fixtures run on the protected runner; a fixture failure uses the same immediate recovery path.
      execFileSync(process.execPath, ['--test', '__tests__/edgeFunctionSourceParity.test.js',
        '__tests__/staging/productionRecoverySafety.test.js'], { encoding: 'utf8', stdio: 'inherit' });
    },
    recover: async () => {
      execFileSync(process.execPath, [
        path.join('scripts', 'rollback-production-function.mjs'), '--manifest', manifestPath,
        ...(capturePath ? ['--capture', capturePath] : []),
      ], { encoding: 'utf8', env: process.env, stdio: 'inherit' });
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Production deployment failed. Inspect the sanitized deployment record and private recovery reference.');
  process.exit(1);
});
