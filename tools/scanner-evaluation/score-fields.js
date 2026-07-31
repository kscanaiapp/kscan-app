#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { scoreCase, aggregateScores } = require('./lib/scoreFields');

function usage() {
  console.error(
    'Usage: node score-fields.js <labels-or-manifest.json> <predictions.json>'
  );
  process.exit(2);
}

function loadCases(filePath) {
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(doc.cases)) return doc.cases;
  if (Array.isArray(doc)) return doc;
  throw new Error('expected cases array');
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length < 2) usage();
  const labels = loadCases(path.resolve(args[0]));
  const predictionsDoc = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8'));
  const predictions = Array.isArray(predictionsDoc.predictions)
    ? predictionsDoc.predictions
    : Array.isArray(predictionsDoc)
      ? predictionsDoc
      : [];

  const byId = new Map(predictions.map((p) => [p.caseId, p]));
  const caseScores = labels.map((label) => scoreCase(label, byId.get(label.caseId) || {}));
  const metrics = aggregateScores(caseScores);
  const report = { caseScores, metrics };
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { main };
