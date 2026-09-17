#!/usr/bin/env node
/**
 * Roll back a production Edge Function using a deployment manifest.
 *
 * Production mirror of scripts/rollback-staging-function.mjs.
 *
 * Usage:
 *   node scripts/rollback-production-function.mjs --manifest artifacts/production-deployments/<file>.json
 *
 * For newly introduced functions (no prior_version), attempts
 * `supabase functions delete <name> --project-ref <production>`.
 *
 * Does not roll back database migrations.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, ensureArtifactsDir, fail } from './lib/staging-helpers.mjs';
import {
  assertProductionTarget,
  missingRequiredProductionVars,
  runSupabaseProduction,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
} from './lib/production-helpers.mjs';

function parseArgs(argv) {
  const idx = argv.indexOf('--manifest');
  if (idx === -1 || !argv[idx + 1]) fail('Required: --manifest <path>');
  return { manifestPath: path.resolve(argv[idx + 1]) };
}

async function shallowCheck(fnName) {
  const base = process.env.SUPABASE_PRODUCTION_URL.replace(/\/$/, '');
  const anon = process.env.SUPABASE_PRODUCTION_ANON_KEY;
  const url = `${base}/functions/v1/${fnName}`;
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    return { status: res.status, ok: res.status !== 503 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function authNegativeCheck(fnName) {
  const base = process.env.SUPABASE_PRODUCTION_URL.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/functions/v1/${fnName}`, { method: 'POST' });
    return { status: res.status, ok: res.status === 401 || res.status === 404 || res.status === 403 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const { manifestPath } = parseArgs(process.argv.slice(2));
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
  if (!fs.existsSync(manifestPath)) fail(`Manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.target && manifest.target === STAGING_PROJECT_REF) {
    fail('Manifest targets staging — refusing');
  }
  if (manifest.target && manifest.target !== PRODUCTION_PROJECT_REF) {
    fail(`Manifest target ${manifest.target} is not production`);
  }

  const fnName = manifest.function_name;
  if (!fnName) fail('Manifest missing function_name');

  let action;
  if (manifest.prior_version) {
    if (manifest.new_source_commit && fs.existsSync(path.join('supabase', 'functions', fnName, 'index.ts'))) {
      fail(
        'prior_version present: production rollback does not redeploy from the current tree. ' +
          'Check out the prior source commit and re-run deploy-production-function.mjs against it, ' +
          'or delete and treat this as an intentional re-launch.',
      );
    } else {
      fail('prior_version present but prior source is unavailable for exact redeploy');
    }
  } else {
    try {
      runSupabaseProduction(['functions', 'delete', fnName, '--project-ref', PRODUCTION_PROJECT_REF, '--yes']);
      action = 'deleted_new_function';
    } catch (err) {
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

  const dir = ensureArtifactsDir('production-rollbacks');
  const outPath = path.join(dir, `${Date.now()}-${fnName}.json`);
  writeJsonArtifact(outPath, result);
  console.log(JSON.stringify({ ...result, artifact: outPath }, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
