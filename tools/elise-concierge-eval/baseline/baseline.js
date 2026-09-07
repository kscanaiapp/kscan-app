'use strict';

/**
 * BASELINE — spec section 53.
 *
 * An immutable record of every version/hash that defines "this instrument,
 * exactly as it stood when this baseline was cut". No silent overwrite:
 * writeBaseline refuses to replace an existing baseline file unless the
 * caller passes { allowOverwrite: true } (used only for corpus-hash
 * determinism verification, spec section 52, which writes-then-rewrites the
 * IDENTICAL content twice on purpose). Comparing against an incompatible
 * baseline (different HARNESS_VERSION major, different DEFECT_TAXONOMY
 * version, etc.) fails loudly rather than silently reporting drift as zero.
 */

const fs = require('node:fs');
const path = require('node:path');
const { canonicalStringify, stableHashExcluding, nowIso } = require('../model/canonicalJson');

const HARNESS_VERSION = '1.0.0';

const BASELINE_PATH = path.join(__dirname, 'baseline.json');

function buildBaseline(input) {
  const record = {
    baselineVersion: 'BASELINE_V1',
    baseSha: input.baseSha,
    harnessVersion: HARNESS_VERSION,
    corpusVersion: input.corpusVersion,
    corpusHash: input.corpusHash,
    synthesizerVersion: input.synthesizerVersion,
    extractionRulesVersion: input.extractionRulesVersion,
    defectTaxonomyVersion: input.defectTaxonomyVersion,
    precedenceContractVersion: input.precedenceContractVersion,
    safetyPolicyMapVersion: input.safetyPolicyMapVersion,
    safetyPolicyMapHash: input.safetyPolicyMapHash,
    coverageMatrixHash: input.coverageMatrixHash,
    rubricVersion: input.rubricVersion,
    generatedAt: nowIso(),
  };
  const hash = stableHashExcluding(record, ['generatedAt']);
  return { ...record, baselineContentHash: hash };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * @param {object} baselineRecord
 * @param {object} [opts]
 * @param {boolean} [opts.allowOverwrite=false]
 */
function writeBaseline(baselineRecord, opts = {}) {
  const existing = readBaseline();
  if (existing && !opts.allowOverwrite) {
    throw new Error(
      `Refusing to overwrite existing baseline at ${BASELINE_PATH} (baselineContentHash=${existing.baselineContentHash}). ` +
        'Baselines are immutable by design (spec section 53) -- pass { allowOverwrite: true } only for an intentional, reviewed re-cut.',
    );
  }
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baselineRecord, null, 2)}\n`, 'utf8');
  return baselineRecord;
}

const VERSION_FIELDS = [
  'harnessVersion',
  'corpusVersion',
  'synthesizerVersion',
  'extractionRulesVersion',
  'defectTaxonomyVersion',
  'precedenceContractVersion',
  'safetyPolicyMapVersion',
  'rubricVersion',
];

/**
 * Compare a candidate baseline-shaped record against a reference baseline.
 * Throws (fails loudly) if any VERSION_FIELDS differ, since comparing
 * results across incompatible instrument versions is meaningless. Returns a
 * diff report when versions match but hashes differ (real drift within the
 * same version -- reportable, not fatal).
 */
function compareBaselines(candidate, reference) {
  if (!reference) throw new Error('compareBaselines: no reference baseline to compare against');
  if (!candidate) throw new Error('compareBaselines: no candidate baseline to compare');

  const incompatible = VERSION_FIELDS.filter((f) => candidate[f] !== reference[f]);
  if (incompatible.length) {
    throw new Error(
      `INCOMPATIBLE_COMPARISON: version fields differ and cannot be compared: ${incompatible
        .map((f) => `${f} (candidate=${candidate[f]}, reference=${reference[f]})`)
        .join(', ')}`,
    );
  }

  const drifted = ['baseSha', 'corpusHash', 'safetyPolicyMapHash', 'coverageMatrixHash'].filter(
    (f) => candidate[f] !== reference[f],
  );

  return { compatible: true, drifted, identical: drifted.length === 0 };
}

module.exports = {
  HARNESS_VERSION,
  BASELINE_PATH,
  buildBaseline,
  readBaseline,
  writeBaseline,
  compareBaselines,
  VERSION_FIELDS,
};
