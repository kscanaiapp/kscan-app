#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runRegressionGate, DEFAULT_THRESHOLD_CONFIG } = require('./lib/compareCandidates');
const { validateExperimentRecord, assertDatasetVersionMatch } = require('./lib/experimentMeta');

function usage() {
  console.error(
    'Usage: node regression-gate.js <baseline.json> <candidate.json> [--mode report_only|blocking]'
  );
  process.exit(2);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length < 2) usage();
  const baseline = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
  let mode = 'report_only';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx >= 0) mode = args[modeIdx + 1];

  const bMeta = validateExperimentRecord(baseline);
  const cMeta = validateExperimentRecord(candidate);
  if (!bMeta.ok || !cMeta.ok) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          baselineErrors: bMeta.errors,
          candidateErrors: cMeta.errors,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const versionCheck = assertDatasetVersionMatch(candidate, baseline.datasetVersion);
  if (!versionCheck.ok) {
    console.error(JSON.stringify({ ok: false, errors: versionCheck.errors }, null, 2));
    process.exit(1);
  }

  const report = runRegressionGate(baseline, candidate, {
    ...DEFAULT_THRESHOLD_CONFIG,
    mode,
  });
  console.log(JSON.stringify(report, null, 2));
  if (mode === 'blocking' && !report.passed) process.exit(1);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { main };
