#!/usr/bin/env node
'use strict';

/**
 * Last Known Good (LKG) schema and validation.
 *
 * Phase 2A implements the SCHEMA and the RULES. It deliberately declares no
 * actual LKG: the current state is UNKNOWN, and Phase 1 discovery found no
 * artifact anywhere that bundles source SHA + migration state + function
 * versions + config fingerprint + passing verification evidence together for
 * either environment.
 *
 * Two rules exist specifically to prevent fabricating one:
 *
 *   1. An LKG record must be COMPLETE. Every required field must be present
 *      and non-empty. A partial record is rejected, not stored with gaps.
 *   2. An LKG may only be created from a release that reached
 *      PRODUCTION_VERIFIED, with verification evidence attached. "The
 *      previous commit" is never an LKG - there is no code path here that
 *      accepts a bare commit SHA as a known-good release.
 *
 * Node built-ins only.
 */

const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard');
const { assertKnownProjectRef } = require('../scripts/lib/environment-authority');

const LKG_SCHEMA_VERSION = 1;

const REQUIRED_FIELDS = Object.freeze([
  'releaseId',
  'sourceSha',
  'sourceTreeSha',
  'migrationState',
  'edgeFunctionManifestDigest',
  'configFingerprint',
  'featureFlagState',
  'deploymentTimestamp',
  'verificationEvidence',
  'verificationTimestamp',
  'environment',
]);

/** The only release state from which an LKG may be minted. */
const REQUIRED_RELEASE_STATE = 'PRODUCTION_VERIFIED';

/** Current, honest state. Phase 2A does not change this. */
const CURRENT_LAST_KNOWN_GOOD = Object.freeze({
  status: 'UNKNOWN',
  environment: 'production',
  rationale:
    'No artifact bundles source SHA + migration state + Edge Function digest + config fingerprint + passing verification evidence together. The closest candidate (docs/staging/staging-operational-baseline.md) is staging-only and its own certification verdict is BLOCKED. Production has no deployment attribution mechanism at all, so there is nothing to mint an LKG from.',
  determinedOn: '2026-08-11',
});

class LastKnownGoodError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'LastKnownGoodError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

function isNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Validates a candidate LKG record.
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateLastKnownGood(record) {
  const errors = [];

  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['record must be an object'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!isNonEmpty(record[field])) errors.push(`missing or empty required field: ${field}`);
  }

  if (record.environment && !['staging', 'production'].includes(record.environment)) {
    errors.push(`unknown environment: ${record.environment}`);
  }
  if (record.projectRef) {
    try {
      assertKnownProjectRef(record.projectRef);
    } catch (err) {
      errors.push(`projectRef rejected: ${err.code}`);
    }
  }

  // Verification evidence must actually assert a pass, not merely exist.
  const evidence = record.verificationEvidence;
  if (isNonEmpty(evidence)) {
    if (typeof evidence !== 'object' || Array.isArray(evidence)) {
      errors.push('verificationEvidence must be an object describing what verified the release');
    } else {
      if (evidence.verdict !== 'PASS') {
        errors.push(`verificationEvidence.verdict must be PASS, got ${JSON.stringify(evidence.verdict)}`);
      }
      if (!isNonEmpty(evidence.source)) {
        errors.push('verificationEvidence.source is required (what produced this evidence)');
      }
    }
  }

  try {
    assertNoEmbeddedSecret(record, 'lastKnownGood');
  } catch (err) {
    errors.push(err.message);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Mints an LKG record from a release. Refuses unless the release reached
 * PRODUCTION_VERIFIED and the resulting record is complete.
 */
function createLastKnownGood({ release, releaseState, verificationEvidence, verificationTimestamp, deploymentTimestamp }) {
  if (releaseState !== REQUIRED_RELEASE_STATE) {
    throw new LastKnownGoodError(
      `a release may only become Last Known Good from ${REQUIRED_RELEASE_STATE}, not ${String(releaseState)}`,
      'RELEASE_NOT_PRODUCTION_VERIFIED',
    );
  }
  if (!release || typeof release !== 'object') {
    throw new LastKnownGoodError('release manifest is required', 'MISSING_RELEASE');
  }

  const candidate = {
    schemaVersion: LKG_SCHEMA_VERSION,
    releaseId: release.releaseId,
    sourceSha: release.sourceSha,
    sourceTreeSha: release.sourceTreeSha,
    migrationState: release.migrations
      ? { count: release.migrations.length, names: release.migrations.map((m) => m.name) }
      : null,
    edgeFunctionManifestDigest: release.identityDigest,
    configFingerprint: release.configFingerprint,
    featureFlagState: release.featureFlags,
    deploymentTimestamp: deploymentTimestamp || null,
    verificationEvidence: verificationEvidence || null,
    verificationTimestamp: verificationTimestamp || null,
    environment: release.candidateEnvironment,
    projectRef: release.candidateProjectRef,
  };

  const { valid, errors } = validateLastKnownGood(candidate);
  if (!valid) {
    throw new LastKnownGoodError(
      `refusing to create an incomplete Last Known Good record: ${errors.join('; ')}`,
      'INCOMPLETE_LKG',
      errors,
    );
  }

  return Object.freeze(candidate);
}

module.exports = {
  LKG_SCHEMA_VERSION,
  REQUIRED_FIELDS,
  REQUIRED_RELEASE_STATE,
  CURRENT_LAST_KNOWN_GOOD,
  LastKnownGoodError,
  validateLastKnownGood,
  createLastKnownGood,
};
