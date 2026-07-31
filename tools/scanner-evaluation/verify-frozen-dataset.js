#!/usr/bin/env node
'use strict';

const path = require('path');
const { ROOT } = require('./lib/governedStorage');
const { verifyFrozenDataset } = require('./lib/frozenDataset');

function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  return { manifest: value('--manifest'), freezeRecord: value('--freeze-record') };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.manifest || !args.freezeRecord) {
    console.error('Usage: verify-frozen-dataset.js --manifest <manifest.json> --freeze-record <freeze.json>');
    process.exitCode = 2;
    return { ok: false };
  }
  const report = verifyFrozenDataset(
    path.resolve(ROOT, args.manifest),
    path.resolve(ROOT, args.freezeRecord)
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) main();

module.exports = { main, parseArgs };
