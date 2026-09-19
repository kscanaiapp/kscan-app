/**
 * Exact Edge Function bundle capture and restore (B34-BE-G2).
 *
 * WHY THIS EXISTS
 *
 * scripts/deploy-production-function.mjs recorded only METADATA about the
 * function it was about to replace -- version number and the bundle hash the
 * CLI reports. Neither can be redeployed. So when
 * scripts/rollback-production-function.mjs was handed a manifest with a
 * prior_version, it had nothing to restore FROM, and both of its branches
 * called fail(). Replacing any existing production Edge Function was therefore
 * a one-way door.
 *
 * The missing piece is not cleverness, it is BYTES: the live bundle has to be
 * downloaded and kept before the deploy, or rollback is a fiction. This module
 * owns that capture format and the verification that a capture is fit to
 * restore.
 *
 * WHAT A CAPTURE IS
 *
 *   artifacts/production-function-captures/<stamp>-<fn>/
 *     capture.json     the manifest below
 *     files/...        the exact files downloaded from production
 *
 * capture.json records the function name, the production project ref, the live
 * version, the live verify_jwt, the CLI-reported ezbr_sha256 where available,
 * the capture timestamp, and a sha256 for every captured file plus one
 * deterministic digest over the whole tree.
 *
 * WHAT IT REFUSES
 *
 * Restore is the moment you are already in trouble, so every check here fails
 * closed and says which one failed. A capture is unusable if it is missing,
 * unparseable, targets anything but production, names a different function,
 * carries no files, or if any file's bytes no longer match the digest recorded
 * when it was taken.
 *
 * WHAT IT WILL NEVER DO
 *
 * Substitute the current git tree for the captured bundle. The tree is the NEW
 * source -- the thing being rolled back from. Redeploying it would be a no-op
 * dressed as a recovery, which is worse than refusing, because it would report
 * success while production stayed broken.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CAPTURE_SCHEMA = 'production-function-capture-v1';
export const CAPTURE_DIR = 'production-function-captures';

/** Files a function bundle may legitimately carry. */
const CAPTURABLE = /\.(ts|tsx|js|mjs|json|toml|txt|md|wasm)$/i;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Every capturable file under `root`, as POSIX-style paths relative to it,
 * sorted so the digest is deterministic regardless of directory order.
 */
export function listCapturableFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && CAPTURABLE.test(entry.name)) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  if (!fs.existsSync(root)) return out;
  walk(root);
  return out.sort();
}

/**
 * Per-file digests plus one digest over the whole tree.
 *
 * The tree digest is taken over "<path>\n<sha256>\n" for each file in sorted
 * path order, so it changes if a file's bytes change, if a file is added or
 * removed, or if a file is renamed -- all of which mean the capture no longer
 * describes what was captured.
 */
export function digestTree(root, relPaths = listCapturableFiles(root)) {
  const files = relPaths.map((rel) => ({
    path: rel,
    sha256: sha256(fs.readFileSync(path.join(root, rel))),
    bytes: fs.statSync(path.join(root, rel)).size,
  }));
  const combined = sha256(
    Buffer.from(files.map((f) => `${f.path}\n${f.sha256}\n`).join(''), 'utf8'),
  );
  return { files, treeDigest: combined };
}

/**
 * Builds the capture manifest. Pure: takes already-read facts, returns the
 * object to write. Kept separate from IO so it is directly testable.
 */
export function buildCaptureManifest({
  functionName,
  projectRef,
  liveVersion,
  verifyJwt,
  ezbrSha256 = null,
  status = null,
  files,
  treeDigest,
  capturedAt = new Date().toISOString(),
}) {
  return {
    schema: CAPTURE_SCHEMA,
    function_name: functionName,
    target: projectRef,
    captured_at: capturedAt,
    live_version: liveVersion,
    verify_jwt: verifyJwt,
    ezbr_sha256: ezbrSha256,
    status,
    file_count: files.length,
    files,
    tree_digest: treeDigest,
  };
}

/**
 * Validates a capture against the function and project it claims, and against
 * the bytes on disk right now.
 *
 * `expected.functionName` and `expected.productionRef` are required: a capture
 * that is internally consistent but describes a DIFFERENT function is the most
 * dangerous artifact in this whole flow, because restoring it would overwrite a
 * healthy function with someone else's bundle.
 *
 * @returns {{ok: boolean, problems: string[], files: string[]}}
 */
export function verifyCapture({ capture, captureRoot, expected }) {
  const problems = [];
  const push = (m) => problems.push(m);

  if (!capture || typeof capture !== 'object') {
    return { ok: false, problems: ['capture manifest is missing or not an object'], files: [] };
  }
  if (capture.schema !== CAPTURE_SCHEMA) {
    push(`capture schema must be ${CAPTURE_SCHEMA}, got "${capture.schema}"`);
  }
  if (!capture.function_name) push('capture is missing function_name');
  if (!capture.target) push('capture is missing target');
  if (!capture.captured_at) push('capture is missing captured_at');
  if (capture.verify_jwt !== true && capture.verify_jwt !== false) {
    push('capture is missing a boolean verify_jwt — the original auth posture cannot be restored');
  }
  if (capture.live_version === undefined || capture.live_version === null) {
    push('capture is missing live_version');
  }

  if (expected?.productionRef && capture.target && capture.target !== expected.productionRef) {
    push(`capture targets ${capture.target}, not production (${expected.productionRef}) — refusing`);
  }
  if (expected?.stagingRef && capture.target === expected.stagingRef) {
    push('capture targets staging — refusing');
  }
  if (expected?.functionName && capture.function_name && capture.function_name !== expected.functionName) {
    push(
      `capture is for function "${capture.function_name}" but the rollback is for "${expected.functionName}" — refusing`,
    );
  }

  const declared = Array.isArray(capture.files) ? capture.files : [];
  if (declared.length === 0) {
    push('capture declares no files — there is nothing to restore');
  }
  if (capture.file_count !== undefined && capture.file_count !== declared.length) {
    push(`capture file_count ${capture.file_count} does not match the ${declared.length} files declared`);
  }

  // Integrity: the bytes on disk must still be the bytes that were captured.
  const restored = [];
  if (captureRoot) {
    for (const entry of declared) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
        push(`capture file entry is malformed: ${JSON.stringify(entry)}`);
        continue;
      }
      if (entry.path.includes('..') || path.isAbsolute(entry.path)) {
        push(`capture file path escapes the capture directory: ${entry.path}`);
        continue;
      }
      const abs = path.join(captureRoot, entry.path);
      if (!fs.existsSync(abs)) {
        push(`captured file is missing from disk: ${entry.path}`);
        continue;
      }
      const actual = sha256(fs.readFileSync(abs));
      if (actual !== entry.sha256) {
        push(`captured file ${entry.path} fails its integrity check (expected ${entry.sha256}, got ${actual})`);
        continue;
      }
      restored.push(entry.path);
    }

    // An extra file on disk is as disqualifying as a missing one: it would be
    // deployed along with the restore without ever having been captured.
    const onDisk = listCapturableFiles(captureRoot);
    const declaredPaths = new Set(declared.map((f) => f?.path));
    for (const rel of onDisk) {
      if (!declaredPaths.has(rel)) push(`capture directory holds an undeclared file: ${rel}`);
    }

    if (declared.length > 0 && restored.length === declared.length && capture.tree_digest) {
      const { treeDigest } = digestTree(captureRoot, declared.map((f) => f.path));
      if (treeDigest !== capture.tree_digest) {
        push(`capture tree digest mismatch (expected ${capture.tree_digest}, got ${treeDigest})`);
      }
    }
  }

  return { ok: problems.length === 0, problems, files: restored };
}

/**
 * Decides what a rollback should do, without doing it.
 *
 * Two shapes, and only two:
 *   - prior_version present -> RESTORE_CAPTURED_BUNDLE, which REQUIRES a
 *     verified capture. This is the case that used to be an unconditional
 *     failure.
 *   - no prior_version      -> DELETE_NEW_FUNCTION, unchanged: the function did
 *     not exist before this deployment, so removing it restores the prior state
 *     exactly.
 *
 * @returns {{action: string|null, blockers: string[], verifyJwt?: boolean, files?: string[]}}
 */
export function planRollback({ manifest, capture = null, captureRoot = null, expected }) {
  const blockers = [];

  if (!manifest || typeof manifest !== 'object') {
    return { action: null, blockers: ['deployment manifest is missing or not an object'] };
  }
  if (!manifest.function_name) blockers.push('manifest missing function_name');
  if (manifest.target && expected?.stagingRef && manifest.target === expected.stagingRef) {
    blockers.push('manifest targets staging — refusing');
  }
  if (manifest.target && expected?.productionRef && manifest.target !== expected.productionRef) {
    blockers.push(`manifest target ${manifest.target} is not production`);
  }
  if (blockers.length > 0) return { action: null, blockers };

  const isExisting = manifest.prior_version !== null && manifest.prior_version !== undefined;

  if (!isExisting) {
    return { action: 'DELETE_NEW_FUNCTION', blockers: [] };
  }

  // From here on the function pre-existed, so only a captured bundle restores it.
  if (!capture) {
    return {
      action: null,
      blockers: [
        `${manifest.function_name} pre-existed this deployment (prior_version=${manifest.prior_version}) ` +
          'but no captured production bundle was supplied. Exact rollback is impossible without one. ' +
          'Re-run with --capture <capture.json>, or capture before deploying (scripts/capture-production-function.mjs). ' +
          'The current git tree is the NEW source and is never a substitute.',
      ],
    };
  }

  const verified = verifyCapture({
    capture,
    captureRoot,
    expected: { ...expected, functionName: manifest.function_name },
  });
  if (!verified.ok) {
    return {
      action: null,
      blockers: verified.problems.map((p) => `captured bundle unusable: ${p}`),
    };
  }

  return {
    action: 'RESTORE_CAPTURED_BUNDLE',
    blockers: [],
    verifyJwt: capture.verify_jwt,
    files: verified.files,
    priorVersion: manifest.prior_version,
    capturedAt: capture.captured_at,
  };
}

/**
 * The exact CLI arguments that redeploy a captured bundle.
 *
 * verify_jwt is restored from the CAPTURE, never from the deployment manifest
 * or a default: the manifest records the posture the failed deploy asked for,
 * which is precisely the thing being undone. Getting this backwards would
 * silently change an authentication boundary during a recovery.
 */
export function restoreDeployArgs({ functionName, projectRef, verifyJwt }) {
  const args = ['functions', 'deploy', functionName, '--project-ref', projectRef];
  if (verifyJwt === false) args.push('--no-verify-jwt');
  return args;
}
