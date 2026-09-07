'use strict';

/**
 * Assembles the full instrument-validation report: corpus metrics, coverage
 * matrix, operating curve, L1.5 real-code-execution results, safety-map
 * completeness, body/appearance stratification, and multi-turn evaluation.
 * Pure aggregation -- no live model calls, no network beyond L1.5's
 * filesystem `import()` of local production source.
 *
 * DETERMINISM (spec section 52): every field is a pure function of the
 * fixtures + source code in this worktree, except `generatedAt`, which is
 * explicitly excluded from the canonical hash via stableHashExcluding.
 */

const { getFixtures } = require('../fixtures');
const { buildCorpus } = require('../metrics/corpusRunner');
const { computeVerdictReproduction } = require('../metrics/verdictReproduction');
const { buildCoverageMatrix, summarizeDefectCoverage } = require('../metrics/coverageMatrix');
const { partitionSuppressedCases } = require('../metrics/coverageSuppression');
const { runOperatingCurve } = require('../extraction/operatingCurve');
const { evaluateAllMultiTurnTraces } = require('../grounding/multiTurnContinuity');
const { loadSafetyPolicyMap, checkSafetyPolicyMapCompleteness, summarizeStatus } = require('../safety/safetyPolicyCheck');
const { classifyBodyAppearanceMessage, BODY_APPEARANCE_TEST_MESSAGES } = require('../safety/bodyAppearanceClassifier');
const { runL15Suite } = require('../context-assembly/l15Metrics');
const { corpusReadinessStatus } = require('../replay/ownerTranscriptImporter');
const { canonicalStringify, sha256Hex, stableHashExcluding, nowIso } = require('../model/canonicalJson');
const { EVIDENCE_FRAMING_BANNER, CLAIM_CLAUSE } = require('./evidenceFraming');

const { SYNTHESIZER_VERSION } = require('../synthesis/responseSynthesizer');
const { EXTRACTION_RULES_VERSION } = require('../model/claimSchema');
const { DEFECT_TAXONOMY_VERSION } = require('../model/defectTaxonomy');
const { PRECEDENCE_CONTRACT_VERSION } = require('../model/precedenceContract');
const { RUBRIC_VERSION } = require('../human-review/rubric');
const { FIXTURE_SCHEMA_VERSION } = require('../schema/fixtureSchema');

const CORPUS_VERSION = 'CORPUS_V1';

function hashCorpus(cases) {
  const stable = cases
    .map((c) => ({
      scenarioId: c.scenarioId,
      systemProfile: c.systemProfile,
      script: c.script,
      text: c.text || null,
      pair: c.pair || null,
      expectedVerdict: c.expectedVerdict,
      actualVerdict: c.actualVerdict,
    }))
    .sort((a, b) => (a.scenarioId + a.systemProfile + a.script).localeCompare(b.scenarioId + b.systemProfile + b.script));
  return sha256Hex(canonicalStringify(stable));
}

async function generateReport(options = {}) {
  const fixtures = getFixtures();
  const { cases, skipped } = buildCorpus();
  const { covered, suppressed, suppressionNotes } = partitionSuppressedCases(cases, fixtures.scenariosById);
  // Headline VERDICT_REPRODUCTION_RATE excludes INSUFFICIENT_COVERAGE cells
  // (spec section 20); the unsuppressed, full-corpus metric is kept
  // alongside it for transparency, never presented as the headline.
  const verdictMetrics = computeVerdictReproduction(covered);
  const verdictMetricsUnsuppressed = computeVerdictReproduction(cases);
  const coverage = buildCoverageMatrix(cases, fixtures.scenariosById);
  const defectCoverageSummary = summarizeDefectCoverage(coverage);
  const operatingCurve = runOperatingCurve();
  const multiTurn = evaluateAllMultiTurnTraces(fixtures);

  const safetyMap = loadSafetyPolicyMap();
  const safetyCheck = checkSafetyPolicyMapCompleteness(safetyMap);
  const safetyStatus = summarizeStatus(safetyMap);
  const bodyAppearanceResults = BODY_APPEARANCE_TEST_MESSAGES.map((t) => ({
    message: t.message,
    expectedStratum: t.expectedStratum,
    result: classifyBodyAppearanceMessage(t.message),
  }));

  let l15;
  if (options.skipL15) {
    l15 = { available: null, reason: 'skipped by caller option' };
  } else {
    l15 = await runL15Suite();
  }

  const corpusHash = hashCorpus(cases);

  const report = {
    generatedAt: nowIso(),
    evidenceFraming: EVIDENCE_FRAMING_BANNER,
    claimClause: CLAIM_CLAUSE,
    versions: {
      harnessVersion: require('../baseline/baseline').HARNESS_VERSION,
      corpusVersion: CORPUS_VERSION,
      synthesizerVersion: SYNTHESIZER_VERSION,
      extractionRulesVersion: EXTRACTION_RULES_VERSION,
      defectTaxonomyVersion: DEFECT_TAXONOMY_VERSION,
      precedenceContractVersion: PRECEDENCE_CONTRACT_VERSION,
      rubricVersion: RUBRIC_VERSION,
      fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
    },
    corpus: {
      caseCount: cases.length,
      skippedCount: skipped.length,
      corpusHash,
      skippedSample: skipped.slice(0, 20),
    },
    coverageSuppression: {
      suppressedCaseCount: suppressed.length,
      coveredCaseCount: covered.length,
      notes: suppressionNotes,
    },
    verdictReproduction: verdictMetrics,
    verdictReproductionUnsuppressedForTransparencyOnly: verdictMetricsUnsuppressed,
    coverageMatrix: { hash: coverage.coverageMatrixHash, coveredCellCount: coverage.coveredCellCount, totalCasesCovered: coverage.totalCasesCovered, byDefect: defectCoverageSummary },
    extractionOperatingCurve: operatingCurve,
    multiTurnEvaluation: multiTurn,
    safetyPolicyMap: { check: safetyCheck, status: safetyStatus },
    bodyAppearanceSafety: bodyAppearanceResults,
    l15ContextAssembly: l15,
    ownerCapturedCorpus: corpusReadinessStatus(0),
    crossSystemFactTest: (() => {
      const d13 = verdictMetrics.perDefect.D13;
      return d13 ? `TESTED_ON_SYNTHETIC_PAIR (reproduction rate ${d13.rate})` : 'NOT TESTABLE -- NO SUBJECT RESPONSES';
    })(),
  };

  const reportHash = stableHashExcluding(report, ['generatedAt']);
  return { ...report, reportContentHash: reportHash };
}

module.exports = { generateReport, hashCorpus, CORPUS_VERSION };
