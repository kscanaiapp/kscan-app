#!/usr/bin/env node
'use strict';

/**
 * Commerce Corpus validator (spec section 42).
 *
 * Independent validator: does not import buildCoverageReport.js or trust
 * any prior "PASS" claim. Re-derives every check from the manifest schema,
 * the fixture files on disk, and the reused privacy guard - the same
 * independence pattern as tools/fashion-match-quality/validateReport.js.
 *
 * Usage: node tools/commerce-corpus/validateCorpus.js
 * Exit code 0 = valid corpus, non-zero = invalid.
 */

const fs = require('node:fs');

const { validateManifest } = require('./lib/validateManifest');
const { validateFixtureFiles } = require('./lib/validateFixtureFiles');
const { scanCorpusPrivacy } = require('./lib/scanCorpusPrivacy');
const { loadCorpus, listFixtureFiles } = require('./lib/loadCorpus');

function checkNoOrphanedRecords() {
  const errors = [];
  const { manifest } = loadCorpus();
  const referencedIds = new Set(manifest.scenarios.map((s) => s.scenarioId));

  for (const file of listFixtureFiles()) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of parsed.records || []) {
      if (!referencedIds.has(record.scenarioId)) {
        errors.push(`${file}#${record.scenarioId}: fixture record exists but no manifest scenario references it (orphaned)`);
      }
    }
  }
  return errors;
}

function checkMutationsReferenceRealScenarios() {
  const errors = [];
  const { manifest } = loadCorpus();
  const knownIds = new Set(manifest.scenarios.map((s) => s.scenarioId));

  for (const file of listFixtureFiles()) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.category !== 'mutation-negative-control') continue;
    for (const record of parsed.records || []) {
      if (!knownIds.has(record.mutationOf)) {
        errors.push(`mutation '${record.scenarioId}' has mutationOf '${record.mutationOf}', which is not a known scenarioId`);
      }
    }
  }
  return errors;
}

function main() {
  const errors = [];

  const manifestResult = validateManifest();
  if (!manifestResult.valid) errors.push(...manifestResult.errors.map((e) => `[manifest] ${e}`));

  const fixtureResult = validateFixtureFiles();
  if (!fixtureResult.valid) errors.push(...fixtureResult.errors.map((e) => `[fixtures] ${e}`));

  const privacyResult = scanCorpusPrivacy();
  if (!privacyResult.safe) {
    errors.push(
      ...privacyResult.violations.map((v) => `[privacy] ${v.file} at ${v.path}: ${v.reason}`),
    );
  }

  // Cross-reference checks only make sense once the manifest/fixtures are
  // individually well-formed - loadCorpus() throws on a dangling pointer,
  // which the manifestResult check above should already have caught, but
  // guard here too so a partial failure doesn't crash validateCorpus itself.
  if (manifestResult.valid && fixtureResult.valid) {
    errors.push(...checkNoOrphanedRecords());
    errors.push(...checkMutationsReferenceRealScenarios());
  }

  if (errors.length > 0) {
    console.error('COMMERCE CORPUS VALIDATION: FAIL');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const { manifest } = loadCorpus();
  console.log('COMMERCE CORPUS VALIDATION: PASS');
  console.log(`  manifest scenarios: ${manifest.scenarios.length}`);
  console.log(`  fixture records: ${fixtureResult.totalRecords}`);
  console.log(`  privacy: ${privacyResult.filesScanned} files scanned, 0 violations`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { checkNoOrphanedRecords, checkMutationsReferenceRealScenarios };
