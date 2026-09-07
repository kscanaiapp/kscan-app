'use strict';

/**
 * Cuts (or verifies) the immutable baseline record from a freshly generated
 * report. Separate from baseline.js's low-level read/write/compare so the
 * "what goes into a baseline" policy lives in one obvious place.
 */

const { generateReport } = require('../reports/generateReport');
const { buildBaseline, writeBaseline, readBaseline } = require('./baseline');
const { sha256Hex, canonicalStringify } = require('../model/canonicalJson');

async function createBaselineFromReport(opts = {}) {
  const report = await generateReport({ skipL15: true }); // baseline hashes must not depend on Node-version-sensitive L1.5 availability
  const record = buildBaseline({
    baseSha: opts.baseSha || 'a9fb82e9020fce268b9840b39cb7fc9a92e5747e',
    corpusVersion: report.versions.corpusVersion,
    corpusHash: report.corpus.corpusHash,
    synthesizerVersion: report.versions.synthesizerVersion,
    extractionRulesVersion: report.versions.extractionRulesVersion,
    defectTaxonomyVersion: report.versions.defectTaxonomyVersion,
    precedenceContractVersion: report.versions.precedenceContractVersion,
    safetyPolicyMapVersion: 'SAFETY_POLICY_MAP_V1',
    safetyPolicyMapHash: sha256Hex(canonicalStringify(require('../authority/safetyPolicyMap.json'))),
    coverageMatrixHash: report.coverageMatrix.hash,
    rubricVersion: report.versions.rubricVersion,
  });
  return writeBaseline(record, { allowOverwrite: opts.allowOverwrite === true });
}

function ensureBaselineExists() {
  const existing = readBaseline();
  if (existing) return { created: false, baseline: existing };
  return null;
}

module.exports = { createBaselineFromReport, ensureBaselineExists };
