#!/usr/bin/env node
'use strict';

/**
 * Canonical Product Identity Lab - main CLI entry point (spec section 42:
 * CONTRACT / CORPUS / RESOLVE / COMPARE / SIMULATE / REPORT - no live mode).
 *
 * Usage:
 *   node tools/canonical-product-identity/runner.js contract
 *   node tools/canonical-product-identity/runner.js corpus [--seed=...] [--instances=N]
 *   node tools/canonical-product-identity/runner.js resolve
 *   node tools/canonical-product-identity/runner.js compare
 *   node tools/canonical-product-identity/runner.js simulate
 *   node tools/canonical-product-identity/runner.js report
 *   node tools/canonical-product-identity/runner.js baseline:create [--force]
 */

const path = require('node:path');

const { runContractControls, contractPassed } = require('./contract/runContract');
const { generateCorpus, DEFAULT_SEED, DEFAULT_INSTANCES_PER_CASE } = require('./corpus/generator');
const { loadSyntheticCorpus, buildCorpusManifest } = require('./corpus/corpusLoader');
const { evaluateAllPairs } = require('./evaluator/pairwiseEvaluation');
const { computeSafetyMetrics } = require('./evaluator/safetyMetrics');
const { evaluateClusters } = require('./evaluator/clusterMetrics');
const { compareAgainstIncumbent } = require('./compare/incumbentComparison');
const { runQualityNoHarmCheck } = require('./compare/qualityNoHarm');
const { simulatePlacements } = require('./simulate/placementSimulation');
const { simulateDisplayPolicies } = require('./simulate/displayPolicy');
const { runResolverPerformanceSuite } = require('./simulate/resolverPerformance');
const { generateReport, writeReport, currentSourceSha } = require('./reports/generateReport');
const { createBaseline, writeBaseline } = require('./baseline/baselineStore');
const { RESOLVER_VERSION, NORMALIZATION_VERSION, DEFAULT_OPERATING_PARAMETERS } = require('./resolver/resolverVersion');
const { SCHEMA_VERSION: IDENTITY_SCHEMA_VERSION } = require('./schema/identitySchema');

const DEFAULT_BASELINE_PATH = path.join(__dirname, 'baseline', 'committed', 'synthetic-v1.baseline.json');

function cmdContract() {
  const controls = runContractControls();
  console.log('CONTRACT MODE (offline, zero network)');
  for (const c of controls) {
    const mark = c.verdict === 'PASS' ? 'PASS' : c.verdict === 'SKIPPED' ? 'SKIP' : 'FAIL';
    console.log(`  [${mark}] ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  }
  const passed = contractPassed(controls);
  console.log(passed ? '\nCONTRACT MODE: PASS' : '\nCONTRACT MODE: FAIL');
  process.exit(passed ? 0 : 1);
}

function cmdCorpus(args) {
  const seed = (args.find((a) => a.startsWith('--seed=')) || `--seed=${DEFAULT_SEED}`).split('=')[1];
  const instances = Number((args.find((a) => a.startsWith('--instances=')) || `--instances=${DEFAULT_INSTANCES_PER_CASE}`).split('=')[1]);
  const corpus = generateCorpus({ seed, instancesPerCase: instances });
  const manifest = buildCorpusManifest(corpus);
  console.log(`CORPUS: offers=${corpus.offers.length} styles=${corpus.canonicalStyles.length} cases=${corpus.cases.length} overrides=${corpus.pairOverrides.length}`);
  console.log(`manifestHash=${manifest.manifestHash}`);
  process.exit(0);
}

function cmdResolve() {
  const corpus = loadSyntheticCorpus();
  const pairEvals = evaluateAllPairs(corpus);
  const safety = computeSafetyMetrics(pairEvals);
  const clusters = evaluateClusters(corpus, pairEvals);
  console.log(`RESOLVE: pairs=${safety.totalPairsEvaluated} autoMerge=${safety.decisionCounts.AUTO_MERGE} falseMerges=${safety.falseMergeCount} (${safety.falseMergeGateStatus})`);
  console.log(`variantClusters=${clusters.variantClusterCount} styleClusters=${clusters.styleClusterCount} variantSeparationAccuracy=${clusters.variantSeparationAccuracy}`);
  process.exit(safety.falseMergeCount === 0 ? 0 : 1);
}

function cmdCompare() {
  const corpus = loadSyntheticCorpus();
  const result = compareAgainstIncumbent(corpus);
  console.log('COMPARE (vs Fashion Match Quality incumbent duplicateClassifier):');
  console.log(JSON.stringify(result.byMetric, null, 2));
  process.exit(0);
}

function cmdSimulate() {
  const corpus = loadSyntheticCorpus();
  const pairwiseResults = evaluateAllPairs(corpus);
  const clusterEvaluation = evaluateClusters(corpus, pairwiseResults);
  const noHarm = runQualityNoHarmCheck(corpus, { pairwiseResults });
  const placement = simulatePlacements(corpus, { pairwiseResults });
  const display = simulateDisplayPolicies(corpus, { pairwiseResults, clusterEvaluation });
  const perf = runResolverPerformanceSuite({ repetitions: 5 });
  console.log(`SIMULATE: noHarm=${noHarm.summary.overallVerdict} placementEvidenceClass=${placement.evidenceClass} displayWindows=${display.perWindow.length} resolverP50@500=${perf[perf.length - 1].p50Ms}ms`);
  process.exit(0);
}

function cmdReport() {
  const report = generateReport();
  const file = writeReport(report);
  console.log(`Report written to ${file}`);
  console.log(`contentHash=${report.contentHash}`);
  console.log(`productionPromotion=${report.productionPromotion}`);
  process.exit(report.safetyMetrics.falseMergeCount === 0 ? 0 : 1);
}

function cmdBaselineCreate(args) {
  const force = args.includes('--force');
  const corpus = loadSyntheticCorpus();
  const corpusManifest = buildCorpusManifest(corpus);
  const pairEvals = evaluateAllPairs(corpus);
  const safetyMetrics = computeSafetyMetrics(pairEvals);
  const clusterMetrics = evaluateClusters(corpus, pairEvals);

  const baseline = createBaseline({
    sourceSha: currentSourceSha(),
    corpus,
    corpusManifest,
    resolverVersion: RESOLVER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    operatingParameters: DEFAULT_OPERATING_PARAMETERS,
    metrics: { safetyMetrics, clusterMetrics },
  });
  const result = writeBaseline(DEFAULT_BASELINE_PATH, baseline, { force });
  console.log(result.written ? `Baseline written to ${DEFAULT_BASELINE_PATH}` : `Baseline unchanged: ${result.reason}`);
  console.log(`contentHash=${baseline.contentHash}`);
  process.exit(0);
}

function main() {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'contract': return cmdContract();
    case 'corpus': return cmdCorpus(rest);
    case 'resolve': return cmdResolve();
    case 'compare': return cmdCompare();
    case 'simulate': return cmdSimulate();
    case 'report': return cmdReport();
    case 'baseline:create': return cmdBaselineCreate(rest);
    default:
      console.error('Unknown or missing command. Usage:');
      console.error('  node runner.js contract');
      console.error('  node runner.js corpus [--seed=...] [--instances=N]');
      console.error('  node runner.js resolve');
      console.error('  node runner.js compare');
      console.error('  node runner.js simulate');
      console.error('  node runner.js report');
      console.error('  node runner.js baseline:create [--force]');
      process.exit(2);
  }
}

main();
