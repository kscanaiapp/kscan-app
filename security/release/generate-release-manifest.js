#!/usr/bin/env node
'use strict';

/**
 * Deterministic backend release manifest generator + freeze.
 *
 * DETERMINISM CONTRACT:
 *
 *   The manifest separates IDENTITY MATERIAL from OBSERVATIONAL METADATA.
 *
 *     identity  - source SHA/tree, migration inventory, function inventory,
 *                 config fingerprint, health contract version. Hashed into
 *                 `identityDigest`. Two generations from identical governed
 *                 inputs MUST produce an identical identityDigest.
 *     metadata  - releaseId, createdAt, generator notes. Recorded, never
 *                 hashed, so a clock tick or a new release id can never
 *                 change the identity of the same governed source.
 *
 *   Freeze binds identityDigest. Any governed mutation - source SHA,
 *   migration set, function source, config structure - changes the digest
 *   and therefore invalidates a prior freeze.
 *
 * This module reads the repository and produces a record. It performs no
 * network calls, deploys nothing, and mutates no Supabase project.
 *
 * Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

const { canonicalize, sha256, computeConfigFingerprint } = require('./config-fingerprint');
const { assessMigration, loadRegistries, CLASSIFICATION_STATUS } = require('./classify-migration-risk');
const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard');
const { assertExpectedEnvironment } = require('../scripts/lib/environment-authority');

const MANIFEST_SCHEMA_VERSION = 1;
/**
 * Health contract version — release IDENTITY MATERIAL, folded into
 * identityDigest. Must stay in lockstep with HEALTH_CONTRACT_VERSION in
 * supabase/functions/staging-health/index.ts; the exact-candidate verifier
 * compares the live /version value against this and blocks on a mismatch.
 *
 * v1 (Phase 2B) supersedes the v0 placeholder and denotes the real contract:
 * /health/live, /health/ready and /version.
 */
const HEALTH_CONTRACT_VERSION = 'health-contract-v1';

class ReleaseManifestError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'ReleaseManifestError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Recursively hashes a directory's file contents into one stable digest. */
function hashDirectory(dir) {
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
  const parts = files.map((f) => `${path.relative(dir, f).split(path.sep).join('/')}:${sha256(fs.readFileSync(f, 'utf8'))}`);
  return sha256(parts.join('\n'));
}

/**
 * Builds the Edge Function inventory, classifying every repo directory and
 * every known live-only function. Throws if any surface lacks an explicit
 * classification - "silently ignore an unclassified function" is exactly the
 * failure mode this is built to prevent.
 */
function buildEdgeFunctionInventory({ repoRoot, governance, liveFunctionNames }) {
  const functionsRoot = path.join(repoRoot, 'supabase', 'functions');
  const sharedDigest = hashDirectory(path.join(repoRoot, governance.sharedDependencyPath));

  const repoDirs = fs.existsSync(functionsRoot)
    ? fs.readdirSync(functionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '_shared')
      .map((e) => e.name)
      .sort()
    : [];

  const unclassified = [];
  const entries = [];

  for (const name of repoDirs) {
    const decl = governance.functions[name];
    if (!decl) {
      unclassified.push({ name, where: 'repository' });
      continue;
    }
    entries.push({
      name,
      class: decl.class,
      sourcePath: decl.sourcePath,
      sourceHash: decl.sourcePath ? hashDirectory(path.join(repoRoot, decl.sourcePath)) : null,
      sharedDependencyHash: decl.class === 'GOVERNED' ? sharedDigest : null,
      verifyJwt: null, // filled from the config fingerprint structure by the caller
      releaseIncluded: decl.class === 'GOVERNED',
    });
  }

  for (const name of (liveFunctionNames || []).slice().sort()) {
    if (repoDirs.includes(name)) continue;
    const decl = governance.functions[name];
    if (!decl) {
      unclassified.push({ name, where: 'live-only' });
      continue;
    }
    if (entries.some((e) => e.name === name)) continue;
    entries.push({
      name,
      class: decl.class,
      sourcePath: decl.sourcePath,
      sourceHash: null,
      sharedDependencyHash: null,
      verifyJwt: null,
      releaseIncluded: false,
    });
  }

  if (unclassified.length > 0) {
    throw new ReleaseManifestError(
      `Edge Function surfaces lack an explicit governance classification: ${unclassified.map((u) => `${u.name} (${u.where})`).join(', ')}`,
      'UNCLASSIFIED_EDGE_FUNCTION',
      unclassified,
    );
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Builds the migration inventory, refusing any migration with no risk classification at all. */
function buildMigrationInventory({ repoRoot, registries }) {
  const dir = path.join(repoRoot, 'supabase', 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];

  const entries = [];
  const unclassifiedNew = [];

  for (const file of files) {
    const base = file.replace(/\.sql$/, '');
    const m = base.match(/^(\d+)_(.+)$/);
    const name = m ? m[2] : base;
    const version = m ? m[1] : null;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const assessment = assessMigration({ name, sql, registries });

    if (assessment.status === CLASSIFICATION_STATUS.UNCLASSIFIED_NEW) {
      unclassifiedNew.push(name);
    }

    entries.push({
      file: `supabase/migrations/${file}`,
      version,
      name,
      sourceHash: sha256(sql),
      classificationStatus: assessment.status,
      riskClassification: assessment.classification,
      detectorVerdict: assessment.detectorVerdict,
      detectorClassificationMismatch: assessment.detectorClassificationMismatch,
    });
  }

  if (unclassifiedNew.length > 0) {
    throw new ReleaseManifestError(
      `migrations added after the baseline have no risk classification: ${unclassifiedNew.join(', ')}. Add an entry to security/release/migration-risk-classifications.json.`,
      'UNCLASSIFIED_MIGRATION',
      unclassifiedNew,
    );
  }

  return entries;
}

/**
 * Generates a release manifest.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.releaseId          - observational; never hashed
 * @param {string} opts.sourceSha
 * @param {string} opts.sourceTreeSha
 * @param {'staging'|'production'} opts.candidateEnvironment
 * @param {string} opts.candidateProjectRef
 * @param {string} [opts.createdAt]        - observational; never hashed
 * @param {string[]} [opts.liveFunctionNames]
 * @param {object} [opts.env]              - presence-only, for the config fingerprint
 */
function generateReleaseManifest(opts) {
  const {
    repoRoot,
    releaseId,
    sourceSha,
    sourceTreeSha,
    candidateEnvironment,
    candidateProjectRef,
    createdAt,
    liveFunctionNames = [],
    env,
  } = opts || {};

  if (!releaseId) throw new ReleaseManifestError('releaseId is required', 'MISSING_RELEASE_ID');
  if (!sourceSha) throw new ReleaseManifestError('sourceSha is required', 'MISSING_SOURCE_SHA');
  if (!sourceTreeSha) throw new ReleaseManifestError('sourceTreeSha is required', 'MISSING_SOURCE_TREE_SHA');

  // Fail closed on environment identity before reading anything else.
  assertExpectedEnvironment(candidateEnvironment, candidateProjectRef);

  const governance = readJson(path.join(repoRoot, 'security', 'release', 'edge-function-governance.json'));
  const reconciliation = readJson(path.join(repoRoot, 'security', 'release', 'production-migration-reconciliation.json'));
  const backupPolicy = readJson(path.join(repoRoot, 'security', 'release', 'backup-capability-policy.json'));
  const registries = loadRegistries(repoRoot);

  const { structure: configStructure, digest: configFingerprint } = computeConfigFingerprint({
    repoRoot,
    env,
    healthContractVersion: HEALTH_CONTRACT_VERSION,
  });

  const edgeFunctions = buildEdgeFunctionInventory({ repoRoot, governance, liveFunctionNames })
    .map((fn) => ({ ...fn, verifyJwt: Object.prototype.hasOwnProperty.call(configStructure.verifyJwtPolicy, fn.name) ? configStructure.verifyJwtPolicy[fn.name] : null }));

  const migrations = buildMigrationInventory({ repoRoot, registries });

  const includedRiskClasses = [...new Set(
    migrations.filter((m) => m.riskClassification).map((m) => m.riskClassification),
  )].sort();

  // IDENTITY MATERIAL - hashed. Governed inputs only.
  const identity = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceSha,
    sourceTreeSha,
    candidateEnvironment,
    candidateProjectRef,
    healthContractVersion: HEALTH_CONTRACT_VERSION,
    configFingerprint,
    edgeFunctions: edgeFunctions.map((fn) => ({
      name: fn.name,
      class: fn.class,
      sourceHash: fn.sourceHash,
      sharedDependencyHash: fn.sharedDependencyHash,
      verifyJwt: fn.verifyJwt,
      releaseIncluded: fn.releaseIncluded,
    })),
    migrations: migrations.map((m) => ({
      name: m.name,
      version: m.version,
      sourceHash: m.sourceHash,
      riskClassification: m.riskClassification,
    })),
  };

  const identityDigest = sha256(canonicalize(identity));

  const manifest = {
    // observational metadata - deliberately excluded from identityDigest
    releaseId,
    createdAt: createdAt || new Date().toISOString(),
    generator: 'security/release/generate-release-manifest.js',

    // identity material
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    identityDigest,
    sourceSha,
    sourceTreeSha,
    candidateEnvironment,
    candidateProjectRef,
    healthContractVersion: HEALTH_CONTRACT_VERSION,
    configFingerprint,
    configStructure,
    edgeFunctions,
    migrations,

    // derived release state
    databaseSchemaState: {
      migrationCount: migrations.length,
      unclassifiedHistoricalCount: migrations.filter((m) => m.classificationStatus === CLASSIFICATION_STATUS.UNCLASSIFIED_HISTORICAL).length,
      detectorMismatchCount: migrations.filter((m) => m.detectorClassificationMismatch).length,
    },
    featureFlags: configStructure.featureFlagNames,
    riskClassification: {
      includedRiskClasses,
      backupCapability: backupPolicy.capability,
    },
    productionMigrationReconciliation: {
      status: reconciliation.overallStatus,
      unresolvedCount: reconciliation.records.filter((r) => r.promotionImpact !== 'NONE').length,
    },
    rollbackTargets: {
      // Phase 2A records the shape only. No rollback target is resolved here,
      // and no rollback mechanism exists for production (see discovery).
      edgeFunctions: 'NOT_RESOLVED_IN_PHASE_2A',
      migrations: 'NOT_RESOLVED_IN_PHASE_2A',
    },
    lastKnownGood: 'UNKNOWN',
    deploymentOrder: ['migrations', 'edgeFunctions', 'configuration'],
    status: 'DRAFT',
  };

  assertNoEmbeddedSecret(manifest, 'manifest');
  return manifest;
}

/**
 * Freezes a manifest by binding its identityDigest. A frozen record is what
 * later phases compare against; it deliberately carries no observational
 * metadata that could drift.
 */
function freezeManifest(manifest, { frozenAt, frozenBy } = {}) {
  if (!manifest || !manifest.identityDigest) {
    throw new ReleaseManifestError('cannot freeze a manifest with no identityDigest', 'MISSING_IDENTITY_DIGEST');
  }
  return Object.freeze({
    releaseId: manifest.releaseId,
    identityDigest: manifest.identityDigest,
    sourceSha: manifest.sourceSha,
    sourceTreeSha: manifest.sourceTreeSha,
    configFingerprint: manifest.configFingerprint,
    migrationCount: manifest.migrations.length,
    governedFunctionCount: manifest.edgeFunctions.filter((f) => f.releaseIncluded).length,
    frozenAt: frozenAt || new Date().toISOString(),
    frozenBy: frozenBy || null,
  });
}

/**
 * Verifies a frozen record still matches a freshly generated manifest.
 * @returns {{valid: boolean, reasons: string[]}}
 */
function verifyFreeze(frozen, currentManifest) {
  const reasons = [];
  if (!frozen || !currentManifest) return { valid: false, reasons: ['missing freeze or manifest'] };
  if (frozen.identityDigest !== currentManifest.identityDigest) reasons.push('IDENTITY_DIGEST_CHANGED');
  if (frozen.sourceSha !== currentManifest.sourceSha) reasons.push('SOURCE_SHA_CHANGED');
  if (frozen.sourceTreeSha !== currentManifest.sourceTreeSha) reasons.push('SOURCE_TREE_SHA_CHANGED');
  if (frozen.configFingerprint !== currentManifest.configFingerprint) reasons.push('CONFIG_FINGERPRINT_CHANGED');
  if (frozen.migrationCount !== currentManifest.migrations.length) reasons.push('MIGRATION_SET_CHANGED');
  return { valid: reasons.length === 0, reasons };
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  HEALTH_CONTRACT_VERSION,
  ReleaseManifestError,
  hashDirectory,
  buildEdgeFunctionInventory,
  buildMigrationInventory,
  generateReleaseManifest,
  freezeManifest,
  verifyFreeze,
};
