#!/usr/bin/env node
'use strict';

/**
 * Fashion Match Quality Lab - main CLI entry point.
 *
 * Usage:
 *   node tools/fashion-match-quality/runner.js contract
 *   node tools/fashion-match-quality/runner.js report [--force]
 *   node tools/fashion-match-quality/runner.js baseline:create [--force]
 *
 * See tools/fashion-match-quality/README.md for the full operator guide.
 */

const path = require('node:path');

const { runContractControls, contractPassed } = require('./contract/runContract');
const { generateReport, writeReport, DEFAULT_BASELINE_PATH, currentSourceSha } = require('./reports/generateReport');
const { loadFullCorpus, buildCorpusManifest } = require('./corpus/corpusLoader');
const { createBaseline, writeBaseline } = require('./baseline/baselineStore');
const { evaluateCorpus } = require('./evaluator/evaluate');
const { aggregateMetrics } = require('./metrics/aggregate');
const { RUBRIC_VERSION } = require('./evaluator/rubric');

function printControls(controls) {
  for (const c of controls) {
    const mark = c.verdict === 'PASS' ? 'PASS' : c.verdict === 'SKIPPED' ? 'SKIP' : 'FAIL';
    console.log(`  [${mark}] ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  }
}

function cmdContract() {
  const controls = runContractControls();
  console.log('L0 CONTRACT MODE');
  printControls(controls);
  const passed = contractPassed(controls);
  console.log(passed ? '\nCONTRACT MODE: PASS' : '\nCONTRACT MODE: FAIL');
  process.exit(passed ? 0 : 1);
}

function cmdReport(args) {
  const force = args.includes('--force');
  const report = generateReport({ force });
  const file = writeReport(report);
  console.log(`Report written to ${file}`);
  console.log(`contentHash=${report.contentHash}`);
  console.log(`contractMode=${report.contractMode} offlinePipelineMode=${report.offlinePipelineMode} replayMode=${report.replayMode}`);
  process.exit(report.contractMode === 'PASS' ? 0 : 1);
}

function cmdBaselineCreate(args) {
  const force = args.includes('--force');
  const fixtures = loadFullCorpus();
  const manifest = buildCorpusManifest(fixtures);
  const evaluations = evaluateCorpus(fixtures);
  const metrics = aggregateMetrics(evaluations);
  const perFixtureScore = {};
  for (const e of evaluations) {
    if (e.excludedFromHeadlineMetrics || e.l1Status !== 'OK') continue;
    perFixtureScore[e.fixtureId] = typeof e.substitute?.rollup === 'number' ? e.substitute.rollup : 0;
  }
  const baseline = createBaseline({
    sourceSha: currentSourceSha(),
    fixtureManifest: manifest,
    rubricVersion: RUBRIC_VERSION,
    evaluationMode: 'L1_OFFLINE_FULL_CORPUS',
    metrics,
    perFixtureScore,
  });
  const result = writeBaseline(DEFAULT_BASELINE_PATH, baseline, { force });
  console.log(result.written ? `Baseline written to ${DEFAULT_BASELINE_PATH}` : `Baseline unchanged: ${result.reason}`);
  console.log(`contentHash=${baseline.contentHash}`);
}

function main() {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'contract':
      return cmdContract();
    case 'report':
      return cmdReport(rest);
    case 'baseline:create':
      return cmdBaselineCreate(rest);
    default:
      console.error('Unknown or missing command. Usage:');
      console.error('  node runner.js contract');
      console.error('  node runner.js report [--force]');
      console.error('  node runner.js baseline:create [--force]');
      process.exit(2);
  }
}

main();
