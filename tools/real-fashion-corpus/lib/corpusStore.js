'use strict';

/**
 * Corpus persistence and the corpus manifest hash (mission sections 24, 37).
 *
 * The DEFAULT load returns the development partition ONLY. There is no code
 * path here in which an ordinary load returns a holdout case - reading the
 * holdout goes through lib/holdout.js and nowhere else (design DM-03).
 */

const fs = require('node:fs');
const path = require('node:path');

const { PATHS } = require('./paths');
const { validateGarment, validateCase } = require('./recordSchema');
const { deriveGrade, evaluateIdentityEligibility } = require('./groundTruth');
const { canonicalHash } = require('../../fashion-match-quality/lib/canonicalJson');
const { ASSET_TIER_REAL } = require('./constants');

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        return { file, record: null, parseError: err.message };
      }
    });
}

function loadCorpusConfig() {
  return JSON.parse(fs.readFileSync(PATHS.corpusConfig, 'utf8'));
}

function loadGarments() {
  return readJsonDir(PATHS.garments);
}

/** Development-partition cases. This is the default, and it is the only default. */
function loadDevelopmentCases() {
  return readJsonDir(PATHS.cases);
}

/**
 * Load the corpus for ordinary use.
 *
 * Returns { config, garments, cases, garmentsById, errors, holdoutCaseCount }.
 * `holdoutCaseCount` is a COUNT, never the records - reporting how large the
 * holdout is leaks nothing, while returning its contents would defeat the seal.
 */
function loadCorpus({ validate = true } = {}) {
  const config = loadCorpusConfig();
  const errors = [];

  const garments = [];
  for (const { file, record, parseError } of loadGarments()) {
    if (parseError) {
      errors.push({ file, message: `unreadable JSON: ${parseError}` });
      continue;
    }
    if (validate) {
      const result = validateGarment(record);
      if (!result.valid) {
        for (const message of result.errors) errors.push({ file, garmentId: record.garmentId, message });
        continue;
      }
    }
    garments.push(record);
  }

  const cases = [];
  for (const { file, record, parseError } of loadDevelopmentCases()) {
    if (parseError) {
      errors.push({ file, message: `unreadable JSON: ${parseError}` });
      continue;
    }
    if (validate) {
      const result = validateCase(record);
      if (!result.valid) {
        for (const message of result.errors) errors.push({ file, caseId: record.caseId, message });
        continue;
      }
    }
    cases.push(record);
  }

  const garmentsById = new Map(garments.map((garment) => [garment.garmentId, garment]));

  // Referential integrity: a case must name a garment that exists.
  for (const record of cases) {
    if (!garmentsById.has(record.garmentId)) {
      errors.push({
        caseId: record.caseId,
        message: `case ${record.caseId} references garment ${record.garmentId}, which is not in the corpus`,
      });
    }
  }

  const holdoutCaseCount = fs.existsSync(PATHS.holdout)
    ? fs.readdirSync(PATHS.holdout).filter((name) => name.endsWith('.json')).length
    : 0;

  return { config, garments, cases, garmentsById, errors, holdoutCaseCount };
}

/**
 * Corpus hash (mission section 37). Covers garment and case records plus the
 * corpus version and policy versions, so an evaluation artifact bound to this
 * hash cannot silently be compared against a corpus that has moved.
 *
 * Holdout case records are included by their ID and content hash ONLY - the
 * hash must change when the holdout changes (otherwise two different corpora
 * would claim the same identity) without the manifest itself becoming a way
 * to read holdout content.
 */
function buildCorpusManifest({ config, garments, cases }) {
  const holdoutEntries = fs.existsSync(PATHS.holdout)
    ? fs
        .readdirSync(PATHS.holdout)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => {
          const record = JSON.parse(fs.readFileSync(path.join(PATHS.holdout, name), 'utf8'));
          return { caseId: record.caseId, contentHash: canonicalHash(record) };
        })
    : [];

  const garmentEntries = garments
    .map((garment) => {
      const eligibility = evaluateIdentityEligibility(garment);
      return {
        garmentId: garment.garmentId,
        category: garment.category,
        derivedGrade: deriveGrade(garment.groundTruth).grade,
        identityEligible: eligibility.eligible,
        contentHash: canonicalHash(garment),
      };
    })
    .sort((a, b) => a.garmentId.localeCompare(b.garmentId));

  const caseEntries = cases
    .map((record) => ({
      caseId: record.caseId,
      garmentId: record.garmentId,
      assetTier: record.assetTier,
      captureProfile: record.capture?.captureProfile,
      partition: record.partition,
      assetSha256: record.asset?.sha256,
      contentHash: canonicalHash(record),
    }))
    .sort((a, b) => a.caseId.localeCompare(b.caseId));

  const manifest = {
    corpusId: config.corpusId,
    corpusVersion: config.corpusVersion,
    policyVersions: config.policyVersions,
    garmentCount: garmentEntries.length,
    developmentCaseCount: caseEntries.length,
    holdoutCaseCount: holdoutEntries.length,
    garments: garmentEntries,
    cases: caseEntries,
    holdout: holdoutEntries,
  };

  return { ...manifest, corpusHash: canonicalHash(manifest) };
}

function writeRecord(dir, filename, record) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}

function writeGarment(garment) {
  return writeRecord(PATHS.garments, `${garment.garmentId}.json`, garment);
}

function writeCase(record) {
  const dir = record.partition === 'holdout' ? PATHS.holdout : PATHS.cases;
  return writeRecord(dir, `${record.caseId}.json`, record);
}

/**
 * Real cases only, with pipeline-test assets excluded.
 *
 * Callers computing corpus N must use this. A PIPELINE_TEST_ASSET may never
 * count toward the corpus (mission section 26) - but the ordinary loader still
 * returns it so a validator can SEE that one made it into a real corpus
 * directory and reject it, rather than silently filtering the evidence away.
 */
function realCasesOnly(cases) {
  return cases.filter((record) => record.assetTier === ASSET_TIER_REAL);
}

module.exports = {
  loadCorpusConfig,
  loadCorpus,
  loadGarments,
  loadDevelopmentCases,
  buildCorpusManifest,
  writeGarment,
  writeCase,
  writeRecord,
  realCasesOnly,
  readJsonDir,
};
