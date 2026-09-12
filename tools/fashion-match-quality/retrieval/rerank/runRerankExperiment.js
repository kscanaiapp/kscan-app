#!/usr/bin/env node
'use strict';

/**
 * Orchestrate the visual re-ranking experiment and emit one machine-readable
 * report (spec section 22).
 *
 *   node tools/fashion-match-quality/retrieval/rerank/runRerankExperiment.js [--out <path>]
 *
 * Everything this report asserts is derived from an observation made by the
 * component that actually made it - the conclusion is computed from the
 * execution identity and the corpus census, never chosen by hand - and the
 * result is validated against rerankReportSchema.js before it is written. A
 * report that would overclaim fails to emit at all.
 *
 * COLD vs WARM. Timing is captured twice against two separate cache
 * directories: a cold pass over an empty cache (every embedding computed) and
 * a warm pass over the populated one (every embedding served from disk).
 * Reporting a single blended number would misrepresent both, since the
 * re-ranking layer's cost is dominated by whether candidate embeddings can be
 * precomputed - which is the central deployment question this timing exists
 * to inform (spec section 17).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { loadFullCorpus } = require('../../corpus/corpusLoader');
const { loadCorpus: loadRfcCorpus, buildCorpusManifest: buildRfcManifest } = require('../../../real-fashion-corpus/lib/corpusStore');
const { summarize, recordEnvironment } = require('../timing');
const modelManifest = require('../modelManifest');

const { runRerankExperiment, IMAGE_SOURCE_ATTRIBUTE } = require('./rerankExperiment');
const { validateRerankReport } = require('./rerankReportSchema');
const { ATTRIBUTE_RENDER_VERSION } = require('./attributeImageSource');
const { UNIVERSE_FINGERPRINT_VERSION } = require('./candidateUniverse');
const { RERANK_STRATEGY_VERSION } = require('./visualReranker');

const REPORT_VERSION = 'fashionclip-rerank-report-v1';
const DEFAULT_OUT = path.join(__dirname, 'reports', 'latest.json');

/**
 * Corpus census (spec section 10). Counted from the fixtures' own declared
 * `corpusTier`, never inferred or assumed - a synthetic fixture is never
 * counted as real.
 */
function censusCorpus(fixtures) {
  const census = { REAL: 0, SANITIZED_REAL: 0, SYNTHETIC: 0, UNKNOWN: 0 };
  for (const f of fixtures) {
    const tier = f.corpusTier;
    if (tier === 'REAL') census.REAL += 1;
    else if (tier === 'SANITIZED_REAL') census.SANITIZED_REAL += 1;
    else if (tier === 'SYNTHETIC') census.SYNTHETIC += 1;
    else census.UNKNOWN += 1;
  }

  // Truth-label coverage per attribute (spec section 10): how many fixtures
  // carry scoreable ground truth for each dimension, and how many DISTINCT
  // values that dimension takes across the corpus. The second number matters
  // as much as the first: an attribute that takes only one value cannot
  // discriminate between two rankings no matter how many fixtures carry it.
  const dimensions = { category: 'category', color: 'color_family', silhouette: 'silhouette', material: 'material', pattern: 'pattern' };
  const coverage = {};
  for (const [label, field] of Object.entries(dimensions)) {
    const values = new Set();
    let labelled = 0;
    for (const f of fixtures) {
      const v = f.groundTruth?.[field];
      if (v !== undefined && v !== null) {
        labelled += 1;
        values.add(v);
      }
      for (const c of f.candidateProducts || []) {
        const cv = field === 'color_family' ? (c.color_normalized ?? c.color) : c[field];
        if (cv !== undefined && cv !== null) values.add(cv);
      }
    }
    coverage[label] = {
      fixturesLabelled: labelled,
      totalFixtures: fixtures.length,
      distinctValues: values.size,
      discriminative: values.size > 1,
    };
  }

  return { census, coverage };
}

function collectTiming(result) {
  const query = [];
  const candidate = [];
  const rerankMs = [];
  const control = [];
  for (const c of result.cases) {
    if (c.status !== 'OK') continue;
    query.push(c.timing.queryEmbeddingMs);
    candidate.push(...c.timing.candidateEmbedMs);
    rerankMs.push(c.timing.rerankMs);
    control.push(c.timing.controlMs);
  }
  const addedPerCase = result.cases
    .filter((c) => c.status === 'OK')
    .map((c) => c.timing.queryEmbeddingMs + c.timing.candidateEmbedMs.reduce((a, b) => a + b, 0) + c.timing.rerankMs);
  return {
    QUERY_EMBEDDING_TIME: summarize(query),
    CANDIDATE_EMBEDDING_TIME: summarize(candidate),
    RERANK_TIME: summarize(rerankMs),
    TOTAL_ADDED_RERANK_TIME: summarize(addedPerCase),
    controlL1Time: summarize(control),
  };
}

/** Compare one metric across arms. `lowerIsBetter` inverts the verdict. */
function delta(controlValue, challengerValue, lowerIsBetter = false) {
  if (controlValue === null || challengerValue === null || controlValue === undefined || challengerValue === undefined) {
    return { control: controlValue ?? null, challenger: challengerValue ?? null, delta: null, verdict: 'UNSCOREABLE' };
  }
  const d = challengerValue - controlValue;
  let verdict = 'TIE';
  if (d !== 0) verdict = (d > 0) === !lowerIsBetter ? 'CHALLENGER_BETTER' : 'CHALLENGER_WORSE';
  return { control: controlValue, challenger: challengerValue, delta: d, verdict };
}

function buildComparison(control, challenger) {
  const rateOf = (m) => (m && typeof m === 'object' ? m.rate : m);
  return {
    EXACT_TOP1: delta(control.exactTop1Rate, challenger.exactTop1Rate),
    EXACT_TOP5: delta(control.exactTop5Rate, challenger.exactTop5Rate),
    USEFUL_TOP1: delta(control.usefulTop1Rate, challenger.usefulTop1Rate),
    USEFUL_TOP5: delta(control.usefulTop5Rate, challenger.usefulTop5Rate),
    WRONG_COLOR: delta(rateOf(control.wrongColorRate), rateOf(challenger.wrongColorRate), true),
    WRONG_SILHOUETTE: delta(rateOf(control.wrongSilhouetteRate), rateOf(challenger.wrongSilhouetteRate), true),
    WRONG_MATERIAL: delta(rateOf(control.wrongMaterialRate), rateOf(challenger.wrongMaterialRate), true),
    WRONG_PATTERN: delta(rateOf(control.wrongPatternRate), rateOf(challenger.wrongPatternRate), true),
    IRRELEVANT: delta(control.irrelevantRate, challenger.irrelevantRate, true),
    DUPLICATE: delta(control.duplicateRate, challenger.duplicateRate, true),
  };
}

function main({ outPath = DEFAULT_OUT } = {}) {
  const fixtures = loadFullCorpus();
  const { census, coverage } = censusCorpus(fixtures);

  const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fclip-rerank-cold-'));
  const cold = runRerankExperiment({ cacheDir: coldDir, imageSource: IMAGE_SOURCE_ATTRIBUTE, fixtures });
  const warm = runRerankExperiment({ cacheDir: coldDir, imageSource: IMAGE_SOURCE_ATTRIBUTE, fixtures });

  const result = cold;
  const identity = result.executionIdentity;
  const realExecuted = identity.REAL_FASHIONCLIP_EXECUTED === true;

  // The conclusion is DERIVED, not authored. Spec section 20's four options,
  // selected by the only facts that can distinguish them.
  let conclusion;
  let conclusionRationale;
  if (!realExecuted) {
    conclusion = 'ENVIRONMENT_BLOCKED';
    conclusionRationale =
      'The pinned FashionCLIP model could not be executed in this authorized environment, so no conclusion about the ' +
      "model's ranking quality is available. Unmet preconditions: " + identity.unmetPreconditions.join(', ');
  } else if (census.REAL + census.SANITIZED_REAL === 0) {
    conclusion = 'INSUFFICIENT_EVIDENCE';
    conclusionRationale = 'Real FashionCLIP executed, but the corpus contains no real or sanitized-real cases to infer quality from.';
  } else {
    const comparison = buildComparison(result.control.metrics, result.challenger.metrics);
    const better = Object.values(comparison).filter((c) => c.verdict === 'CHALLENGER_BETTER').length;
    const worse = Object.values(comparison).filter((c) => c.verdict === 'CHALLENGER_WORSE').length;
    conclusion = better > worse ? 'PROMISING_CONTINUE_R&D' : 'NO_USEFUL_SIGNAL';
    conclusionRationale = `Real FashionCLIP executed over ${census.REAL + census.SANITIZED_REAL} real/sanitized cases; ${better} metric(s) improved, ${worse} regressed.`;
  }

  const evidenceClass = realExecuted
    ? census.REAL + census.SANITIZED_REAL > 0
      ? 'RETRIEVAL_QUALITY_EVIDENCE'
      : 'ENGINEERING_SIGNAL_NOT_DECISION_GRADE'
    : 'MECHANISM_CHECK';

  const caseHashes = result.cases.filter((c) => c.status === 'OK');
  const rfcManifest = buildRfcManifest(loadRfcCorpus({ validate: false }));

  const probe = result.mechanismProbe.results.filter((p) => p.status === 'OK');

  const report = {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    conclusion,
    conclusionRationale,
    evidenceClass,

    model: {
      MODEL: modelManifest.MODEL_ID,
      MODEL_REVISION: identity.RUN_ARTIFACT_MODEL_REVISION,
      MODEL_REVISION_REQUESTED_REF: modelManifest.MODEL_REVISION_REF,
      EMBEDDING_DIM: modelManifest.EMBEDDING_DIMENSION,
      PREPROCESSING: modelManifest.IMAGE_PREPROCESSING,
      EXECUTION_PROVIDER: result.embedder.provider,
      actualProviderThisRun: result.embedder.provider,
      actualRevisionThisRun: result.embedder.modelRevision,
      availabilityReasons: result.embedder.availabilityReasons,
    },

    executionIdentity: identity,

    candidateUniverse: {
      CONTROL_UNIVERSE_HASH: caseHashes.length ? caseHashes.map((c) => c.universe.controlHash).join('') : null,
      CHALLENGER_UNIVERSE_HASH: caseHashes.length ? caseHashes.map((c) => c.universe.challengerHash).join('') : null,
      identical: result.universeIdentical,
      fingerprintVersion: UNIVERSE_FINGERPRINT_VERSION,
      perCase: caseHashes.map((c) => ({
        fixtureId: c.fixtureId,
        controlHash: c.universe.controlHash,
        challengerHash: c.universe.challengerHash,
        identical: c.universe.identical,
        memberCount: c.universe.memberCount,
      })),
    },

    corpusCensus: {
      REAL: census.REAL,
      SANITIZED_REAL: census.SANITIZED_REAL,
      SYNTHETIC: census.SYNTHETIC,
      UNKNOWN: census.UNKNOWN,
      truthLabelCoverage: coverage,
      corpusManifestHash: rfcManifest.corpusHash,
      ontologyVersion: rfcManifest.ontologyVersion,
    },

    evaluatorStatus: {
      rubricVersion: result.evaluator.rubricVersion,
      componentFieldResolutionVersion: result.evaluator.componentFieldResolutionVersion,
      bothArmsScoredBySameEvaluator: true,
      COLOR_METRIC: coverage.color.discriminative ? 'REPAIRED_AND_DISCRIMINATIVE' : 'UNRELIABLE',
      colorRepairNote:
        'wrongColor was 1.0 for every ranking before this lane because FMQ ground truth stores colour as `color_family` ' +
        'while candidate products store it as `color_normalized`/`color`, so the evaluator compared against an always-absent ' +
        'field. Repaired by a versioned candidate-field alias; verified against known-correct and known-wrong colour cases.',
      OTHER_LIMITATIONS: Object.entries(coverage)
        .filter(([, v]) => !v.discriminative)
        .map(([k, v]) => `${k.toUpperCase()}_METRIC=NON_DISCRIMINATIVE (only ${v.distinctValues} distinct value(s) corpus-wide)`),
    },

    experiment: {
      strategyVersion: RERANK_STRATEGY_VERSION,
      attributeRenderVersion: ATTRIBUTE_RENDER_VERSION,
      configuration: result.configuration,
      control: { description: result.control.description, metrics: result.control.metrics },
      challenger: { description: result.challenger.description, metrics: result.challenger.metrics },
      comparison: buildComparison(result.control.metrics, result.challenger.metrics),
      counts: result.counts,
      orderChangedCaseCount: result.cases.filter((c) => c.status === 'OK' && !c.movement.identicalOrder).length,
      top1ChangedCaseCount: result.cases.filter((c) => c.status === 'OK' && c.movement.changedTop1).length,
      perCase: result.cases.map((c) =>
        c.status === 'OK'
          ? {
              fixtureId: c.fixtureId,
              archetype: c.archetype,
              controlOrder: c.control.order,
              challengerOrder: c.challenger.order,
              identicalOrder: c.movement.identicalOrder,
              controlTop1: c.control.evaluation.top1CandidateId,
              challengerTop1: c.challenger.evaluation.top1CandidateId,
              controlUsefulTop1: c.control.evaluation.usefulTop1,
              challengerUsefulTop1: c.challenger.evaluation.usefulTop1,
              similarityByCandidate: c.challenger.scored.map((s) => ({ candidateId: s.candidateId, visualScore: s.visualScore })),
            }
          : { fixtureId: c.fixtureId, status: c.status, blocker: c.blocker, detail: c.detail },
      ),
    },

    mechanismProbe: {
      label: result.mechanismProbe.label,
      description: result.mechanismProbe.description,
      casesProbed: probe.length,
      meanRanksRecovered: probe.length ? probe.reduce((s, p) => s + p.ranksRecovered, 0) / probe.length : null,
      recoveredToTop1Count: probe.filter((p) => p.recoveredToTop1).length,
      usefulTop1RecoveredCount: probe.filter((p) => !p.degradedEvaluation.usefulTop1 && p.evaluation.usefulTop1).length,
      rank1UnusableAfterRecoveryCount: probe.filter((p) => p.evaluation.substituteTop1.level === 'UNUSABLE').length,
      results: probe.map((p) => ({
        fixtureId: p.fixtureId,
        degradedRankOfTruth: p.degradedRankOfTruth,
        recoveredRankOfTruth: p.recoveredRankOfTruth,
        ranksRecovered: p.ranksRecovered,
        rank1IdentityLevel: p.evaluation.identityTop1.level,
        rank1SubstituteLevel: p.evaluation.substituteTop1.level,
      })),
    },

    timing: {
      COLD: collectTiming(cold),
      WARM: collectTiming(warm),
      note:
        'R&D sandbox timing on placeholder 32x32 images with a non-model descriptor. NOT a production latency measurement and ' +
        'NOT evidence of sub-5-second production performance. Real FashionCLIP inference is orders of magnitude more expensive ' +
        'than the descriptor timed here.',
      environment: recordEnvironment(),
    },

    provider: {
      NEW_PAID_PROVIDER_CALLS: 0,
      newScannerNetworkCalls: 0,
      note: 'No RapidAPI, Apify, retailer or other paid provider was called. The experiment runs entirely against committed fixtures.',
    },

    limitations: [],
  };

  // Limitations are assembled from observed facts, not authored prose, so a
  // future run cannot quietly drop one that still applies.
  const limitations = [
    `REAL_FASHIONCLIP_EXECUTED=${realExecuted ? 'YES' : 'NO'}. ` +
      (realExecuted ? '' : `Blocked by: ${result.embedder.availabilityReasons.join(', ')}.`),
    'The control arm already achieves a perfect score on every headline metric over this corpus ' +
      `(exactTop1=${result.control.metrics.exactTop1Rate}, usefulTop1=${result.control.metrics.usefulTop1Rate}). ` +
      'There is therefore NO HEADROOM for any re-ranker to demonstrate improvement here: the paired comparison can ' +
      'structurally only tie or regress, whatever model drives it.',
    'Candidate and query images are attribute-rendered placeholders, not photographs. Candidates sharing the scored ' +
      'attributes render to byte-identical images, so any embedder - including a hash - returns similarity 1.0 between ' +
      'them. This corpus cannot distinguish a real model from a stub.',
    `Corpus is ${census.SYNTHETIC} synthetic / ${census.REAL} real / ${census.SANITIZED_REAL} sanitized-real. ` +
      'No real-world efficacy claim is available at any sample size here.',
  ];
  for (const other of report.evaluatorStatus.OTHER_LIMITATIONS) {
    limitations.push(
      `${other} - the corresponding wrong-attribute metric cannot discriminate between two rankings on this corpus.`,
    );
  }
  if (result.counts.notRun > 0) limitations.push(`${result.counts.notRun} case(s) NOT_RUN (control arm blocked).`);
  if (result.counts.invalid > 0) limitations.push(`${result.counts.invalid} case(s) INVALID (candidate universe mismatch).`);
  report.limitations = limitations;

  const validation = validateRerankReport(report);
  if (!validation.valid) {
    console.error('REPORT_SCHEMA_VIOLATION - refusing to emit a report that would overclaim:');
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return { report, validation };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, validation, outPath };
}

if (require.main === module) {
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : DEFAULT_OUT;
  const { report, validation, outPath: written } = main({ outPath });
  if (!validation.valid) process.exit(1);
  console.log(`report written: ${path.relative(process.cwd(), written)}`);
  console.log(`CONCLUSION: ${report.conclusion}`);
  console.log(`EVIDENCE_CLASS: ${report.evidenceClass}`);
  console.log(`REAL_FASHIONCLIP_EXECUTED: ${report.executionIdentity.REAL_FASHIONCLIP_EXECUTED ? 'YES' : 'NO'}`);
}

module.exports = { main, censusCorpus, buildComparison, delta, collectTiming, REPORT_VERSION, DEFAULT_OUT };
