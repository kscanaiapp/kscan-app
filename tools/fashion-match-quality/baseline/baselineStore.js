'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { canonicalHash, stripVolatile } = require('../lib/canonicalJson');
const { assertPrivacySafe } = require('../schema/privacyGuard');

const SCHEMA_VERSION = 'fmql-baseline-schema-v1';

const REQUIRED_FIELDS = [
  'sourceSha',
  'fixtureManifestHash',
  'corpusTier',
  'rubricVersion',
  'schemaVersion',
  'capturePolicy',
  'evaluationMode',
  'generatedAt',
];

/**
 * Build an immutable baseline artifact (spec section 23). `perFixtureScore`
 * must be a fixtureId -> number map (typically a substitute-rollup score or
 * an identity indicator) used later by the comparison layer for paired
 * deltas.
 */
function createBaseline({
  sourceSha,
  fixtureManifest,
  rubricVersion,
  evaluationMode,
  metrics,
  perFixtureScore,
  capturePolicy = 'ios-current-v1+android-current-v1',
}) {
  const baseline = {
    schemaVersion: SCHEMA_VERSION,
    sourceSha,
    fixtureManifestHash: fixtureManifest.manifestHash,
    corpusTier: Object.keys(fixtureManifest.countByTier || {}).sort(),
    rubricVersion,
    capturePolicy,
    evaluationMode,
    generatedAt: new Date().toISOString(),
    metrics,
    perFixtureScore,
  };

  for (const field of REQUIRED_FIELDS) {
    if (baseline[field] === undefined || baseline[field] === null) {
      throw new Error(`BASELINE_MISSING_REQUIRED_FIELD: ${field}`);
    }
  }

  assertPrivacySafe(baseline, 'baseline');
  baseline.contentHash = canonicalHash(stripVolatile(baseline, ['generatedAt']));
  return baseline;
}

/**
 * Write a baseline to disk. Refuses to overwrite an existing, different
 * baseline unless `force` is explicitly true (spec section 23 - "Never
 * silently overwrite it. Explicit replacement command/flag required.").
 * Writing an identical baseline (same contentHash) over itself is always a
 * no-op success, not an error.
 */
function writeBaseline(filePath, baseline, { force = false } = {}) {
  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (existing.contentHash === baseline.contentHash) {
      return { written: false, reason: 'identical_baseline_already_present' };
    }
    if (!force) {
      throw new Error(
        `BASELINE_OVERWRITE_REFUSED: ${filePath} already contains a different baseline (existing contentHash=${existing.contentHash}, new=${baseline.contentHash}). Pass { force: true } to explicitly replace it.`,
      );
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return { written: true };
}

function readBaseline(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`BASELINE_NOT_FOUND: ${filePath}`);
  }
  const baseline = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  for (const field of REQUIRED_FIELDS) {
    if (baseline[field] === undefined || baseline[field] === null) {
      throw new Error(`BASELINE_MALFORMED: missing required field ${field} in ${filePath}`);
    }
  }
  return baseline;
}

/**
 * Compatibility gate for comparisons (spec section 23): reject mixing
 * fixture manifest, corpus tier set, rubric version, or schema version.
 * Returns { compatible, reasons }.
 */
function assertBaselinesComparable(baselineA, baselineB) {
  const reasons = [];
  if (baselineA.fixtureManifestHash !== baselineB.fixtureManifestHash) {
    reasons.push('fixture_manifest_hash_mismatch');
  }
  if (baselineA.rubricVersion !== baselineB.rubricVersion) {
    reasons.push('rubric_version_mismatch');
  }
  if (baselineA.schemaVersion !== baselineB.schemaVersion) {
    reasons.push('schema_version_mismatch');
  }
  const tierA = JSON.stringify([...baselineA.corpusTier].sort());
  const tierB = JSON.stringify([...baselineB.corpusTier].sort());
  if (tierA !== tierB) {
    reasons.push('corpus_tier_mismatch');
  }
  if (reasons.length > 0) {
    throw new Error(`BASELINE_COMPARISON_REJECTED: ${reasons.join(', ')}`);
  }
  return { compatible: true, reasons: [] };
}

module.exports = {
  SCHEMA_VERSION,
  REQUIRED_FIELDS,
  createBaseline,
  writeBaseline,
  readBaseline,
  assertBaselinesComparable,
};
