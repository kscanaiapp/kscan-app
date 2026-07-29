#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compareExperiments } = require('./lib/compareCandidates');
const { validateExperimentRecord } = require('./lib/experimentMeta');

function usage() {
  console.error('Usage: node compare-candidates.js <baseline.json> <candidate.json>');
  process.exit(2);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length < 2) usage();
  const baseline = JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
  for (const [name, record] of [
    ['baseline', baseline],
    ['candidate', candidate],
  ]) {
    const result = validateExperimentRecord(record);
    if (!result.ok) {
      console.error(JSON.stringify({ ok: false, record: name, errors: result.errors }, null, 2));
      process.exit(1);
    }
  }
  const compared = compareExperiments(baseline, candidate);
  console.log(JSON.stringify(compared, null, 2));
  if (!compared.ok) process.exit(1);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { main };
