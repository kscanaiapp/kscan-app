#!/usr/bin/env node
/**
 * Deploy exactly one Edge Function to K Scan AI Staging.
 *
 * Usage:
 *   DEPLOY_FUNCTIONS=staging-health EXPECTED_VERIFY_JWT=false \
 *     node scripts/deploy-staging-function.mjs
 *
 * Required env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_STAGING_PROJECT_REF
 *   SUPABASE_STAGING_URL
 *   SUPABASE_STAGING_ANON_KEY
 *   DEPLOY_FUNCTIONS            (exactly one function name)
 *   FUNCTION_NAME               (must match DEPLOY_FUNCTIONS)
 *   EXPECTED_VERIFY_JWT         (true|false)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertStagingTarget,
  missingRequiredVars,
  parseDeployFunctionsAllowList,
  runSupabase,
  sha256File,
  ensureArtifactsDir,
  writeJsonArtifact,
  gitHeadSha,
  STAGING_PROJECT_REF,
  fail,
} from './lib/staging-helpers.mjs';
import { buildDeployArgs, resolveVerifyJwt } from '../security/release/staging-deploy-core.mjs';

function listFunctions() {
  const out = runSupabase([
    'functions',
    'list',
    '--project-ref',
    STAGING_PROJECT_REF,
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

function functionSourceHash(fnName) {
  const dir = path.join(process.cwd(), 'supabase', 'functions', fnName);
  const indexPath = path.join(dir, 'index.ts');
  if (!fs.existsSync(indexPath)) fail(`Missing function source: ${indexPath}`);
  return sha256File(indexPath);
}

function runDenoCheck(fnName) {
  const indexPath = path.join('supabase', 'functions', fnName, 'index.ts');
  try {
    execFileSync('deno', ['check', indexPath], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (err) {
    // Deno may be unavailable on some runners; surface as soft fail only when
    // DENY_WITHOUT_DENO=true. Default: require deno when present.
    if (err.code === 'ENOENT') {
      if (String(process.env.REQUIRE_DENO_CHECK || '').toLowerCase() === 'true') {
        return { ok: false, error: 'deno not found and REQUIRE_DENO_CHECK=true' };
      }
      return { ok: true, skipped: 'deno not found' };
    }
    return { ok: false, error: err.stderr || err.message };
  }
}

async function shallowHealthCheck(fnName, verifyJwt) {
  const base = process.env.SUPABASE_STAGING_URL.replace(/\/$/, '');
  const anon = process.env.SUPABASE_STAGING_ANON_KEY;
  const url = `${base}/functions/v1/${fnName}`;
  const headers = {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const method = fnName === 'staging-health' ? 'GET' : 'OPTIONS';
    const res = await fetch(url, { method, headers, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-json ok for OPTIONS */ }

    if (fnName === 'staging-health') {
      const healthy = res.status === 200 && body?.status === 'healthy';
      const hasSecrets = /service_role|eyJ|password|apikey/i.test(text);
      return {
        ok: healthy && !hasSecrets,
        status: res.status,
        body: body && {
          status: body.status,
          environment: body.environment,
          service: body.service,
          checks: body.checks,
        },
        sensitiveFieldsExposed: hasSecrets,
      };
    }

    // Generic contract: OPTIONS should not be 503 BOOT_ERROR
    return {
      ok: res.status !== 503 && !/BOOT_ERROR/i.test(text),
      status: res.status,
      verifyJwtExpected: verifyJwt,
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'health check timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const missing = missingRequiredVars();
  if (missing.length) {
    console.error('Missing required staging variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  const identity = (() => {
    try {
      return assertStagingTarget();
    } catch (err) {
      fail(err.message);
      return null;
    }
  })();
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

  // Preflight (skip remote if SKIP_PREFLIGHT_REMOTE=true for unit tests)
  if (process.env.SKIP_STAGING_PREFLIGHT !== 'true') {
    // DEF-B29-SVV-011: preflight runs with --json and would otherwise inherit
    // this process's stdout, putting a SECOND JSON document in front of the
    // receipt. Capture it and re-emit on stderr so the log keeps the report
    // while stdout stays a single document.
    try {
      const preflightReport = execFileSync(process.execPath, [
        path.join('scripts', 'staging-deploy-preflight.mjs'),
        '--json',
        '--allow-dirty',
        ...(process.env.SKIP_PREFLIGHT_REMOTE === 'true' ? ['--skip-remote'] : []),
      ], {
        encoding: 'utf8',
        env: { ...process.env, DEPLOY_FUNCTIONS: fnName },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      if (preflightReport) console.error(preflightReport.trimEnd());
    } catch (err) {
      if (err.stdout) console.error(String(err.stdout).trimEnd());
      fail(`Staging preflight failed: ${err.message}`);
    }
  }

  const sourceHash = functionSourceHash(fnName);
  const deno = runDenoCheck(fnName);
  if (!deno.ok) fail(`deno check failed: ${deno.error}`);

  runSupabase(['link', '--project-ref', STAGING_PROJECT_REF, '--yes']);
  const beforeList = listFunctions();
  const prior = findFunction(beforeList, fnName);
  const priorVersion = prior?.version ?? prior?.id ?? null;

  const commit = gitHeadSha();
  // DEF-REL-016: the deploy command is built by the SHARED core, so this
  // controlled single-function path and bootstrap activation cannot drift
  // apart on the verify_jwt posture. The caller-supplied EXPECTED_VERIFY_JWT
  // is cross-checked against governed configuration rather than trusted.
  const governed = resolveVerifyJwt({
    manifestEntry: null,
    candidateRoot: process.cwd(),
    functionName: fnName,
  });
  if (governed.verifyJwt !== verifyJwt) {
    fail(
      `EXPECTED_VERIFY_JWT=${verifyJwt} contradicts governed configuration `
      + `(${governed.verifyJwt}, from ${governed.source}) for ${fnName}`,
    );
  }
  const deployArgs = buildDeployArgs({
    functionName: fnName,
    projectRef: STAGING_PROJECT_REF,
    verifyJwt: governed.verifyJwt,
    debug: true,
  });

  // DEF-B29-SVV-011: stdout carries EXACTLY ONE JSON document -- the deploy
  // receipt emitted at the end of this function. The controlled deploy
  // workflow tees stdout into deploy-result.json and reads it with a
  // single-document loader (`json.load`), so a second document here made a
  // SUCCESSFUL deploy report failure ("Extra data: line 31 column 1") and
  // skipped health and synthetic verification. This pre-deploy block is
  // progress diagnostics, not the receipt, so it belongs on stderr, where the
  // Actions log still shows it.
  console.error(JSON.stringify({
    phase: 'deploy',
    target: identity.projectRef,
    function: fnName,
    priorVersion,
    sourceCommit: commit,
    sourceHash,
    verifyJwt,
  }, null, 2));

  try {
    runSupabase(deployArgs);
  } catch (err) {
    fail(`Deploy failed: ${err.message}`);
  }

  const afterList = listFunctions();
  const deployed = findFunction(afterList, fnName);
  const newVersion = deployed?.version ?? deployed?.id ?? null;
  const status = deployed?.status || deployed?.function_status || 'UNKNOWN';

  const health = await shallowHealthCheck(fnName, verifyJwt);

  const manifest = {
    function_name: fnName,
    prior_version: priorVersion,
    prior_source_commit: prior ? null : null,
    prior_source_hash: null,
    new_version: newVersion,
    new_source_commit: commit,
    new_source_hash: sourceHash,
    deployment_timestamp: new Date().toISOString(),
    target: STAGING_PROJECT_REF,
    verify_jwt: verifyJwt,
    status,
    health,
    rollback_strategy: priorVersion ? 'redeploy_prior_source' : 'remove_or_disable_new_function',
  };

  const dir = ensureArtifactsDir('staging-deployments');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(dir, `${stamp}-${fnName}.json`);
  writeJsonArtifact(manifestPath, manifest);

  console.log(JSON.stringify({ ok: health.ok, manifestPath, manifest }, null, 2));

  if (!health.ok) {
    console.error('Post-deploy health check failed — invoking rollback');
    try {
      const rollbackOutput = execFileSync(process.execPath, [
        path.join('scripts', 'rollback-staging-function.mjs'),
        '--manifest',
        manifestPath,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
      // Same single-document contract: the rollback runs after the receipt has
      // already been written to stdout.
      if (rollbackOutput) console.error(String(rollbackOutput).trimEnd());
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
