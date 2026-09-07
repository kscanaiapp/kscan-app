'use strict';

/**
 * Validates the structural shape of every fixture data file under
 * __tests__/fixtures/commerce/ (spec section 42: "valid file references",
 * "required fields by scenario type", "no duplicate IDs"). This checks the
 * fixture FILES themselves, independent of whether the manifest actually
 * references every record in them - validateManifest.js checks the manifest
 * side; this checks the fixture side. Between the two, every record is
 * proven both well-formed and reachable.
 */

const fs = require('node:fs');
const { listFixtureFiles } = require('./loadCorpus');

const REQUIRED_RECORD_FIELDS = ['scenarioId', 'description', 'evidenceClass', 'tags', 'input', 'expected'];
// The mutation-negative-control category's records additionally require these.
const REQUIRED_MUTATION_FIELDS = ['mutationOf', 'mutatedField', 'originalValue', 'mutatedValue'];

function validateFixtureFiles() {
  const errors = [];
  const allScenarioIds = new Map(); // scenarioId -> file (to catch cross-file duplicates too)

  for (const file of listFixtureFiles()) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push(`${file}: not valid JSON (${err.message})`);
      continue;
    }

    if (parsed.commerceCorpusFixtureVersion !== 1) {
      errors.push(`${file}: missing or unrecognized commerceCorpusFixtureVersion`);
    }
    if (typeof parsed.category !== 'string') {
      errors.push(`${file}: missing 'category'`);
    }
    if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
      errors.push(`${file}: 'records' must be a non-empty array`);
      continue;
    }

    const localIds = new Set();
    for (const record of parsed.records) {
      const label = record.scenarioId || '<missing scenarioId>';

      const isMutation = parsed.category === 'mutation-negative-control';
      const requiredFields = isMutation
        ? ['scenarioId', 'mutationOf', 'tags', ...REQUIRED_MUTATION_FIELDS, 'expected']
        : REQUIRED_RECORD_FIELDS;

      for (const field of requiredFields) {
        if (record[field] === undefined) {
          errors.push(`${file}#${label}: missing required field '${field}'`);
        }
      }

      if (!isMutation && record.evidenceClass === 'OBSERVED-SHAPE') {
        errors.push(`${file}#${label}: claims OBSERVED-SHAPE, which is forbidden in this lane (no Staging access)`);
      }

      if (localIds.has(record.scenarioId)) {
        errors.push(`${file}: duplicate scenarioId within file: '${record.scenarioId}'`);
      }
      localIds.add(record.scenarioId);

      if (allScenarioIds.has(record.scenarioId) && allScenarioIds.get(record.scenarioId) !== file) {
        errors.push(
          `duplicate scenarioId across files: '${record.scenarioId}' in both ${allScenarioIds.get(record.scenarioId)} and ${file}`,
        );
      }
      allScenarioIds.set(record.scenarioId, file);
    }
  }

  return { valid: errors.length === 0, errors, totalRecords: allScenarioIds.size };
}

module.exports = { validateFixtureFiles };
