#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateManifest } = require('./lib/datasetValidate');

function usage() {
  console.error('Usage: node validate-dataset.js <manifest.json> [--dataset-version X.Y.Z]');
  process.exit(2);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length < 1) usage();
  const manifestPath = path.resolve(args[0]);
  let expectedDatasetVersion;
  const idx = args.indexOf('--dataset-version');
  if (idx >= 0) expectedDatasetVersion = args[idx + 1];

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const result = validateManifest(manifest, { expectedDatasetVersion });
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, errors: result.errors }, null, 2));
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        caseCount: result.cases.length,
        datasetVersion: manifest.datasetVersion || null,
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { main };
