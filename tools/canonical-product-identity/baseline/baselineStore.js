'use strict';

/**
 * Immutable baseline (spec section 39). Required fields: SOURCE SHA, CORPUS
 * HASH, CORPUS TIER, GENERATOR VERSION, RESOLVER VERSION, NORMALIZATION
 * VERSION, SCHEMA VERSION, OPERATING PARAMETERS. No silent overwrite -
 * writeBaseline refuses to replace a DIFFERENT existing baseline unless
 * `force` is explicit, mirroring tools/fashion-match-quality/baseline/
 * baselineStore.js's convention.
 */

const fs = require('node:fs');
const path = require('node:path');

const { canonicalHash, stripVolatile } = require('../../fashion-match-quality/lib/canonicalJson');
const { assertPrivacySafe } = require('../../fashion-match-quality/schema/privacyGuard');

const BASELINE_SCHEMA_VERSION = 'cpil-baseline-schema-v1';

const REQUIRED_FIELDS = [
  'sourceSha',
  'corpusHash',
  'corpusTier',
  'generatorVersion',
  'resolverVersion',
  'normalizationVersion',
  'identitySchemaVersion',
  'baselineSchemaVersion',
  'operatingParameters',
  'generatedAt',
];

function createBaseline({
  sourceSha,
  corpus,
  corpusManifest,
  resolverVersion,
  normalizationVersion,
  identitySchemaVersion,
  operatingParameters,
  metrics,
}) {
  const baseline = {
    baselineSchemaVersion: BASELINE_SCHEMA_VERSION,
    sourceSha,
    corpusHash: corpusManifest.manifestHash,
    corpusTier: corpus.corpusTier,
    corpusId: corpus.corpusId,
    generatorVersion: corpus.generatorVersion,
    resolverVersion,
    normalizationVersion,
    identitySchemaVersion,
    operatingParameters,
    generatedAt: new Date().toISOString(),
    metrics,
  };

  for (const field of REQUIRED_FIELDS) {
    if (baseline[field] === undefined || baseline[field] === null) {
      throw new Error(`BASELINE_MISSING_REQUIRED_FIELD: ${field}`);
    }
  }

  assertPrivacySafe(baseline, 'canonical-product-identity baseline');
  baseline.contentHash = canonicalHash(stripVolatile(baseline, ['generatedAt']));
  return baseline;
}

/** Refuses to overwrite a different existing baseline unless force:true. Writing an identical baseline is always a no-op success. */
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
 * Compatibility gate (Addendum A.5 test #31): reject comparing against an
 * incompatible baseline (different resolver/generator/normalization/schema
 * version, or a different corpus entirely).
 */
function assertBaselinesComparable(baselineA, baselineB) {
  const reasons = [];
  if (baselineA.corpusHash !== baselineB.corpusHash) reasons.push('corpus_hash_mismatch');
  // Explicit, named check (Addendum A.5 test #30 "comparison across corpus
  // tiers fails") - not merely relying on corpusHash differing, since the
  // tier distinction (SYNTHETIC vs APPROVED_REAL) is the specific thing a
  // reader needs surfaced, not just "some hash didn't match".
  if (baselineA.corpusTier !== baselineB.corpusTier) reasons.push('corpus_tier_mismatch');
  if (baselineA.resolverVersion !== baselineB.resolverVersion) reasons.push('resolver_version_mismatch');
  if (baselineA.generatorVersion !== baselineB.generatorVersion) reasons.push('generator_version_mismatch');
  if (baselineA.normalizationVersion !== baselineB.normalizationVersion) reasons.push('normalization_version_mismatch');
  if (baselineA.identitySchemaVersion !== baselineB.identitySchemaVersion) reasons.push('identity_schema_version_mismatch');
  if (baselineA.baselineSchemaVersion !== baselineB.baselineSchemaVersion) reasons.push('baseline_schema_version_mismatch');
  if (reasons.length > 0) {
    throw new Error(`BASELINE_COMPARISON_REJECTED: ${reasons.join(', ')}`);
  }
  return { compatible: true, reasons: [] };
}

module.exports = {
  BASELINE_SCHEMA_VERSION,
  REQUIRED_FIELDS,
  createBaseline,
  writeBaseline,
  readBaseline,
  assertBaselinesComparable,
};
