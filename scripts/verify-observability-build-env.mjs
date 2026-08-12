#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[a-f0-9]{40}$/i;
const RELEASE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const VALID_ENVIRONMENTS = new Set(['development', 'staging', 'production']);

export function validateObservabilityBuildEnvironment(env = process.env) {
  const errors = [];
  const environment = String(env.KSCAN_OBSERVABILITY_ENVIRONMENT || '').trim().toLowerCase();
  const releaseId = String(env.KSCAN_RELEASE_ID || '').trim();
  const sourceSha = String(env.KSCAN_SOURCE_SHA || env.EAS_BUILD_GIT_COMMIT_HASH || env.GITHUB_SHA || '')
    .trim()
    .toLowerCase();

  if (!VALID_ENVIRONMENTS.has(environment)) {
    errors.push('KSCAN_OBSERVABILITY_ENVIRONMENT must be development, staging, or production');
  }
  if (!RELEASE_ID_RE.test(releaseId)) {
    errors.push('KSCAN_RELEASE_ID must be supplied by the governed release invocation');
  }
  if (!SHA_RE.test(sourceSha)) {
    errors.push('KSCAN_SOURCE_SHA or EAS_BUILD_GIT_COMMIT_HASH must be a 40-hex Git SHA');
  }

  const profile = String(env.EAS_BUILD_PROFILE || '').trim().toLowerCase();
  if (profile === 'production' && environment !== 'production') {
    errors.push('production profile cannot emit a non-production observability environment');
  }
  if (profile && profile !== 'production' && environment === 'production') {
    errors.push('non-production profile cannot emit the production observability environment');
  }

  return {
    ok: errors.length === 0,
    errors,
    identity: { environment, releaseId: releaseId || null, sourceSha: SHA_RE.test(sourceSha) ? sourceSha : null },
  };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const result = validateObservabilityBuildEnvironment();
  if (!result.ok) {
    console.error(`OBSERVABILITY_BUILD_ENV_INVALID\n- ${result.errors.join('\n- ')}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'OBSERVABILITY_BUILD_ENV_VALID', ...result.identity }));
}
