#!/usr/bin/env node
/**
 * Deploy exactly one Edge Function to K Scan App Production.
 *
 * Production mirror of scripts/deploy-staging-function.mjs. The one added
 * requirement Phase 4 calls for that staging's script does not need: verify
 * the deployed bundle hash after deployment, not just before. `functions
 * list --output-format json` on a recent CLI returns the deployed bundle's
 * digest (seen as `ezbr_sha256` via the Supabase Management API); this
 * script looks for it under a few known field names and treats an
 * unreadable digest as a soft warning (recorded in the manifest, not a
 * deploy failure) rather than pretending a hash it could not obtain was
 * verified.
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

const DEFAULT_GOVERNED_BRANCH = 'rebuild/backend-authority-v2';
const BUNDLE_HASH_FIELDS = ['ezbr_sha256', 'sha256', 'bundle_sha256', 'hash'];

function listFunctions() {
  const out = runSupabaseProduction([
    'functions',
    'list',
    '--project-ref',
    PRODUCTION_PROJECT_REF,
    '--output-format',
    'json',
  ]);
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
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

  const commit = gitHeadSha();
  const deployArgs = ['functions', 'deploy', fnName, '--project-ref', PRODUCTION_PROJECT_REF, '--debug'];
  if (!verifyJwt) deployArgs.push('--no-verify-jwt');

  console.log(JSON.stringify({
    phase: 'deploy',
    target: identity.projectRef,
    function: fnName,
    priorVersion,
    priorBundleHash,
    sourceCommit: commit,
    sourceHash,
    verifyJwt,
  }, null, 2));

  try {
    runSupabaseProduction(deployArgs);
  } catch (err) {
    fail(`Deploy failed: ${err.message}`);
  }

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

  const manifest = {
    function_name: fnName,
    prior_version: priorVersion,
    prior_bundle_hash: priorBundleHash,
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
    rollback_strategy: priorVersion ? 'redeploy_prior_source' : 'remove_or_disable_new_function',
  };

  const dir = ensureArtifactsDir('production-deployments');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(dir, `${stamp}-${fnName}.json`);
  writeJsonArtifact(manifestPath, manifest);

  console.log(JSON.stringify({ ok: health.ok, manifestPath, manifest }, null, 2));

  if (!bundleHashVerifiable) {
    console.warn(
      `WARNING: could not read a bundle hash from the CLI response for ${fnName}; ` +
        'bundle-hash verification is unavailable this run (recorded, not failing the deploy).',
    );
  }

  if (!health.ok) {
    console.error('Post-deploy health check failed — invoking rollback');
    try {
      execFileSync(process.execPath, [
        path.join('scripts', 'rollback-production-function.mjs'),
        '--manifest',
        manifestPath,
      ], { encoding: 'utf8', stdio: 'inherit', env: process.env });
    } catch {
      fail('Health failed and rollback also failed');
    }
    fail('Deployment rolled back after health failure');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
