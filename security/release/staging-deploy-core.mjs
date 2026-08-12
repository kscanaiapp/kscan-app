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

const { STAGING_REF, PRODUCTION_REF, assertExpectedEnvironment } = authority;

export class StagingDeployError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'StagingDeployError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Recursively hashes a directory's contents. Mirrors the manifest generator's algorithm. */
export function hashDirectory(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  const parts = files.map((f) => {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    return `${rel}:${crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8'), 'utf8').digest('hex')}`;
  });
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
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

  return { ok: violations.length === 0, violations, sourceDir: dir, sourceHash: actual, verifyJwt: entry.verifyJwt };
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

  const plan = {
    functionName,
    projectRef,
    sourceDir: validation.sourceDir,
    sourceHash: validation.sourceHash,
    verifyJwt: validation.verifyJwt,
    command: ['supabase', 'functions', 'deploy', functionName, '--project-ref', projectRef],
  };

  if (planOnly) return { ok: true, functionName, status: 'PLANNED', plan, deployed: false };

  if (!env.SUPABASE_ACCESS_TOKEN) {
    return {
      ok: false, functionName, status: 'OPERATIONAL_FAILURE',
      violations: [{ code: 'MISSING_SUPABASE_AUTHORITY', detail: 'SUPABASE_ACCESS_TOKEN not available' }],
    };
  }

  // `--project-ref` is always explicit: never rely on linked-project state.
  const args = ['functions', 'deploy', functionName, '--project-ref', projectRef];
  const result = exec('supabase', args, {
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
  materializeCandidate,
  validateDeployInput,
  deployOneFromCandidate,
};
