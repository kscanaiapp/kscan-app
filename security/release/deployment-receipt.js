#!/usr/bin/env node
'use strict';

/**
 * Deployment receipt — immutable run evidence for one staging deployment
 * attempt.
 *
 * A receipt records what was actually deployed, bound to the frozen candidate
 * it came from. It is RUN EVIDENCE, not source: per the Phase 2A evidence
 * policy it belongs in CI artifacts, never committed per-run into Git.
 *
 * IMMUTABILITY: `finalizeReceipt` returns a deep-frozen object carrying a
 * `receiptDigest` over its own content. A retry produces a NEW receipt with an
 * incremented `deploymentAttempt` and its own digest — a finalized receipt is
 * never edited in place, because silently mutating prior evidence is how a
 * failed attempt disappears from the record.
 *
 * Node built-ins only. Nothing here deploys anything.
 */

const crypto = require('node:crypto');

const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard.js');
const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority.js');

const RECEIPT_SCHEMA_VERSION = 1;

const RECEIPT_STATUS = Object.freeze({
  PASS: 'PASS',
  BLOCKED: 'BLOCKED',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
});

const REQUIRED_FIELDS = Object.freeze([
  'schemaVersion',
  'releaseId',
  'candidateSha',
  'candidateTreeSha',
  'manifestDigest',
  'environment',
  'projectRef',
  'deploymentRunId',
  'deploymentAttempt',
  'startedAt',
  'deploymentDelta',
  'healthContractVersion',
  'preDeployVerification',
  'status',
]);

class DeploymentReceiptError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'DeploymentReceiptError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Stable stringify so a receipt digest cannot change with key ordering. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Creates an open (not yet finalized) receipt from a candidate binding.
 * `deploymentAttempt` starts at 1; a retry must pass an incremented value.
 */
function createReceipt({
  binding,
  deploymentRunId,
  deploymentAttempt = 1,
  startedAt,
  preDeployVerification,
}) {
  if (!binding) throw new DeploymentReceiptError('a candidate binding is required', 'MISSING_BINDING');
  if (!deploymentRunId) throw new DeploymentReceiptError('deploymentRunId is required', 'MISSING_RUN_ID');
  if (!Number.isInteger(deploymentAttempt) || deploymentAttempt < 1) {
    throw new DeploymentReceiptError('deploymentAttempt must be a positive integer', 'INVALID_ATTEMPT');
  }

  // Fail closed on environment before any evidence is minted.
  assertExpectedEnvironment(binding.environment, binding.projectRef);

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    releaseId: binding.releaseId,
    candidateSha: binding.candidateSha,
    candidateTreeSha: binding.candidateTreeSha,
    manifestDigest: binding.manifestDigest,
    environment: binding.environment,
    projectRef: binding.projectRef,
    deploymentRunId,
    deploymentAttempt,
    startedAt: startedAt || new Date().toISOString(),
    completedAt: null,
    deploymentDelta: binding.deploymentDelta,
    migrationsApplied: [],
    functionsDeployed: [],
    functionSourceHashes: binding.candidateSourceHashes || {},
    healthContractVersion: binding.healthContractVersion,
    configFingerprint: binding.configFingerprint,
    preDeployVerification: preDeployVerification || { status: 'PENDING' },
    deployResults: [],
    postDeployIdentity: null,
    status: 'PENDING',
  };
}

/**
 * Finalizes a receipt: validates it, stamps a content digest, and deep-freezes
 * it. Any later change must produce a new attempt rather than an edit.
 */
function finalizeReceipt(receipt, { completedAt, status, migrationsApplied, functionsDeployed, deployResults, postDeployIdentity } = {}) {
  const finalized = {
    ...receipt,
    completedAt: completedAt || new Date().toISOString(),
    status: status || receipt.status,
    migrationsApplied: migrationsApplied || receipt.migrationsApplied || [],
    functionsDeployed: functionsDeployed || receipt.functionsDeployed || [],
    deployResults: deployResults || receipt.deployResults || [],
    postDeployIdentity: postDeployIdentity !== undefined ? postDeployIdentity : receipt.postDeployIdentity,
  };

  const { valid, errors } = validateReceipt(finalized);
  if (!valid) {
    throw new DeploymentReceiptError(
      `refusing to finalize an invalid deployment receipt: ${errors.join('; ')}`,
      'INVALID_RECEIPT',
      errors,
    );
  }

  finalized.receiptDigest = crypto.createHash('sha256').update(canonicalize(finalized), 'utf8').digest('hex');
  return deepFreeze(finalized);
}

/** Produces the next attempt for a retry. Never edits the prior receipt. */
function nextAttempt(previousReceipt, { binding, deploymentRunId, startedAt, preDeployVerification }) {
  if (!previousReceipt) throw new DeploymentReceiptError('a previous receipt is required', 'MISSING_PREVIOUS_RECEIPT');
  return createReceipt({
    binding: binding || {
      releaseId: previousReceipt.releaseId,
      candidateSha: previousReceipt.candidateSha,
      candidateTreeSha: previousReceipt.candidateTreeSha,
      manifestDigest: previousReceipt.manifestDigest,
      environment: previousReceipt.environment,
      projectRef: previousReceipt.projectRef,
      deploymentDelta: previousReceipt.deploymentDelta,
      candidateSourceHashes: previousReceipt.functionSourceHashes,
      healthContractVersion: previousReceipt.healthContractVersion,
      configFingerprint: previousReceipt.configFingerprint,
    },
    deploymentRunId: deploymentRunId || previousReceipt.deploymentRunId,
    deploymentAttempt: previousReceipt.deploymentAttempt + 1,
    startedAt,
    preDeployVerification,
  });
}

/** @returns {{valid: boolean, errors: string[]}} */
function validateReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object') return { valid: false, errors: ['receipt must be an object'] };

  for (const field of REQUIRED_FIELDS) {
    const value = receipt[field];
    if (value === undefined || value === null || value === '') {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${receipt.schemaVersion}`);
  }

  if (receipt.environment && receipt.projectRef) {
    try {
      assertExpectedEnvironment(receipt.environment, receipt.projectRef);
    } catch (error) {
      errors.push(`environment/projectRef mismatch: ${error.code}`);
    }
  }

  if (receipt.status && !Object.values(RECEIPT_STATUS).includes(receipt.status) && receipt.status !== 'PENDING') {
    errors.push(`unknown status: ${receipt.status}`);
  }

  if (receipt.deploymentDelta && typeof receipt.deploymentDelta !== 'object') {
    errors.push('deploymentDelta must be an object');
  }

  try {
    assertNoEmbeddedSecret(receipt, 'deploymentReceipt');
  } catch (error) {
    errors.push(error.message);
  }

  return { valid: errors.length === 0, errors };
}

/** Recomputes and compares a finalized receipt's digest. */
function verifyReceiptIntegrity(receipt) {
  if (!receipt || !receipt.receiptDigest) {
    return { valid: false, reason: 'receipt is not finalized (no receiptDigest)' };
  }
  const { receiptDigest, ...content } = receipt;
  const recomputed = crypto.createHash('sha256').update(canonicalize(content), 'utf8').digest('hex');
  return recomputed === receiptDigest
    ? { valid: true, reason: null }
    : { valid: false, reason: 'receiptDigest does not match receipt content — evidence was modified after finalization' };
}

module.exports = {
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_STATUS,
  REQUIRED_FIELDS,
  DeploymentReceiptError,
  canonicalize,
  createReceipt,
  finalizeReceipt,
  nextAttempt,
  validateReceipt,
  verifyReceiptIntegrity,
};
