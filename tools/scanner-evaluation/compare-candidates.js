#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compareExperiments, compareRuns } = require('./lib/compareCandidates');
const { validateExperimentRecord } = require('./lib/experimentMeta');
const runnerState = require('./lib/runnerState');

function usage() {
  console.error('Usage: node compare-candidates.js <baseline.json> <candidate.json>');
  console.error('       node compare-candidates.js --control-dir <dir> --candidate-dir <dir> [--profile <name>]');
  process.exit(2);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
}

/**
 * Per-case control-versus-candidate comparison over two private run directories.
 *
 * The directories are READ ONLY — nothing is written back into either run — and
 * the artifact is checked for absolute paths before it is printed, because this
 * output is the one thing from a private run that is meant to be quoted.
 */
function compareRunDirectories(controlDir, candidateDir, profile) {
  const readRun = (dir) => {
    const manifest = runnerState.readRunManifest(dir);
    if (!manifest) throw new Error(`no run-manifest.json in ${path.basename(dir)}`);
    return {
      runId: manifest.runId,
      candidateVersion: manifest.candidateVersion || null,
      records: runnerState.loadAllResults(dir, manifest.datasetVersion),
    };
  };
  return compareRuns(readRun(controlDir), readRun(candidateDir), { profile });
}

function main(argv) {
  const args = argv.slice(2);

  const controlDir = flag(args, '--control-dir');
  const candidateDir = flag(args, '--candidate-dir');
  if (controlDir || candidateDir) {
    if (!controlDir || !candidateDir) usage();
    const artifact = compareRunDirectories(
      path.resolve(controlDir),
      path.resolve(candidateDir),
      flag(args, '--profile') || undefined
    );
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

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

module.exports = { main, compareRunDirectories };
