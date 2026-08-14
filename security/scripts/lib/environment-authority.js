#!/usr/bin/env node
'use strict';

/**
 * Single source of truth for "which Supabase project does this ref belong
 * to, and does that match what the caller expected." Every existing guard
 * in this repo (verify-staging-project-ref.js, verify-staging-parity.js,
 * assertNotProductionUrl in the synthetic-auth suite, etc.) reimplements a
 * version of this check independently. This module does not replace them
 * yet - see the "Migration path" note at the bottom - it is the shared
 * implementation new release-control-plane code should depend on, and the
 * one existing duplicated guards should eventually converge on.
 *
 * Fail-closed by design: every assertion here throws on missing, malformed,
 * or unknown identity. There is no silent pass-through for absent input,
 * unlike some of the legacy guards this module is meant to eventually
 * replace (those intentionally tolerate a missing ref in a few call sites;
 * this module does not carry that leniency forward - see the migration
 * note).
 *
 * Node built-ins only. No network calls. No secret values are ever read,
 * accepted, or logged by this module - it operates purely on project refs,
 * which are not secrets.
 */

/** Environment name -> Supabase project ref. The only two environments this repo recognizes. */
const KNOWN_ENVIRONMENTS = Object.freeze({
  staging: 'yzqjvdfgefveprobvvyw',
  production: 'wyyuqfdxucjksghsmhry',
});

const STAGING_REF = KNOWN_ENVIRONMENTS.staging;
const PRODUCTION_REF = KNOWN_ENVIRONMENTS.production;

const REF_TO_ENVIRONMENT = Object.freeze(
  Object.fromEntries(Object.entries(KNOWN_ENVIRONMENTS).map(([env, ref]) => [ref, env])),
);

/** Supabase project refs are 20 lowercase alphanumeric characters. Shape check only - not a claim of validity beyond that. */
const REF_SHAPE = /^[a-z0-9]{20}$/;

class EnvironmentAuthorityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EnvironmentAuthorityError';
    this.code = code;
  }
}

function normalizeRef(ref) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves a project ref to a known environment name ('staging' | 'production').
 * Throws EnvironmentAuthorityError for missing, malformed, or unrecognized refs.
 * Never falls back, never guesses.
 */
function resolveEnvironment(ref) {
  const normalized = normalizeRef(ref);
  if (!normalized) {
    throw new EnvironmentAuthorityError('missing project ref identity', 'MISSING_IDENTITY');
  }
  if (!REF_SHAPE.test(normalized)) {
    throw new EnvironmentAuthorityError(`malformed project ref identity: ${normalized}`, 'MALFORMED_IDENTITY');
  }
  const env = REF_TO_ENVIRONMENT[normalized];
  if (!env) {
    throw new EnvironmentAuthorityError(`unknown project ref: ${normalized}`, 'UNKNOWN_PROJECT');
  }
  return env;
}

/** Throws unless `ref` resolves to a known environment. Returns the resolved environment name. */
function assertKnownProjectRef(ref) {
  return resolveEnvironment(ref);
}

/**
 * Throws unless `ref` resolves to exactly `expectedEnvironment`. This is the
 * primary entry point for release-control-plane code: it enforces exact
 * matching in both directions (staging-expected-but-production-supplied and
 * production-expected-but-staging-supplied both reject) with no fallback.
 */
function assertExpectedEnvironment(expectedEnvironment, ref) {
  if (expectedEnvironment !== 'staging' && expectedEnvironment !== 'production') {
    throw new EnvironmentAuthorityError(
      `unknown expected environment: ${String(expectedEnvironment)}`,
      'UNKNOWN_EXPECTED_ENVIRONMENT',
    );
  }
  const resolved = resolveEnvironment(ref);
  if (resolved !== expectedEnvironment) {
    throw new EnvironmentAuthorityError(
      `expected environment "${expectedEnvironment}" but resolved ref belongs to "${resolved}" - no fallback permitted`,
      'ENVIRONMENT_MISMATCH',
    );
  }
  return resolved;
}

/**
 * Throws if `ref` resolves to production. Unlike the legacy
 * verify-staging-parity.js version of this helper, a missing/malformed/
 * unknown ref also throws here (fail-closed) rather than passing through -
 * see the migration note below before swapping call sites.
 */
function assertNotProduction(ref, label) {
  const resolved = resolveEnvironment(ref);
  if (resolved === 'production') {
    throw new EnvironmentAuthorityError(
      `${label || 'operation'} resolves to the production project ref (${PRODUCTION_REF})`,
      'PRODUCTION_TARGET_DETECTED',
    );
  }
}

module.exports = {
  KNOWN_ENVIRONMENTS,
  STAGING_REF,
  PRODUCTION_REF,
  EnvironmentAuthorityError,
  resolveEnvironment,
  assertKnownProjectRef,
  assertExpectedEnvironment,
  assertNotProduction,
};

/*
 * Migration path for existing duplicate guards (not done in this change):
 *
 * - security/scripts/verify-staging-project-ref.js and
 *   security/scripts/verify-staging-parity.js each carry their own
 *   PRODUCTION_REF/DEFAULT_STAGING_REF constants and their own
 *   assertNotProduction, which tolerates a missing ref (`if (!ref) return`)
 *   because some of their call sites legitimately have not-yet-collected
 *   evidence at that point. Swapping them to this module's stricter
 *   assertNotProduction would change that behavior and needs a deliberate,
 *   reviewed pass per call site, not a mechanical find-replace.
 * - security/scripts/synthetic-staging-tests.js's assertNotProductionUrl
 *   compares URLs, not refs; it can be rebuilt on top of
 *   assertExpectedEnvironment('staging', extractedRef) once a shared
 *   ref-extraction helper exists, but that is a separate, focused change.
 * - __tests__/staging/stagingBackendContract.test.js decodes a JWT `ref`
 *   claim inline; it could call resolveEnvironment() on the decoded value
 *   instead of hand-rolling the staging/production string comparison.
 */
