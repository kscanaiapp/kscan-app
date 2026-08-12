#!/usr/bin/env node
/**
 * Governed staging runtime-flag writer (DEF-B29-SVV-004).
 *
 * Phase 7 ships dark: its source is in Build 29, but the running staging
 * scanner only enables it when SCAN_IDENTIFICATION_RECHECK_ENABLED is true in
 * the Edge Function environment. No governed path existed to set that, and the
 * two obvious shortcuts were both refused:
 *
 *   - the six/seven-key KSCAN release-metadata writer describes release
 *     IDENTITY. A behaviour flag is not identity, and adding it there would
 *     have made the release digest answer a question it does not ask;
 *   - a generic key/value secret setter would be an arbitrary write primitive
 *     pointed at a live backend, which is a larger capability than the problem
 *     needs.
 *
 * So this writer is deliberately tiny: one allowlisted key, one allowlisted
 * value, staging only. Widening it requires a reviewed code change to the
 * allowlist below, which is the point.
 *
 * Safety properties, mirrored from set-staging-release-metadata.mjs:
 *   - the production project is an explicit deny, checked before any command
 *     is built;
 *   - SUPABASE_ACCESS_TOKEN reaches the CLI through the environment only,
 *     never as an argv element, so it cannot appear in a process listing;
 *   - the value is written through an ephemeral 0600 env file that is removed
 *     in a finally block, never passed on the command line;
 *   - nothing echoes the token, the value, or service-role material.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authority = require('../scripts/lib/environment-authority.js');
const { STAGING_REF, PRODUCTION_REF, assertExpectedEnvironment } = authority;

/**
 * The complete set of runtime flags this writer may set, and the only value
 * each may be set to. Both halves are allowlists: an approved key with an
 * unapproved value is refused just as firmly as an unknown key.
 */
const ALLOWED_FLAGS = Object.freeze({
  SCAN_IDENTIFICATION_RECHECK_ENABLED: Object.freeze(['true']),
});

/** Release-identity keys this writer must never touch. */
const RELEASE_METADATA_KEYS = Object.freeze([
  'KSCAN_RELEASE_ID', 'KSCAN_SOURCE_SHA', 'KSCAN_SOURCE_TREE_SHA',
  'KSCAN_MANIFEST_DIGEST', 'KSCAN_HEALTH_CONTRACT_VERSION',
  'KSCAN_DEPLOYED_AT', 'KSCAN_ENVIRONMENT', 'KSCAN_DEPLOY_VERSION',
]);

const CONFIRMATION = 'SET-STAGING-RUNTIME-FLAG';

export class RuntimeFlagError extends Error {
  constructor(message, code, detail = null) {
    super(message);
    this.name = 'RuntimeFlagError';
    this.code = code;
    this.detail = detail;
  }
}

const sanitize = (text) => String(text || '').replace(/sbp_[a-f0-9]{40}/g, '[redacted]');

export function assertFlagAllowed(key, value) {
  if (RELEASE_METADATA_KEYS.includes(key)) {
    throw new RuntimeFlagError(
      `${key} is release identity and is never writable by the runtime-flag path`,
      'RELEASE_METADATA_KEY_REJECTED',
    );
  }
  const allowedValues = ALLOWED_FLAGS[key];
  if (!allowedValues) {
    throw new RuntimeFlagError(
      `${key} is not an allowlisted staging runtime flag; widening requires a reviewed change`,
      'FLAG_NOT_ALLOWLISTED',
    );
  }
  if (!allowedValues.includes(value)) {
    throw new RuntimeFlagError(
      `${key} may not be set to the requested value on this path`,
      'FLAG_VALUE_NOT_ALLOWLISTED',
    );
  }
  return true;
}

export function setStagingRuntimeFlag({
  key,
  value,
  projectRef = STAGING_REF,
  confirm = '',
  env = process.env,
  exec = spawnSync,
  planOnly = false,
} = {}) {
  // Environment first: never build a command for the wrong project.
  if (projectRef === PRODUCTION_REF) {
    throw new RuntimeFlagError(
      `PRODUCTION PROJECT REJECTED: this writer may never target ${PRODUCTION_REF}`,
      'PRODUCTION_TARGET_REJECTED',
    );
  }
  assertExpectedEnvironment('staging', projectRef);

  assertFlagAllowed(key, value);

  if (confirm !== CONFIRMATION) {
    throw new RuntimeFlagError(
      `explicit confirmation is required: type ${CONFIRMATION}`,
      'CONFIRMATION_REQUIRED',
    );
  }

  const plan = { key, projectRef, planOnly };
  if (planOnly) return { ok: true, planOnly: true, plan, written: false };

  if (!env.SUPABASE_ACCESS_TOKEN) {
    throw new RuntimeFlagError(
      'SUPABASE_ACCESS_TOKEN is not available; this writer runs only in the governed staging environment',
      'MISSING_SUPABASE_AUTHORITY',
    );
  }

  const tempRoot = env.RUNNER_TEMP || os.tmpdir();
  const envFile = path.join(tempRoot, `kscan-runtime-flag-${crypto.randomBytes(8).toString('hex')}.env`);

  try {
    // The value goes through a 0600 file, never argv.
    fs.writeFileSync(envFile, `${key}=${value}\n`, { mode: 0o600 });

    const args = ['secrets', 'set', '--env-file', envFile, '--project-ref', projectRef];
    const result = exec('supabase', args, {
      encoding: 'utf8',
      env: { ...env, SUPABASE_ACCESS_TOKEN: env.SUPABASE_ACCESS_TOKEN },
    });

    if (result.status !== 0) {
      throw new RuntimeFlagError(
        `supabase secrets set failed with exit ${result.status}`,
        'FLAG_WRITE_FAILED',
        { stderr: sanitize(result.stderr), stdout: sanitize(result.stdout) },
      );
    }
    return { ok: true, planOnly: false, plan, written: true };
  } finally {
    try { fs.rmSync(envFile, { force: true }); } catch { /* best effort */ }
  }
}

export { ALLOWED_FLAGS, RELEASE_METADATA_KEYS, CONFIRMATION };

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? '' : (process.argv[i + 1] || '');
  };
  try {
    const result = setStagingRuntimeFlag({
      key: arg('key'),
      value: arg('value'),
      projectRef: arg('project-ref') || STAGING_REF,
      confirm: arg('confirm'),
      planOnly: process.argv.includes('--plan-only'),
    });
    // Key and target only: the value is not echoed.
    console.log(JSON.stringify({
      ok: result.ok, written: result.written, key: result.plan.key, projectRef: result.plan.projectRef,
    }, null, 2));
  } catch (err) {
    console.error(`${err.code || 'RUNTIME_FLAG_ERROR'}: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.split('\\').join('/')}`
  || import.meta.url.endsWith(process.argv[1]?.split('\\').join('/') || '\u0000')) {
  main();
}
