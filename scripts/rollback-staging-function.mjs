#!/usr/bin/env node
/**
 * Roll back a staging Edge Function using a deployment manifest.
 *
 * Usage:
 *   node scripts/rollback-staging-function.mjs --manifest artifacts/staging-deployments/<file>.json
 *
 * For newly introduced functions (no prior_version), attempts
 * `supabase functions delete <name> --project-ref <staging>`.
 *
 * Does not roll back database migrations.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  assertStagingTarget,
  missingRequiredVars,
  runSupabase,
  writeJsonArtifact,
  ensureArtifactsDir,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  fail,
} from './lib/staging-helpers.mjs';

function parseArgs(argv) {
  const idx = argv.indexOf('--manifest');
  if (idx === -1 || !argv[idx + 1]) fail('Required: --manifest <path>');
  return { manifestPath: path.resolve(argv[idx + 1]) };
}

async function shallowCheck(fnName) {
  const base = process.env.SUPABASE_STAGING_URL.replace(/\/$/, '');
  const anon = process.env.SUPABASE_STAGING_ANON_KEY;
  const url = `${base}/functions/v1/${fnName}`;
  try {
    const res = await fetch(url, {
      method: fnName === 'staging-health' ? 'GET' : 'OPTIONS',
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    return { status: res.status, ok: res.status !== 503 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function authNegativeCheck(fnName) {
  const base = process.env.SUPABASE_STAGING_URL.replace(/\/$/, '');
  // No apikey / no auth — expect 401 (or 404 if removed)
  try {
    const res = await fetch(`${base}/functions/v1/${fnName}`, { method: 'POST' });
    return { status: res.status, ok: res.status === 401 || res.status === 404 || res.status === 403 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const { manifestPath } = parseArgs(process.argv.slice(2));
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
  if (!fs.existsSync(manifestPath)) fail(`Manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.target && manifest.target === PRODUCTION_PROJECT_REF) {
    fail('Manifest targets production — refusing');
  }
  if (manifest.target && manifest.target !== STAGING_PROJECT_REF) {
    fail(`Manifest target ${manifest.target} is not staging`);
  }

  const fnName = manifest.function_name;
  if (!fnName) fail('Manifest missing function_name');

  let action;
  if (manifest.prior_version) {
    // Redeploy from current tree is only valid when prior source is still at HEAD.
    // Prefer deleting and requiring a known-good redeploy when prior source is unavailable.
    if (manifest.prior_source_commit && fs.existsSync(path.join('supabase', 'functions', fnName, 'index.ts'))) {
      const args = ['functions', 'deploy', fnName, '--project-ref', STAGING_PROJECT_REF, '--debug'];
      if (manifest.verify_jwt === false) args.push('--no-verify-jwt');
      runSupabase(args);
      action = 'redeployed_current_tree_as_best_effort_prior';
    } else {
      fail('prior_version present but prior source commit/hash unavailable for exact redeploy');
    }
  } else {
    try {
      runSupabase(['functions', 'delete', fnName, '--project-ref', STAGING_PROJECT_REF, '--yes']);
      action = 'deleted_new_function';
    } catch (err) {
      // Older CLI may not support delete — attempt disable via redeploy note
      fail(`Unable to delete new function ${fnName}: ${err.message}`);
    }
  }

  const health = await shallowCheck(fnName);
  const authz = await authNegativeCheck(fnName);

  const result = {
    ok: action === 'deleted_new_function' ? true : health.ok && authz.ok,
    action,
    target: identity.projectRef,
    function: fnName,
    health,
    authorizationNegative: authz,
    sourceManifest: manifestPath,
    timestamp: new Date().toISOString(),
  };

  const dir = ensureArtifactsDir('staging-rollbacks');
  const outPath = path.join(dir, `${Date.now()}-${fnName}.json`);
  writeJsonArtifact(outPath, result);
  console.log(JSON.stringify({ ...result, artifact: outPath }, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
