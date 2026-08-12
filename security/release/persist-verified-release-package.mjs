#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Verified release package persistence — the SINGLE publication authority
 * (DEF-REL-015).
 *
 * Previously `publishPackage()` implemented upload + read-back + digest
 * verification, while the workflow published with its own `gh release create`
 * block in YAML. Two implementations, and the one that actually ran was the
 * one WITHOUT the read-back check — so "persistence verified" was not true of
 * the executed path.
 *
 * This is the executable the workflow invokes. The YAML no longer contains any
 * publication algorithm: it calls this, which calls `publishPackage()`, which
 * performs the read-back and digest comparison. One authority, one code path.
 *
 * Node built-ins only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import packageModule from './verified-release-package.mjs';
import runtimeAdapters from './activation-runtime-adapters.mjs';

const { buildPackage, publishPackage, ASSET_NAMES } = packageModule;
const { createGithubAdapter } = runtimeAdapters;

/** Files the execute job must have produced before anything can be published. */
export const REQUIRED_INPUT_FILES = Object.freeze([
  'verified-baseline.json',
  'release-evidence.json',
  'deployment-receipt.json',
  'frozen-manifest.json',
]);

export class PersistenceError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Publishes the verified package from an activation output directory.
 *
 * @param {object} opts
 * @param {string} opts.inputDir  - the execute job's output directory
 * @param {object} [opts.github]  - injected adapter (tests supply a fake)
 * @param {boolean} [opts.planOnly]
 */
export async function persistVerifiedRelease({ inputDir, github = null, planOnly = false, env = process.env } = {}) {
  const missing = REQUIRED_INPUT_FILES.filter((name) => !fs.existsSync(path.join(inputDir, name)));
  if (missing.length > 0) {
    // A denied release never produces verified-baseline.json, so this is also
    // the guard that stops persistence of an unverified run.
    return {
      ok: false,
      code: 'VERIFIED_BASELINE_PERSISTENCE_GAP',
      failures: [{ code: 'MISSING_REQUIRED_ARTIFACT', detail: missing.join(', ') }],
    };
  }

  const baseline = readJson(path.join(inputDir, 'verified-baseline.json'));
  const evidence = readJson(path.join(inputDir, 'release-evidence.json'));
  const receipt = readJson(path.join(inputDir, 'deployment-receipt.json'));
  const frozenManifest = readJson(path.join(inputDir, 'frozen-manifest.json'));
  const manifest = frozenManifest.manifest || frozenManifest;

  // Refuse to publish a package whose own evidence says it was not verified.
  if (evidence.stagingVerifiedEligible !== true) {
    return {
      ok: false,
      code: 'VERIFIED_BASELINE_PERSISTENCE_GAP',
      failures: [{ code: 'RELEASE_NOT_STAGING_VERIFIED', detail: `verdict ${evidence.releaseCandidateVerdict}` }],
    };
  }

  const pkg = buildPackage({
    baseline,
    evidence,
    receipt,
    manifest,
    candidateSha: baseline.sourceSha,
    releaseId: baseline.releaseId,
  });

  const adapter = github || createGithubAdapter({
    repo: env.GITHUB_REPOSITORY || 'kscanaiapp/kscan-app',
    env,
  });

  // publishPackage performs create -> upload -> READ BACK -> digest compare.
  return publishPackage({ pkg, github: adapter, planOnly });
}

export default { REQUIRED_INPUT_FILES, PersistenceError, persistVerifiedRelease, ASSET_NAMES };

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv;
  const inputDir = argv.includes('--input-dir') ? argv[argv.indexOf('--input-dir') + 1] : null;
  const planOnly = argv.includes('--plan-only');

  if (!inputDir) {
    console.error('FAIL  --input-dir <activation output dir> is required');
    process.exit(2);
  }

  persistVerifiedRelease({ inputDir, planOnly }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      console.error(`FAIL  ${result.code || 'PERSISTENCE_FAILED'}`);
      process.exit(1);
    }
    process.exit(0);
  }).catch((error) => {
    console.error(`FAIL  ${error.code || 'ERROR'}: ${error.message}`);
    process.exit(1);
  });
}
