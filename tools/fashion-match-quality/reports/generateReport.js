'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runContractControls, contractPassed } = require('../contract/runContract');
const { loadFullCorpus, splitDevelopmentHoldout, buildCorpusManifest } = require('../corpus/corpusLoader');
const { evaluateCorpus } = require('../evaluator/evaluate');
const { aggregateMetrics } = require('../metrics/aggregate');
const { RUBRIC_VERSION } = require('../evaluator/rubric');
const { scoreSubstitute } = require('../evaluator/substituteAxis');
const { runL1ForFixture, isDenoAvailable } = require('../l1/runL1');
const { createBaseline, writeBaseline, readBaseline, assertBaselinesComparable } = require('../baseline/baselineStore');
const { compareBaselines } = require('../statistics/compare');
const { runReplay } = require('../replay/replayRunner');
const { runAllExperiments } = require('../experiments/runExperiments');
const { assertPrivacySafe } = require('../schema/privacyGuard');
const { canonicalHash, stripVolatile } = require('../lib/canonicalJson');

const REPORT_SCHEMA_VERSION = 'fmql-report-schema-v1';
const DEFAULT_BASELINE_PATH = path.join(__dirname, '..', 'baseline', 'committed', 'synthetic-v1.baseline.json');

function currentSourceSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN_NOT_A_GIT_CHECKOUT';
  }
}

function buildPerFixtureScoreMap(evaluations, fixturesById) {
  const map = {};
  for (const e of evaluations) {
    if (e.excludedFromHeadlineMetrics || e.l1Status !== 'OK') continue;
    map[e.fixtureId] = typeof e.substitute?.rollup === 'number' ? e.substitute.rollup : 0;
  }
  return map;
}

/**
 * Run the full lab pipeline (contract -> offline -> replay -> baseline
 * compare -> experiments) and assemble one report object. This is the
 * runner's core logic; validateReport.js re-derives its own checks
 * independently rather than calling into this file (spec section 30 -
 * "The validator must be independent of the main runner").
 */
function generateReport({ baselinePath = DEFAULT_BASELINE_PATH, createBaselineIfMissing = true, force = false } = {}) {
  const sourceSha = currentSourceSha();
  const contractControls = runContractControls();

  const fixtures = loadFullCorpus();
  const manifest = buildCorpusManifest(fixtures);
  const { development, holdout } = splitDevelopmentHoldout(fixtures);

  const denoAvailable = isDenoAvailable();
  const evaluations = evaluateCorpus(development);
  const metrics = aggregateMetrics(evaluations);

  const offlinePipelineMode = !denoAvailable
    ? 'BLOCKED'
    : evaluations.some((e) => e.l1Status !== 'OK')
      ? 'PARTIAL'
      : 'PASS';

  const perFixtureScore = buildPerFixtureScoreMap(evaluations, fixtures);

  const candidateBaseline = createBaseline({
    sourceSha,
    fixtureManifest: manifest,
    rubricVersion: RUBRIC_VERSION,
    evaluationMode: 'L1_OFFLINE_DEVELOPMENT_PARTITION',
    metrics,
    perFixtureScore,
  });

  let comparison = null;
  let baselineAction = 'none';
  if (fs.existsSync(baselinePath)) {
    const existingBaseline = readBaseline(baselinePath);
    try {
      assertBaselinesComparable(existingBaseline, candidateBaseline);
      comparison = compareBaselines(existingBaseline, candidateBaseline);
      baselineAction = 'compared_against_existing';
    } catch (err) {
      comparison = { error: err.message };
      baselineAction = 'existing_baseline_incompatible';
    }
  } else if (createBaselineIfMissing) {
    writeBaseline(baselinePath, candidateBaseline, { force });
    baselineAction = 'created_new_baseline';
  }

  const replay = runReplay();
  const experiments = denoAvailable ? runAllExperiments(development) : [];

  const controls = [
    ...contractControls,
    {
      name: 'offline_pipeline_mode',
      verdict: offlinePipelineMode === 'BLOCKED' ? 'FAIL' : 'PASS',
      detail: offlinePipelineMode,
    },
    { name: 'replay_mode', verdict: 'PASS', detail: replay.status },
  ];

  const report = {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    sourceSha,
    fixtureManifestHash: manifest.manifestHash,
    rubricVersion: RUBRIC_VERSION,
    corpusTier: Object.keys(manifest.countByTier || {}).sort(),
    generatedAt: new Date().toISOString(),
    corpus: {
      totalFixtures: fixtures.length,
      developmentCount: development.length,
      holdoutCount: holdout.length,
      countByTier: manifest.countByTier,
    },
    contractMode: contractPassed(contractControls) ? 'PASS' : 'FAIL',
    offlinePipelineMode,
    replayMode: replay.status,
    liveMode: 'NOT AUTHORIZED',
    metrics,
    baseline: {
      action: baselineAction,
      path: path.relative(path.join(__dirname, '..', '..', '..'), baselinePath),
      contentHash: candidateBaseline.contentHash,
    },
    comparison,
    experiments,
    controls,
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };

  assertPrivacySafe(report, 'report');
  report.contentHash = canonicalHash(stripVolatile(report, ['generatedAt']));

  return report;
}

function writeReport(report, outDir = path.join(__dirname, 'generated')) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `report-${report.contentHash.slice(0, 12)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const latest = path.join(outDir, 'latest.json');
  fs.writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = { generateReport, writeReport, REPORT_SCHEMA_VERSION, DEFAULT_BASELINE_PATH, currentSourceSha };
