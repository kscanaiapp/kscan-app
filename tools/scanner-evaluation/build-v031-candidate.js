#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { buildCandidate, validateCandidate } = require('./lib/datasetPatchV031');
const { ROOT } = require('./lib/governedStorage');

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2)) {
  const sourceArg = value(argv, '--source');
  const outArg = value(argv, '--out');
  if (!sourceArg || !outArg) throw new Error('Usage: --source <v0.3.0.json> --out <candidate.json>');
  const source = JSON.parse(fs.readFileSync(path.resolve(ROOT, sourceArg), 'utf8'));
  const candidate = buildCandidate(source);
  const out = path.resolve(outArg);
  if (fs.existsSync(out)) throw new Error(`output collision: ${out}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  const validation = validateCandidate(candidate);
  console.log(JSON.stringify({ ok: validation.ok, out, ...validation }, null, 2));
  return { candidate, out, validation };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { main };
