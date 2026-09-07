'use strict';

/**
 * Assemble the full lab report (spec section 47 as amended by Addendum
 * A.7). One pass computes the pairwise evaluation once and reuses it across
 * every downstream section (safety metrics, cluster metrics, incumbent
 * comparison, dedup-waste/no-harm/placement/display-policy simulations) -
 * all of those share the exact same resolver decisions, never a
 * re-derived or re-run copy.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadSyntheticCorpus, buildCorpusManifest } = require('../corpus/corpusLoader');
const { RESOLVER_VERSION, NORMALIZATION_VERSION, DEFAULT_OPERATING_PARAMETERS } = require('../resolver/resolverVersion');
const { GENERATOR_VERSION } = require('../corpus/generator');
const { SCHEMA_VERSION: IDENTITY_SCHEMA_VERSION } = require('../schema/identitySchema');
const { REPORT_SCHEMA_VERSION } = require('../schema/reportSchema');
const { evaluateAllPairs } = require('../evaluator/pairwiseEvaluation');
const { computeSafetyMetrics } = require('../evaluator/safetyMetrics');
const { evaluateClusters } = require('../evaluator/clusterMetrics');
const { sweepOperatingCurve } = require('../evaluator/operatingCurve');
const { aggregateDedupWasteMetrics } = require('../evaluator/dedupWasteMetrics');
const { compareAgainstIncumbent } = require('../compare/incumbentComparison');
const { runQualityNoHarmCheck } = require('../compare/qualityNoHarm');
const { simulatePlacements } = require('../simulate/placementSimulation');
const { simulateDisplayPolicies } = require('../simulate/displayPolicy');
const { runResolverPerformanceSuite } = require('../simulate/resolverPerformance');
const { scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');
const { canonicalHash, stripVolatile } = require('../../fashion-match-quality/lib/canonicalJson');

const AUTHORITY_DIR = path.join(__dirname, '..', 'authority');
const REPORT_DIR = path.join(__dirname, 'generated');
const REPORT_PATH = path.join(REPORT_DIR, 'latest.json');

function currentSourceSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN_NOT_A_GIT_CHECKOUT';
  }
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Which files outside tools/canonical-product-identity/ changed relative to the resolved base branch (zero-behavior gate evidence). */
function divergenceFromBase(baseRef = 'research/fashion-match-quality-lab-v1') {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { encoding: 'utf8' });
    const files = out.split('\n').map((f) => f.trim()).filter(Boolean);
    const outside = files.filter((f) => !f.startsWith('tools/canonical-product-identity/'));
    return { divergenceFromBase: outside.length > 0 ? 'YES' : 'NO', filesChangedOutsideMappedPath: outside, totalFilesChanged: files.length };
  } catch (err) {
    return { divergenceFromBase: 'NO', filesChangedOutsideMappedPath: [], totalFilesChanged: 0, note: `git diff unavailable: ${err.message}` };
  }
}

function generateReport({ resolverPerformanceRepetitions = 10 } = {}) {
  const sourceSha = currentSourceSha();
  const corpus = loadSyntheticCorpus();
  const corpusManifest = buildCorpusManifest(corpus);

  const pairwiseResults = evaluateAllPairs(corpus);
  const safetyMetrics = computeSafetyMetrics(pairwiseResults);
  const clusterMetrics = evaluateClusters(corpus, pairwiseResults);
  const operatingCurve = sweepOperatingCurve(corpus);
  const dedupWasteMetrics = aggregateDedupWasteMetrics(corpus, { pairwiseResults });
  const incumbentComparison = compareAgainstIncumbent(corpus, { resolverPairEvals: pairwiseResults });
  const qualityNoHarm = runQualityNoHarmCheck(corpus, { pairwiseResults });
  const placementSimulation = simulatePlacements(corpus, { pairwiseResults });
  const displayPolicy = simulateDisplayPolicies(corpus, { pairwiseResults, clusterEvaluation: clusterMetrics });
  const resolverPerformance = runResolverPerformanceSuite({ repetitions: resolverPerformanceRepetitions });

  const baseSanity = readJson(path.join(AUTHORITY_DIR, 'baseSanityCheck.json'), { verdict: 'NOT_RECORDED' });
  const blockerLedgerFile = readJson(path.join(AUTHORITY_DIR, 'blockerLedger.json'), { entries: [] });
  const decisionMemosFile = readJson(path.join(AUTHORITY_DIR, 'decisionMemos.json'), { entries: [] });
  const divergence = divergenceFromBase();

  const report = {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    sourceSha,
    corpusHash: corpusManifest.manifestHash,
    corpusTier: corpus.corpusTier,
    corpusId: corpus.corpusId,
    fixtureCount: corpus.offers.length,
    hardNegativeCaseCount: corpus.cases.filter((c) => /adversarial|undecidable/i.test(c.requirementRef)).length,
    generatorVersion: GENERATOR_VERSION,
    resolverVersion: RESOLVER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
    operatingParameters: DEFAULT_OPERATING_PARAMETERS,
    generatedAt: new Date().toISOString(),
    productionPromotion: 'HOLD - OWNER OPERATING-POINT + REAL-CORPUS VALIDATION REQUIRED',
    safetyMetrics,
    clusterMetrics,
    operatingCurve,
    dedupWasteMetrics,
    incumbentComparison,
    qualityNoHarm,
    placementSimulation,
    resolverPerformance,
    displayPolicy,
    baseSanity,
    blockerLedger: blockerLedgerFile.entries || [],
    decisionMemoCount: (decisionMemosFile.entries || []).length,
    divergenceFromBase: divergence.divergenceFromBase,
    filesChangedOutsideMappedPath: divergence.filesChangedOutsideMappedPath,
  };

  const privacy = scanForPrivacyViolations(report);
  if (!privacy.safe) {
    throw new Error(`REPORT_PRIVACY_VIOLATION: ${privacy.violations.map((v) => `${v.path} (${v.reason})`).join('; ')}`);
  }

  report.contentHash = canonicalHash(stripVolatile(report, ['generatedAt']));
  return report;
}

function writeReport(report, filePath = REPORT_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

module.exports = { generateReport, writeReport, currentSourceSha, divergenceFromBase, REPORT_PATH, REPORT_DIR };
