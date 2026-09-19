#!/usr/bin/env node
/**
 * Roll back a production Edge Function.
 *
 * Production mirror of scripts/rollback-staging-function.mjs.
 *
 * Usage:
 *   node scripts/rollback-production-function.mjs \
 *     --manifest artifacts/production-deployments/<file>.json \
 *     [--capture artifacts/production-function-captures/<dir>/capture.json]
 *
 * TWO SHAPES, AND ONLY TWO:
 *
 *   prior_version absent  -> the function did not exist before this deployment,
 *                            so deleting it restores the prior state exactly.
 *   prior_version present -> the function pre-existed, so the ONLY honest
 *                            rollback is redeploying the captured live bundle.
 *
 * The second case used to call fail() unconditionally (B34-BE-G2), because the
 * deploy had recorded only the prior version number and bundle hash -- metadata,
 * not bytes. That made replacing any existing production function a one-way
 * door. It now consumes the capture written by
 * scripts/capture-production-function.mjs and redeploys those exact files with
 * the captured verify_jwt.
 *
 * The capture is resolved from --capture, or from capture_path recorded in the
 * deployment manifest by deploy-production-function.mjs.
 *
 * It will never fall back to the current git tree. The tree is the NEW source --
 * the thing being rolled back FROM -- so redeploying it would be a no-op dressed
 * as a recovery, reporting success while production stayed broken.
 *
 * Does not roll back database migrations.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJsonArtifact, ensureArtifactsDir, fail } from './lib/staging-helpers.mjs';
import {
  planRollback,
  restoreDeployArgs,
  listCapturableFiles,
} from './lib/function-bundle-capture.mjs';
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
  const cIdx = argv.indexOf('--capture');
  return {
    manifestPath: path.resolve(argv[idx + 1]),
    capturePath: cIdx !== -1 && argv[cIdx + 1] ? path.resolve(argv[cIdx + 1]) : null,
  };
}

/**
 * Loads the capture manifest named on the command line, or the one the
 * deployment manifest points at. A capture that cannot be read or parsed is
 * reported as such rather than treated as absent, because "no capture" and
 * "broken capture" need different remedies.
 */
function loadCapture(capturePath, manifest) {
  const resolved = capturePath
    || (manifest.capture_path ? path.resolve(manifest.capture_path) : null);
  if (!resolved) return { capture: null, captureRoot: null, resolved: null };

  if (!fs.existsSync(resolved)) {
    fail(`Capture manifest not found: ${resolved}`);
  }
  let capture;
  try {
    capture = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    fail(`Capture manifest is unparseable (${resolved}): ${err.message}`);
  }
  return { capture, captureRoot: path.join(path.dirname(resolved), 'files'), resolved };
}

/**
 * Redeploys the captured files. They are copied into an isolated scratch
 * project first: the CLI deploys supabase/functions/<name>/ from its working
 * directory, and the repository copy is the new source we are rolling back
 * away from.
 */
function restoreCapturedBundle({ functionName, captureRoot, files, verifyJwt }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kscan-restore-${functionName}-`));
  const target = path.join(scratch, 'supabase', 'functions', functionName);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(scratch, 'supabase', 'config.toml'),
    `project_id = "${PRODUCTION_PROJECT_REF}"\n`,
  );

  for (const rel of files) {
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(captureRoot, rel), dest);
  }

  const copied = listCapturableFiles(target);
  if (copied.length !== files.length) {
    fail(`Restore staging incomplete: expected ${files.length} files, staged ${copied.length}`);
  }

  const args = restoreDeployArgs({
    functionName,
    projectRef: PRODUCTION_PROJECT_REF,
    verifyJwt,
  });
  try {
    runSupabaseProduction(args, { cwd: scratch });
  } catch (err) {
    fail(`Restoring the captured bundle for ${functionName} failed: ${err.message}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { args, fileCount: files.length };
}

function liveVerifyJwt(functionName) {
  try {
    const out = runSupabaseProduction([
      'functions', 'list', '--project-ref', PRODUCTION_PROJECT_REF, '--output-format', 'json',
    ]);
    const parsed = JSON.parse(out);
    const list = Array.isArray(parsed) ? parsed : parsed.functions || [];
    const fn = list.find((f) => (f.slug || f.name) === functionName);
    return fn ? fn.verify_jwt === true : null;
  } catch {
    return null;
  }
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
  const { manifestPath, capturePath } = parseArgs(process.argv.slice(2));
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
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    fail(`Manifest is unparseable (${manifestPath}): ${err.message}`);
  }

  const fnName = manifest.function_name;
  const { capture, captureRoot, resolved: resolvedCapturePath } = loadCapture(capturePath, manifest);

  // One decision, made in one place, fail-closed. planRollback checks the
  // manifest's target, the capture's target, that the capture names THIS
  // function, and that every captured file still hashes to what was recorded.
  const plan = planRollback({
    manifest,
    capture,
    captureRoot,
    expected: {
      productionRef: PRODUCTION_PROJECT_REF,
      stagingRef: STAGING_PROJECT_REF,
    },
  });

  if (!plan.action) {
    fail(`Refusing to roll back ${fnName || '(unnamed)'}:\n  - ${plan.blockers.join('\n  - ')}`);
  }

  console.log(JSON.stringify({
    phase: 'pre-rollback',
    target: identity.projectRef,
    function: fnName,
    action: plan.action,
    prior_version: manifest.prior_version ?? null,
    capture_path: resolvedCapturePath,
    captured_at: plan.capturedAt ?? null,
    restore_verify_jwt: plan.verifyJwt ?? null,
    restore_file_count: plan.files ? plan.files.length : 0,
  }, null, 2));

  let action;
  let restore = null;
  if (plan.action === 'RESTORE_CAPTURED_BUNDLE') {
    restore = restoreCapturedBundle({
      functionName: fnName,
      captureRoot,
      files: plan.files,
      verifyJwt: plan.verifyJwt,
    });
    action = 'restored_captured_bundle';

    // The auth posture is the part a rollback most easily gets wrong, so it is
    // verified rather than assumed.
    const live = liveVerifyJwt(fnName);
    if (live !== null && live !== plan.verifyJwt) {
      fail(
        `Restore completed but verify_jwt is ${live} on production and the capture recorded ` +
          `${plan.verifyJwt}. The original authentication posture was NOT restored.`,
      );
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
    capture_path: resolvedCapturePath,
    restored_verify_jwt: plan.verifyJwt ?? null,
    restored_file_count: restore ? restore.fileCount : 0,
    restore_args: restore ? restore.args.join(' ') : null,
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

// Only run the rollback when invoked as a script. Importing this module
// (tests, tooling) must not roll anything back or call process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { parseArgs, loadCapture, restoreCapturedBundle, liveVerifyJwt };
