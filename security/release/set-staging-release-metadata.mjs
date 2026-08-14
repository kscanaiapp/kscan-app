#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Staging release-metadata writer — narrow, allowlisted, staging-only.
 *
 * This is the ONLY sanctioned path that writes Supabase function configuration
 * in this repository, and it is deliberately not a general secret manager.
 *
 *   - the key set is a STATIC allowlist of exactly seven release-identity keys
 *   - the target project is derived from environment-authority, never from a
 *     caller-supplied ref
 *   - the production project is an explicit deny, checked before any command
 *     is constructed, let alone executed
 *
 * The seven values are NON-SECRET build metadata (environment, a release id,
 * git SHAs, a digest, a contract version, a timestamp). They are still handled as
 * ephemeral deployment material: written to a RUNNER_TEMP env file, passed to
 * the CLI by path, and deleted in a finally block.
 *
 * SUPABASE_ACCESS_TOKEN is read from the environment for the CLI's own use and
 * is never logged, never echoed, and never written to any artifact.
 *
 * Node built-ins only.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import authority from '../scripts/lib/environment-authority.js';

const { STAGING_REF, PRODUCTION_REF, assertExpectedEnvironment } = authority;

/**
 * The complete, static set of keys this writer may ever set. Adding a key is a
 * deliberate, reviewed change — not a parameter.
 */
export const ALLOWED_METADATA_KEYS = Object.freeze([
  'KSCAN_RELEASE_ID',
  'KSCAN_SOURCE_SHA',
  'KSCAN_SOURCE_TREE_SHA',
  'KSCAN_MANIFEST_DIGEST',
  'KSCAN_HEALTH_CONTRACT_VERSION',
  'KSCAN_DEPLOYED_AT',
  'KSCAN_ENVIRONMENT',
]);

/** Caller-facing field -> Supabase key. The mapping is fixed. */
const FIELD_TO_KEY = Object.freeze({
  releaseId: 'KSCAN_RELEASE_ID',
  sourceSha: 'KSCAN_SOURCE_SHA',
  sourceTreeSha: 'KSCAN_SOURCE_TREE_SHA',
  manifestDigest: 'KSCAN_MANIFEST_DIGEST',
  healthContractVersion: 'KSCAN_HEALTH_CONTRACT_VERSION',
  deployedAt: 'KSCAN_DEPLOYED_AT',
  environment: 'KSCAN_ENVIRONMENT',
});

const SHA1_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const RELEASE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const HEALTH_CONTRACT_RE = /^health-contract-v[0-9][A-Za-z0-9.-]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ENVIRONMENT_RE = /^staging$/;

export class ReleaseMetadataError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'ReleaseMetadataError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Validates the caller's fields and produces the exact key/value map to write.
 * Pure — performs no I/O — so the rules are unit-testable without a CLI.
 *
 * @returns {Record<string, string>}
 */
export function buildMetadataMap(fields) {
  if (!fields || typeof fields !== 'object') {
    throw new ReleaseMetadataError('metadata fields object is required', 'MISSING_FIELDS');
  }

  const known = Object.keys(FIELD_TO_KEY);
  const unknown = Object.keys(fields).filter((k) => !known.includes(k));
  if (unknown.length > 0) {
    throw new ReleaseMetadataError(
      `refusing unknown metadata field(s): ${unknown.join(', ')}. This writer sets exactly ${known.length} release-identity keys.`,
      'UNKNOWN_KEY_REJECTED',
      unknown,
    );
  }

  const errors = [];
  const need = (ok, detail) => { if (!ok) errors.push(detail); };

  need(typeof fields.releaseId === 'string' && RELEASE_ID_RE.test(fields.releaseId),
    'releaseId must be a non-empty token of [A-Za-z0-9._-]');
  need(typeof fields.sourceSha === 'string' && SHA1_RE.test(fields.sourceSha),
    'sourceSha must be a 40-hex git commit SHA');
  need(typeof fields.sourceTreeSha === 'string' && SHA1_RE.test(fields.sourceTreeSha),
    'sourceTreeSha must be a 40-hex git tree SHA');
  need(typeof fields.manifestDigest === 'string' && SHA256_RE.test(fields.manifestDigest),
    'manifestDigest must be a 64-hex sha256 digest');
  need(typeof fields.healthContractVersion === 'string' && HEALTH_CONTRACT_RE.test(fields.healthContractVersion),
    'healthContractVersion must look like health-contract-vN');
  need(typeof fields.deployedAt === 'string' && ISO_RE.test(fields.deployedAt),
    'deployedAt must be an ISO-8601 UTC timestamp');
  need(typeof fields.environment === 'string' && ENVIRONMENT_RE.test(fields.environment),
    'environment must be the literal staging environment');

  if (errors.length > 0) {
    throw new ReleaseMetadataError(
      `malformed release metadata: ${errors.join('; ')}`,
      'MALFORMED_METADATA',
      errors,
    );
  }

  /** @type {Record<string,string>} */
  const map = {};
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) map[key] = fields[field];

  // Belt and braces: the produced key set must equal the allowlist exactly.
  const produced = Object.keys(map).sort();
  const allowed = [...ALLOWED_METADATA_KEYS].sort();
  if (produced.length !== allowed.length || produced.some((k, i) => k !== allowed[i])) {
    throw new ReleaseMetadataError('produced key set does not equal the static allowlist', 'ALLOWLIST_VIOLATION', produced);
  }
  return map;
}

/**
 * Resolves and hard-checks the target project BEFORE any command exists.
 * Production is an explicit deny with its own code so it is unmistakable in
 * logs and tests.
 */
export function assertStagingTarget(projectRef) {
  if (projectRef === PRODUCTION_REF) {
    throw new ReleaseMetadataError(
      `PRODUCTION PROJECT REJECTED: this writer may never target ${PRODUCTION_REF}`,
      'PRODUCTION_TARGET_REJECTED',
    );
  }
  try {
    assertExpectedEnvironment('staging', projectRef);
  } catch (error) {
    throw new ReleaseMetadataError(
      `target project did not resolve to staging (${error.code})`,
      'NON_STAGING_TARGET_REJECTED',
    );
  }
  return projectRef;
}

/** `KEY=value` env-file body. Values are validated tokens, so no quoting games. */
export function renderEnvFile(map) {
  return `${ALLOWED_METADATA_KEYS.map((k) => `${k}=${map[k]}`).join('\n')}\n`;
}

/**
 * Writes the six release-metadata keys to the staging project.
 *
 * @param {object} opts
 * @param {object} opts.fields
 * @param {string} [opts.projectRef]  - defaults to the resolved staging ref
 * @param {boolean} [opts.planOnly]   - when true, validate and return the plan; write nothing
 * @param {function} [opts.exec]      - injected runner, for tests
 * @param {object} [opts.env]
 */
export function setStagingReleaseMetadata({
  fields,
  projectRef = STAGING_REF,
  planOnly = false,
  exec = spawnSync,
  env = process.env,
}) {
  const target = assertStagingTarget(projectRef);
  const map = buildMetadataMap(fields);

  const plan = {
    action: 'set-staging-release-metadata',
    projectRef: target,
    keys: [...ALLOWED_METADATA_KEYS],
    // Values are non-secret and are echoed back so a plan run is auditable.
    values: map,
  };

  if (planOnly) return { ok: true, planOnly: true, plan, written: false };

  if (!env.SUPABASE_ACCESS_TOKEN) {
    throw new ReleaseMetadataError(
      'SUPABASE_ACCESS_TOKEN is not available; this writer runs only in the governed staging environment',
      'MISSING_SUPABASE_AUTHORITY',
    );
  }

  // Ephemeral: runner temp, unique name, removed in finally.
  const tempRoot = env.RUNNER_TEMP || os.tmpdir();
  const envFile = path.join(tempRoot, `kscan-release-metadata-${crypto.randomBytes(8).toString('hex')}.env`);

  try {
    fs.writeFileSync(envFile, renderEnvFile(map), { mode: 0o600 });

    const args = ['secrets', 'set', '--env-file', envFile, '--project-ref', target];
    const result = exec('supabase', args, {
      encoding: 'utf8',
      // The token reaches the CLI through the environment only. It is never an
      // argv element, so it cannot appear in a process listing or a log line.
      env: { ...env, SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN },
    });

    if (result.status !== 0) {
      throw new ReleaseMetadataError(
        `supabase secrets set failed with exit ${result.status}`,
        'METADATA_WRITE_FAILED',
        // stderr may echo the command; never include env or the token.
        { stderr: sanitize(String(result.stderr || '')), stdout: sanitize(String(result.stdout || '')) },
      );
    }

    return { ok: true, planOnly: false, plan, written: true };
  } finally {
    try { fs.rmSync(envFile, { force: true }); } catch { /* best effort */ }
  }
}

/** Strips anything token-shaped from CLI output before it can reach evidence. */
export function sanitize(text) {
  return String(text)
    .replace(/\bsbp_[A-Za-z0-9]{8,}/g, '[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]');
}

export default {
  ALLOWED_METADATA_KEYS,
  ReleaseMetadataError,
  buildMetadataMap,
  assertStagingTarget,
  renderEnvFile,
  setStagingReleaseMetadata,
  sanitize,
};
