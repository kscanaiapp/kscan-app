#!/usr/bin/env node
/**
 * Capture the EXACT live production Edge Function bundle before replacing it
 * (gate AD-PRE-001, blocker B34-BE-G2).
 *
 * Replacing an existing production function used to be a one-way door: the
 * deploy recorded the prior version number and bundle hash, neither of which
 * can be redeployed, so rollback had nothing to restore from. This script is
 * the missing half -- it downloads the bytes that are live right now and stores
 * them, with digests, where scripts/rollback-production-function.mjs can find
 * them.
 *
 * Usage:
 *   node scripts/capture-production-function.mjs --function <name>
 *
 * Required env:
 *   SUPABASE_ACCESS_TOKEN
 *   SUPABASE_PRODUCTION_PROJECT_REF=wyyuqfdxucjksghsmhry
 *   SUPABASE_PRODUCTION_URL
 *   SUPABASE_PRODUCTION_ANON_KEY
 *
 * Writes artifacts/production-function-captures/<stamp>-<fn>/ containing
 * capture.json and files/. Prints the capture path as JSON. Read-only against
 * production: it downloads, and changes nothing.
 *
 * The download runs in an isolated temporary directory because
 * `supabase functions download` writes into supabase/functions/<name>/ of
 * whatever project it runs in -- pointing it at the repo would overwrite the
 * governed source with production's current bytes, which is the opposite of
 * what this campaign wants.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeJsonArtifact, ensureArtifactsDir, fail } from './lib/staging-helpers.mjs';
import {
  assertProductionTarget,
  missingRequiredProductionVars,
  runSupabaseProduction,
  PRODUCTION_PROJECT_REF,
} from './lib/production-helpers.mjs';
import {
  buildCaptureManifest,
  digestTree,
  listCapturableFiles,
  verifyCapture,
  CAPTURE_DIR,
} from './lib/function-bundle-capture.mjs';

function parseArgs(argv) {
  const idx = argv.indexOf('--function');
  const fn = idx !== -1 ? argv[idx + 1] : process.env.FUNCTION_NAME;
  if (!fn) fail('Required: --function <name> (or FUNCTION_NAME)');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fn)) fail(`Refusing suspicious function name: ${fn}`);
  return { functionName: fn };
}

function listFunctions() {
  const out = runSupabaseProduction([
    'functions', 'list', '--project-ref', PRODUCTION_PROJECT_REF, '--output-format', 'json',
  ]);
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : parsed.functions || [];
}

function findFunction(list, name) {
  return list.find((f) => (f.slug || f.name) === name) || null;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const rel of listCapturableFiles(from)) {
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
  }
}

/**
 * Downloads the live bundle into an isolated scratch project and returns the
 * directory holding its files. Never writes into the repository.
 */
function downloadLiveBundle(functionName, { run = runSupabaseProduction } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `kscan-capture-${functionName}-`));
  fs.mkdirSync(path.join(scratch, 'supabase', 'functions'), { recursive: true });
  // A minimal config so the CLI treats the scratch dir as a project root.
  fs.writeFileSync(
    path.join(scratch, 'supabase', 'config.toml'),
    `project_id = "${PRODUCTION_PROJECT_REF}"\n`,
  );

  // The Supabase CLI's default download path can invoke a local Docker-based
  // ESZIP unbundler. GitHub-hosted runners have hit extractor/runtime failures,
  // even when the function is healthy. Prefer the documented server-side
  // unbundler. A single legacy fallback is read-only and is permitted only
  // because the capture still refuses to proceed without verified source.
  const classifyDownloadError = (error) => {
    const detail = [error?.message, error?.stderr, error?.stdout]
      .filter(Boolean).map((value) => String(value)).join(' ').toLowerCase();
    // Never print raw CLI output: it may contain source or credential material.
    if (/invalid eszip|unsupported eszip|failed to unbundle/.test(detail)) return 'BUNDLE_FORMAT';
    if (/docker|container|ghcr|pull rate|image/.test(detail)) return 'LOCAL_UNBUNDLER';
    if (/401|403|unauthoriz|forbidden|permission denied|access denied/.test(detail)) return 'ACCESS_DENIED';
    if (/429|rate.limit|throttl/.test(detail)) return 'RATE_LIMITED';
    if (/timeout|timed out|deadline/.test(detail)) return 'TIMEOUT';
    if (/404|not found|does not exist/.test(detail)) return 'NOT_FOUND';
    return 'UNKNOWN';
  };
  let downloadedOk = false;
  for (const mode of ['server-api', 'legacy-local']) {
    try {
      run(
        ['functions', 'download', functionName, '--project-ref', PRODUCTION_PROJECT_REF,
          ...(mode === 'server-api' ? ['--use-api'] : [])],
        { cwd: scratch },
      );
      downloadedOk = true;
      break;
    } catch (error) {
      // Only a predetermined category reaches workflow logs, never the
      // throwable, stderr, stdout, token, or source bytes.
      console.error(`Production capture download ${mode} failed [${classifyDownloadError(error)}]`);
      fs.rmSync(path.join(scratch, 'supabase', 'functions'), { recursive: true, force: true });
      fs.mkdirSync(path.join(scratch, 'supabase', 'functions'), { recursive: true });
    }
  }
  if (!downloadedOk) {
    fail(
      `Could not download the live bundle for ${functionName}. ` +
        'Both bounded read-only methods failed; replacement refused without exact rollback material.',
    );
  }

  const downloaded = path.join(scratch, 'supabase', 'functions', functionName);
  if (!fs.existsSync(downloaded) || listCapturableFiles(downloaded).length === 0) {
    fail(
      `The CLI reported success but produced no files for ${functionName} at ${downloaded}. ` +
        'Refusing to record an empty capture.',
    );
  }
  const escaped = listCapturableFiles(scratch).filter((file) =>
    file !== 'supabase/config.toml' && file !== 'supabase/.temp/cli-latest' &&
    !file.startsWith('supabase/functions/'));
  if (escaped.length) throw new Error('CLI download returned files outside the recoverable function tree; replacement refused');
  // CLI download preserves ../_shared imports as siblings. Capture the whole
  // returned functions tree, not just the named function's directory.
  return { scratch, downloaded: path.join(scratch, 'supabase', 'functions') };
}

function main() {
  const { functionName } = parseArgs(process.argv.slice(2));

  const missing = missingRequiredProductionVars();
  if (missing.length) {
    console.error('Missing required production variables:');
    for (const name of missing) console.error(`- ${name}`);
    process.exit(1);
  }

  let identity;
  try {
    identity = assertProductionTarget();
  } catch (err) {
    fail(err.message);
  }

  runSupabaseProduction(['link', '--project-ref', PRODUCTION_PROJECT_REF, '--yes']);

  const live = findFunction(listFunctions(), functionName);
  if (!live) {
    fail(
      `${functionName} is not deployed on production. A capture is only meaningful for an ` +
        'EXISTING function; a new function rolls back by deletion and needs no capture.',
    );
  }
  if (typeof live.verify_jwt !== 'boolean' || !live.version || !live.ezbr_sha256) {
    fail('Live function identity or original JWT posture is unreadable; replacement refused');
  }
  if (live.import_map === true) fail('A configured import map needs explicit recovery support; replacement refused');
  const entrypointMarker = `/functions/${functionName}/`;
  const entrypointSuffix = typeof live.entrypoint_path === 'string' && live.entrypoint_path.includes(entrypointMarker)
    ? live.entrypoint_path.slice(live.entrypoint_path.lastIndexOf(entrypointMarker) + '/functions/'.length) : null;
  if (!entrypointSuffix || entrypointSuffix.includes('..') || !/^[a-zA-Z0-9_.\/-]+$/.test(entrypointSuffix)) {
    fail('Live deployment entrypoint is unreadable or unsupported; replacement refused');
  }

  const { scratch, downloaded } = downloadLiveBundle(functionName);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ensureArtifactsDir(CAPTURE_DIR), `${stamp}-${functionName}`);
  const filesDir = path.join(dir, 'files');
  copyTree(downloaded, filesDir);
  fs.rmSync(scratch, { recursive: true, force: true });

  const { files, treeDigest } = digestTree(filesDir);
  const manifest = buildCaptureManifest({
    functionName,
    projectRef: identity.projectRef,
    liveVersion: live.version ?? live.id ?? null,
    verifyJwt: live.verify_jwt === true,
    ezbrSha256: live.ezbr_sha256 ?? null,
    status: live.status ?? null,
    files,
    treeDigest,
    bundleLayout: 'functions-root',
    entrypoint: entrypointSuffix,
  });

  const capturePath = path.join(dir, 'capture.json');
  writeJsonArtifact(capturePath, manifest);

  // Verify what was just written, rather than trusting that it was written
  // correctly. A capture that cannot pass its own check is worse than none,
  // because the deploy would proceed believing rollback is available.
  const verified = verifyCapture({
    capture: manifest,
    captureRoot: filesDir,
    expected: { functionName, productionRef: PRODUCTION_PROJECT_REF },
  });
  if (!verified.ok) {
    fail(`Capture failed its own verification:\n  - ${verified.problems.join('\n  - ')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    capture_path: capturePath,
    capture_dir: dir,
    files_dir: filesDir,
    function_name: functionName,
    target: identity.projectRef,
    live_version: manifest.live_version,
    verify_jwt: manifest.verify_jwt,
    ezbr_sha256: manifest.ezbr_sha256,
    file_count: manifest.file_count,
    tree_digest: manifest.tree_digest,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch { console.error('Production capture failed; source and credential-bearing CLI output withheld'); process.exitCode = 1; }
}

export { downloadLiveBundle, findFunction, parseArgs };
