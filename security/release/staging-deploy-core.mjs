#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Shared staging deploy core.
 *
 * WHY THIS EXISTS: the existing controlled deployer
 * (scripts/deploy-staging-function.mjs) deploys ONE function and reads it from
 * `process.cwd()` — the runner's checked-out tree. That is fine for a
 * single-function controlled deploy, but it cannot satisfy bootstrap, which
 * must prove every deployed byte came from a frozen candidate.
 *
 * Rather than add a second, parallel deployer, this factors the deployment
 * decision into one core that BOTH paths can use, with two guarantees the old
 * path lacked:
 *
 *   1. IMMUTABLE SOURCE. Deploy input is materialized from a git object via
 *      `git archive <candidateSha>`, never from a mutable worktree. A worktree
 *      edit after binding cannot change what ships (the TOCTOU case).
 *
 *   2. HASH AGREEMENT. The hash of the materialized directory must equal the
 *      hash candidate-binding recorded. If they disagree, deployment blocks —
 *      the binding is describing something other than what would deploy.
 *
 * This module decides and materializes. It shells out to the Supabase CLI for
 * the deploy itself, exactly as the existing path does, so there is still only
 * one deployment technology.
 *
 * Node built-ins only.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import authority from '../scripts/lib/environment-authority.js';
import sourceHash from './function-source-hash.js';

const { STAGING_REF, PRODUCTION_REF, assertExpectedEnvironment } = authority;

export class StagingDeployError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'StagingDeployError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Canonical function-source digest (DEF-REL-017). Delegates to the single
 * shared implementation in function-source-hash.js so the deploy-input hash is
 * byte-identical to the one candidate binding recorded. There is deliberately
 * no local hashing here — three near-identical hashers is what caused the
 * binding/deploy contract mismatch in the first place.
 */
export function hashDirectory(dir) {
  return sourceHash.hashFunctionSource(dir);
}

/**
 * Materializes a candidate's `supabase/functions` tree into a temp directory
 * using `git archive`, so the deploy input is a git object and not the
 * worktree.
 *
 * @returns {{root: string, cleanup: function}}
 */
export function materializeCandidate({ repoRoot, candidateSha, tempRoot = process.env.RUNNER_TEMP || os.tmpdir() }) {
  if (!/^[a-f0-9]{40}$/.test(String(candidateSha || ''))) {
    throw new StagingDeployError(`candidateSha must be a full 40-hex SHA, got ${candidateSha}`, 'INVALID_CANDIDATE_SHA');
  }
  const dest = path.join(tempRoot, `kscan-candidate-${candidateSha.slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dest, { recursive: true });

  // Extraction is `git ls-tree` + `git show`, i.e. pure git-object reads, and
  // deliberately NOT `git archive | tar`: GNU tar on Windows parses a `C:\...`
  // destination as a remote host spec and fails ("Cannot connect to C:"). This
  // is also the same mechanism candidate-binding.js uses to hash the candidate,
  // so the bytes deployed and the bytes hashed are read the same way.
  try {
    const listing = execFileSync(
      'git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', candidateSha, '--', 'supabase/functions'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ).split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (listing.length === 0) {
      throw new Error('candidate contains no supabase/functions entries');
    }

    for (const repoPath of listing) {
      const contents = execFileSync('git', ['-C', repoRoot, 'show', `${candidateSha}:${repoPath}`], {
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
      });
      const target = path.join(dest, ...repoPath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  } catch (error) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new StagingDeployError(
      `failed to materialize candidate ${candidateSha}: ${error.message}`,
      'CANDIDATE_MATERIALIZATION_FAILED',
    );
  }

  return {
    root: dest,
    cleanup: () => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/**
 * Resolves the governed `verify_jwt` posture for a function (DEF-REL-016).
 *
 * This is deliberately fail-closed. Deploying with the wrong posture silently
 * changes runtime AUTHORIZATION: deploying `staging-health` with JWT
 * verification on would break the public probe, and deploying an authenticated
 * function with it off would expose it. So the value must come from governed
 * configuration, never from a default:
 *
 *   1. the manifest entry, populated from root `supabase/config.toml`
 *   2. root `supabase/config.toml`, where `edge-function-governance.json`
 *      records the posture as pinned
 *   3. the function's own `supabase/functions/<name>/config.toml`
 *      (`staging-health` is declared only here, the root file omits it)
 *
 * If none declares it, this throws rather than guessing.
 */

/**
 * Reads the governed posture from root `supabase/config.toml` (DEF-B29-SVV-010).
 *
 * The list above always named root config.toml as the authority, but reached it
 * only "populated from" it via the manifest, and nothing ever populated that.
 * The manifest is `environmentScope: ENVIRONMENT_NEUTRAL` (DEF-REL-006) and
 * carries no `verifyJwt` key for any function, so step 1 never fired. Every
 * governed function except `staging-health` (the only one with a per-function
 * config.toml) was therefore undeployable through this path: a correct
 * fail-closed refusal standing on a premise that was never true. Root
 * config.toml is now read directly rather than through a manifest field that
 * does not exist.
 *
 * Returns null rather than a default when the posture is absent, so the caller
 * still fails closed.
 */
function readRootConfigVerifyJwt(candidateRoot, functionName) {
  const rootConfig = path.join(candidateRoot, 'supabase', 'config.toml');
  if (!fs.existsSync(rootConfig)) return null;
  const target = `[functions.${functionName}]`;
  let inSection = false;
  for (const rawLine of fs.readFileSync(rootConfig, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      // Any new table ends the previous one, so a neighbouring function's
      // posture can never be read as this function's.
      inSection = line === target;
      continue;
    }
    if (!inSection) continue;
    const match = /^verify_jwt\s*=\s*(true|false)\s*$/.exec(line);
    if (match) return match[1] === 'true';
  }
  return null;
}

export function resolveVerifyJwt({ manifestEntry, candidateRoot, functionName }) {
  if (manifestEntry && typeof manifestEntry.verifyJwt === 'boolean') {
    return { verifyJwt: manifestEntry.verifyJwt, source: 'manifest/root-config' };
  }
  const fromRootConfig = readRootConfigVerifyJwt(candidateRoot, functionName);
  if (typeof fromRootConfig === 'boolean') {
    return { verifyJwt: fromRootConfig, source: 'root-config.toml' };
  }
  const perFunction = path.join(candidateRoot, 'supabase', 'functions', functionName, 'config.toml');
  if (fs.existsSync(perFunction)) {
    const match = /^\s*verify_jwt\s*=\s*(true|false)\s*$/m.exec(fs.readFileSync(perFunction, 'utf8'));
    if (match) return { verifyJwt: match[1] === 'true', source: 'function-config.toml' };
  }
  throw new StagingDeployError(
    `verify_jwt posture for ${functionName} is not declared in governed configuration; refusing to guess`,
    'VERIFY_JWT_UNRESOLVED',
  );
}

/**
 * The shared deploy command primitive. Both the ordinary controlled
 * single-function path and bootstrap build their command here, so the
 * `--no-verify-jwt` flag cannot be honoured by one caller and forgotten by the
 * other — which is exactly what happened before DEF-REL-016.
 */
export function buildDeployArgs({ functionName, projectRef, verifyJwt, debug = false }) {
  if (typeof verifyJwt !== 'boolean') {
    throw new StagingDeployError(`verifyJwt must be an explicit boolean for ${functionName}`, 'VERIFY_JWT_UNRESOLVED');
  }
  const args = ['functions', 'deploy', functionName, '--project-ref', projectRef];
  if (!verifyJwt) args.push('--no-verify-jwt');
  if (debug) args.push('--debug');
  return args;
}

/**
 * Validates a single function deployment before it runs. Pure: no I/O beyond
 * hashing the already-materialized source.
 */
export function validateDeployInput({ functionName, manifest, candidateRoot, expectedSourceHash, projectRef }) {
  const violations = [];

  if (projectRef === PRODUCTION_REF) {
    throw new StagingDeployError(
      `PRODUCTION PROJECT REJECTED: staging deploy core may never target ${PRODUCTION_REF}`,
      'PRODUCTION_TARGET_REJECTED',
    );
  }
  assertExpectedEnvironment('staging', projectRef);

  const entry = (manifest.edgeFunctions || []).find((f) => f.name === functionName);
  if (!entry) {
    violations.push({ code: 'NOT_IN_MANIFEST', detail: `${functionName} is absent from the release manifest` });
    return { ok: false, violations };
  }
  if (entry.class !== 'GOVERNED' || !entry.releaseIncluded) {
    violations.push({ code: 'NOT_GOVERNED', detail: `${functionName} is ${entry.class}, not a release-included GOVERNED function` });
  }

  const dir = path.join(candidateRoot, 'supabase', 'functions', functionName);
  if (!fs.existsSync(dir)) {
    violations.push({ code: 'CANDIDATE_SOURCE_MISSING', detail: `${functionName} is absent from the materialized candidate` });
    return { ok: violations.length === 0, violations };
  }

  const actual = hashDirectory(dir);
  if (expectedSourceHash && actual !== expectedSourceHash) {
    violations.push({
      code: 'SOURCE_HASH_MISMATCH',
      detail: `${functionName}: materialized candidate hashes ${actual}, binding recorded ${expectedSourceHash}`,
    });
  }

  let verifyJwt = null;
  let verifyJwtSource = null;
  try {
    const resolved = resolveVerifyJwt({ manifestEntry: entry, candidateRoot, functionName });
    verifyJwt = resolved.verifyJwt;
    verifyJwtSource = resolved.source;
  } catch (error) {
    violations.push({ code: error.code, detail: error.message });
  }

  return { ok: violations.length === 0, violations, sourceDir: dir, sourceHash: actual, verifyJwt, verifyJwtSource };
}

/**
 * Deploys one governed function from the materialized candidate.
 *
 * @param {object} opts
 * @param {boolean} [opts.planOnly] - validate and return the plan; deploy nothing
 * @param {function} [opts.exec]    - injected runner, for tests
 */
export function deployOneFromCandidate({
  functionName,
  manifest,
  candidateRoot,
  expectedSourceHash,
  projectRef = STAGING_REF,
  planOnly = false,
  exec = spawnSync,
  env = process.env,
}) {
  const validation = validateDeployInput({ functionName, manifest, candidateRoot, expectedSourceHash, projectRef });
  if (!validation.ok) {
    return { ok: false, functionName, status: 'BLOCKED', violations: validation.violations };
  }

  const deployArgs = buildDeployArgs({
    functionName, projectRef, verifyJwt: validation.verifyJwt,
  });

  const plan = {
    functionName,
    projectRef,
    sourceDir: validation.sourceDir,
    sourceHash: validation.sourceHash,
    verifyJwt: validation.verifyJwt,
    verifyJwtSource: validation.verifyJwtSource,
    command: ['supabase', ...deployArgs],
  };

  if (planOnly) return { ok: true, functionName, status: 'PLANNED', plan, deployed: false };

  if (!env.SUPABASE_ACCESS_TOKEN) {
    return {
      ok: false, functionName, status: 'OPERATIONAL_FAILURE',
      violations: [{ code: 'MISSING_SUPABASE_AUTHORITY', detail: 'SUPABASE_ACCESS_TOKEN not available' }],
    };
  }

  // `--project-ref` is always explicit: never rely on linked-project state,
  // and `--no-verify-jwt` comes from the shared builder so the posture cannot
  // drift between callers.
  const result = exec('supabase', deployArgs, {
    encoding: 'utf8',
    cwd: candidateRoot,
    env: { ...env },
  });

  if (result.status !== 0) {
    return {
      ok: false, functionName, status: 'OPERATIONAL_FAILURE',
      violations: [{ code: 'DEPLOY_FAILED', detail: `supabase functions deploy exited ${result.status}` }],
      plan,
    };
  }

  return { ok: true, functionName, status: 'PASS', plan, deployed: true, sourceHash: validation.sourceHash };
}

export default {
  StagingDeployError,
  hashDirectory,
  resolveVerifyJwt,
  buildDeployArgs,
  materializeCandidate,
  validateDeployInput,
  deployOneFromCandidate,
};
