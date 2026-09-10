'use strict';

/**
 * Real-corpus evaluation (mission sections 28, 33, 37, 38).
 *
 * The Fashion Match Quality Lab remains the scoring authority. This module
 * calls straight into FMQL's `evaluateCorpus` and `aggregateMetrics`; it does
 * not re-implement identity or substitute scoring, and it does not redesign
 * their taxonomies.
 *
 * What it DOES add is the part FMQL cannot know about, because it is a
 * property of the real corpus rather than of a fixture: the DENOMINATOR.
 * Mission section 6 forbids computing an exact-product accuracy denominator
 * over fixtures incapable of establishing exact identity, and section 38
 * requires every metric to state its N, denominator, eligibility, tier,
 * partition and stratum. So identity metrics here are computed over
 * identity-eligible cases only, and every metric carries its own basis.
 *
 * EVALUATION MODES (mission section 28):
 *   SYNTHETIC      - FMQL's own committed corpus. Not this lane's business;
 *                    `node tools/fashion-match-quality/runner.js report`.
 *   REAL_DEVELOPMENT - the default here.
 *   REAL_HOLDOUT   - requires an explicit, recorded unseal.
 *   PAIRED_DEVICE  - the iOS/Android paired subset of a partition.
 */

const { execFileSync } = require('node:child_process');

const { evaluateCorpus } = require('../../fashion-match-quality/evaluator/evaluate');
const { aggregateMetrics } = require('../../fashion-match-quality/metrics/aggregate');
const { RUBRIC_VERSION, IDENTITY_LEVELS, SUBSTITUTE_LEVELS } = require('../../fashion-match-quality/evaluator/rubric');
const { SCHEMA_VERSION: FMQL_FIXTURE_SCHEMA_VERSION } = require('../../fashion-match-quality/schema/fixtureSchema');
const { isDenoAvailable } = require('../../fashion-match-quality/l1/runL1');
const { assertPrivacySafe } = require('../../fashion-match-quality/schema/privacyGuard');
const { canonicalHash, stripVolatile } = require('../../fashion-match-quality/lib/canonicalJson');

const { loadCorpus, buildCorpusManifest, realCasesOnly } = require('./corpusStore');
const { compileCorpus } = require('./compile');
const { loadReplayRecords } = require('./replay');
const { openHoldout } = require('./holdout');
const { evaluateIdentityEligibility, deriveGrade } = require('./groundTruth');
const { classifyClaims } = require('./power');
const { ONTOLOGY_VERSION } = require('./ontology');
const { MATCH_TRUTH_LEVELS, classifyMatchTruth } = require('./matchTruth');
const {
  BENCHMARK_STATUS,
  AUTHORIZED_LIVE_EVALUATION_SPEND_USD,
  GRADE_RULES_VERSION,
  CAPTURE_PROFILE_POLICY_VERSION,
  CORPUS_ARTIFACT_SCHEMA_VERSION,
  EVALUATION_SET_TERMS,
  CATEGORIES,
  DIFFICULTY_STRATA,
} = require('./constants');

const EVALUATION_MODES = Object.freeze(['REAL_DEVELOPMENT', 'REAL_HOLDOUT', 'PAIRED_DEVICE']);

function currentSourceSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN_NOT_A_GIT_CHECKOUT';
  }
}

function emptyCounter(levels) {
  const out = {};
  for (const level of levels) out[level] = 0;
  return out;
}

/**
 * Identity metrics over an EXPLICIT eligible set.
 *
 * `eligibleCaseIds` is passed in rather than derived here, so a caller cannot
 * accidentally widen the denominator by handing over a different case list
 * than the one whose eligibility was checked. An evaluation whose fixture is
 * not in the eligible set is counted as SUPPRESSED, never folded in.
 */
function identityMetrics(evaluations, eligibleCaseIds) {
  const distribution = emptyCounter(IDENTITY_LEVELS);
  let suppressed = 0;
  let counted = 0;

  for (const evaluation of evaluations) {
    if (!eligibleCaseIds.has(evaluation.fixtureId)) {
      suppressed += 1;
      continue;
    }
    if (evaluation.identity && IDENTITY_LEVELS.includes(evaluation.identity.level)) {
      distribution[evaluation.identity.level] += 1;
      counted += 1;
    }
  }

  return {
    distribution,
    n: counted,
    denominatorBasis:
      'IDENTITY_ELIGIBLE_CASES: ground-truth grade IDENTIFIER_GRADE, colorway-level truth, a durable identifier ' +
      '(manufacturer style code or GTIN), and an evidence chain containing zero model-derived records ' +
      '(mission section 6).',
    suppressedIneligibleCases: suppressed,
    note:
      suppressed > 0
        ? `${suppressed} evaluated case(s) are excluded from the identity denominator because their ground truth ` +
          'cannot establish exact identity. Counting them would score cases that CANNOT be got right as cases ' +
          'that were got wrong.'
        : null,
  };
}

/**
 * Translates every evaluation's FMQ identity/substitute output into the
 * shared match-truth doctrine (spec section 10) and returns its distribution.
 * This is how FMQ's own result "consumes" the shared doctrine - see
 * lib/matchTruth.js's header for why the translation lives here rather than
 * inside FMQ itself (FMQ owns scoring; this lane owns interpreting its
 * output as real-corpus ground truth requires).
 */
function matchTruthMetrics(evaluations) {
  const distribution = emptyCounter(MATCH_TRUTH_LEVELS);
  let unclassified = 0;
  for (const evaluation of evaluations) {
    const level = classifyMatchTruth({
      identityLevel: evaluation.identity?.level,
      substituteLevel: evaluation.substitute?.level,
    });
    if (level === null) {
      unclassified += 1;
      continue;
    }
    distribution[level] += 1;
  }
  return { distribution, n: evaluations.length - unclassified, unclassified };
}

/** Stratify a set of evaluations by an arbitrary key, keeping N visible. */
function stratify(evaluations, fixturesById, keyFn) {
  const buckets = {};
  for (const evaluation of evaluations) {
    const fixture = fixturesById.get(evaluation.fixtureId);
    for (const key of keyFn(fixture, evaluation)) {
      if (!buckets[key]) {
        buckets[key] = { n: 0, identityDistribution: emptyCounter(IDENTITY_LEVELS), substituteDistribution: emptyCounter(SUBSTITUTE_LEVELS) };
      }
      const bucket = buckets[key];
      bucket.n += 1;
      if (evaluation.identity && IDENTITY_LEVELS.includes(evaluation.identity.level)) {
        bucket.identityDistribution[evaluation.identity.level] += 1;
      }
      if (evaluation.substitute && SUBSTITUTE_LEVELS.includes(evaluation.substitute.level)) {
        bucket.substituteDistribution[evaluation.substitute.level] += 1;
      }
    }
  }
  return buckets;
}

/**
 * Run a real-corpus evaluation.
 *
 * @param {string} mode  one of EVALUATION_MODES
 * @param {object} options
 *   holdout: { reason, invokedBy, env, logPath } - REQUIRED for REAL_HOLDOUT
 */
function runEvaluation(mode = 'REAL_DEVELOPMENT', options = {}) {
  if (!EVALUATION_MODES.includes(mode)) {
    throw new Error(`unknown evaluation mode ${JSON.stringify(mode)}. Expected one of: ${EVALUATION_MODES.join(', ')}`);
  }

  const corpus = loadCorpus();
  const manifest = buildCorpusManifest(corpus);
  const replay = loadReplayRecords();

  let cases;
  let holdoutStatus = 'SEALED';
  let holdoutAudit = null;

  if (mode === 'REAL_HOLDOUT') {
    // Throws HOLDOUT_SEALED unless explicitly and recordedly invoked. There is
    // deliberately no fallback: a default-shaped call cannot reach holdout data.
    const opened = openHoldout(options.holdout || {});
    cases = opened.cases;
    holdoutStatus = opened.holdoutStatus;
    holdoutAudit = opened.auditRecord;
  } else {
    cases = realCasesOnly(corpus.cases);
    if (mode === 'PAIRED_DEVICE') {
      cases = cases.filter((record) => record.pairing?.pairedCaseId);
    }
  }

  const { fixtures, errors: compileErrors } = compileCorpus({
    garmentsById: corpus.garmentsById,
    cases,
    replayById: replay.byCaseId,
  });
  const fixturesById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));

  // Eligibility is computed from the GARMENT, once, and frozen into a set.
  const eligibleCaseIds = new Set();
  const gradeDistribution = { IDENTIFIER_GRADE: 0, PARTIAL: 0, VISUAL_ONLY: 0 };
  for (const record of cases) {
    const garment = corpus.garmentsById.get(record.garmentId);
    if (!garment) continue;
    const grade = deriveGrade(garment.groundTruth).grade;
    if (grade && gradeDistribution[grade] !== undefined) gradeDistribution[grade] += 1;
    if (evaluateIdentityEligibility(garment).eligible) eligibleCaseIds.add(record.caseId);
  }

  const denoAvailable = isDenoAvailable();
  const evaluations = fixtures.length > 0 ? evaluateCorpus(fixtures) : [];

  // FMQL's own aggregation, unmodified, for substitute/component/duplicate/
  // capture-profile dimensions. One scoring system, one aggregator.
  const fmqlMetrics = fixtures.length > 0 ? aggregateMetrics(evaluations) : null;

  const identity = identityMetrics(evaluations, eligibleCaseIds);
  const matchTruth = matchTruthMetrics(evaluations);

  const claims = classifyClaims({
    totalCases: cases.length,
    identityEligibleCases: eligibleCaseIds.size,
    pairedCases: cases.filter((record) => record.pairing?.pairedCaseId).length,
    categoryCounts: stratifyCounts(cases, corpus.garmentsById, (garment) => [garment.category]),
    difficultyCounts: stratifyCounts(cases, corpus.garmentsById, (_g, record) => record.difficultyStrata || []),
  });

  const report = {
    reportSchemaVersion: CORPUS_ARTIFACT_SCHEMA_VERSION,
    evaluationMode: mode,
    evaluationSetTerm: mode === 'REAL_HOLDOUT' ? EVALUATION_SET_TERMS.holdout : EVALUATION_SET_TERMS.development,

    /* ---- mission section 37: every artifact binds these identifiers ---- */
    sourceSha: currentSourceSha(),
    corpusVersion: corpus.config.corpusVersion,
    // V2: the eighth bound identifier - see lib/ontology.js.
    ontologyVersion: ONTOLOGY_VERSION,
    corpusHash: manifest.corpusHash,
    evaluatorVersion: { rubricVersion: RUBRIC_VERSION, fixtureSchemaVersion: FMQL_FIXTURE_SCHEMA_VERSION },
    holdoutStatus,
    groundTruthGradeRules: GRADE_RULES_VERSION,
    captureProfileVersion: CAPTURE_PROFILE_POLICY_VERSION,

    generatedAt: new Date().toISOString(),

    corpus: {
      garments: corpus.garments.length,
      casesInScope: cases.length,
      fixturesCompiled: fixtures.length,
      compileErrors,
      loadErrors: corpus.errors,
      gradeDistribution,
      identityEligibleCases: eligibleCaseIds.size,
      // Tier is stated explicitly on every artifact, so a real report can never
      // be mistaken for a synthetic one (invariant 42.14).
      corpusTier: ['APPROVED_REAL'],
      pipelineTestAssetsIncluded: 0,
    },

    execution: {
      offlinePipelineMode: !denoAvailable ? 'BLOCKED_DENO_UNAVAILABLE' : fixtures.length === 0 ? 'NO_FIXTURES' : 'RAN',
      replayStatus: replay.status,
      replayRecordCount: replay.records.length,
      // Mission section 32. Not a configurable knob.
      liveMode: 'BLOCKED_PROVIDER_AUTHORIZATION',
      authorizedLiveEvaluationSpendUsd: AUTHORIZED_LIVE_EVALUATION_SPEND_USD,
      candidateSource:
        replay.records.length === 0
          ? 'NONE: the Scanner has not been run against this corpus, so every fixture carries an empty candidate ' +
            'list and scores as UNKNOWN / insufficient evidence. That is the honest state, not a result.'
          : 'REPLAY',
    },

    metrics: {
      identity,
      // V2: FMQ remains the sole scoring authority (identity/substitute
      // above are its own, unmodified output). This is a deterministic
      // TRANSLATION of that output into the shared match-truth doctrine
      // (lib/matchTruth.js) - not a second scorer.
      matchTruth,
      substitute: fmqlMetrics
        ? {
            distribution: fmqlMetrics.substituteDistribution,
            n: fmqlMetrics.sampleCounts.headlineEligible,
            denominatorBasis:
              'ALL_EVALUATED_REAL_CASES with authoritative ground truth. Substitute quality does not require exact ' +
              'identity - "is this a useful thing to buy instead" is answerable without knowing the SKU.',
          }
        : null,
      fashionComponentAverages: fmqlMetrics ? fmqlMetrics.fashionComponentAverages : null,
      duplicateMetrics: fmqlMetrics ? fmqlMetrics.duplicateMetrics : null,
      retailerNeutralityMetrics: fmqlMetrics ? fmqlMetrics.retailerNeutralityMetrics : null,
      captureProfileStratification: fmqlMetrics ? fmqlMetrics.captureProfileStratification : null,
      byCategory: stratify(evaluations, fixturesById, (fixture) => [fixture?.groundTruth?.category ?? 'unknown']),
      byDifficultyStratum: stratify(evaluations, fixturesById, (fixture) => fixture?.realCorpusMeta?.difficultyStrata ?? []),
      byDevicePlatform: stratify(evaluations, fixturesById, (fixture) => [fixture?.realCorpusMeta?.devicePlatform ?? 'unknown']),
    },

    claimDiscipline: claims,

    benchmarkStatus: BENCHMARK_STATUS,
    internalOnlyClause:
      'INTERNAL ENGINEERING EVIDENCE ONLY. Not production-traffic accuracy, not population-representative accuracy, ' +
      'not customer satisfaction, and not usable in marketing, App Store, investor or competitive material. No ' +
      'comparison against any incumbent or competitor may be drawn from this corpus (mission section 39).',
    trainingClause:
      'This is a DEVELOPMENT/HOLDOUT EVALUATION SET. It is not a training set and no model training is authorized ' +
      '(mission section 22).',
  };

  if (holdoutAudit) report.holdoutInvocation = holdoutAudit;

  assertPrivacySafe(report, 'real-corpus-evaluation-report');
  report.contentHash = canonicalHash(stripVolatile(report, ['generatedAt']));
  return report;
}

/** Count cases per key, used by the claim map. */
function stratifyCounts(cases, garmentsById, keyFn) {
  const counts = {};
  for (const record of cases) {
    const garment = garmentsById.get(record.garmentId);
    if (!garment) continue;
    for (const key of keyFn(garment, record)) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

module.exports = {
  EVALUATION_MODES,
  runEvaluation,
  identityMetrics,
  currentSourceSha,
  CATEGORIES,
  DIFFICULTY_STRATA,
};
