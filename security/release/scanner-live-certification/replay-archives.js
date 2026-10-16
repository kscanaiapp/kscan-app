#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadProductionReplay, replayArchives } = require('./lib/archivedReplay');
const { assertEvidencePrivacy } = require('./lib/report');
const root = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; }
if (!arg('--backend-root') || !arg('--out')) throw new Error('Usage: node security/release/scanner-live-certification/replay-archives.js --backend-root <repair-worktree> --out <report.json>');
const reports = ['P1', 'P2', 'R1'].map(phase => JSON.parse(fs.readFileSync(path.join(root, 'docs/build35/scanner/evidence', `${phase}-report.json`), 'utf8')));
const historicalVersionNotes = Object.fromEntries(['P1', 'P2', 'R1'].map(phase => {
  const source = `docs/build35/scanner/evidence/${phase}-relevance-grades.json`;
  const run = JSON.parse(fs.readFileSync(path.join(root, source), 'utf8')).run;
  return [phase, { source, note: run, backendVersion: /scan-identify (v\d+)/.exec(run)?.[1] ?? null }];
}));
const report = replayArchives({ reports, corpus: require('./corpus.json'), production: loadProductionReplay(path.resolve(arg('--backend-root'))), historicalVersionNotes });
assertEvidencePrivacy(report);
fs.writeFileSync(path.resolve(arg('--out')), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
