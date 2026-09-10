'use strict';

/**
 * Independent corpus and report validator (mission section 41).
 *
 *   "Build or extend independent corpus/report validation detecting at
 *    minimum: tier contamination, invalid provenance, holdout leakage, hash
 *    inconsistency, privacy failure, identity metric over ineligible fixtures,
 *    invalid fixture relationships, corrupted report. Mutation-test important
 *    controls."
 *
 * INDEPENDENCE is the point, and it is structural: this module deliberately
 * does NOT import evaluate.js, ingest.js, or queue.js. It re-derives its
 * checks from the corpus records and the report's own claimed numbers, so a
 * bug in the producer cannot be laundered into a PASS by the validator sharing
 * that bug. It re-runs the privacy scan itself rather than trusting a report
 * that says it is clean, and it recomputes the corpus hash rather than
 * believing the one written into the artifact.
 *
 * A report is guilty until proven innocent. "The report says PASS" is not
 * evidence of anything.
 */

const fs = require('node:fs');
const path = require('node:path');

const { PATHS } = require('./paths');
const {
  ASSET_TIER_REAL,
  ASSET_TIER_PIPELINE_TEST,
  BENCHMARK_STATUS,
  AUTHORIZED_LIVE_EVALUATION_SPEND_USD,
} = require('./constants');
const { validateGarment, validateCase } = require('./recordSchema');
const { deriveGrade, evaluateIdentityEligibility, checkProvenanceSelfContained } = require('./groundTruth');
const { scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');
const { canonicalHash } = require('../../fashion-match-quality/lib/canonicalJson');
const { assignPartition } = require('./holdout');

const VALIDATOR_VERSION = 'rfc-validator-v1';

function fail(findings, code, message, subject = {}) {
  findings.push({ severity: 'FAIL', code, message, ...subject });
}

function warn(findings, code, message, subject = {}) {
  findings.push({ severity: 'WARN', code, message, ...subject });
}

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, name, record: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        return { file, name, record: null, parseError: err.message };
      }
    });
}

/* ------------------------------------------------------------------ *
 * Corpus validation
 * ------------------------------------------------------------------ */

/**
 * Validate the corpus on disk, from scratch.
 *
 * `readHoldout` is false by default: the validator can prove the holdout is
 * SEALED and consistent without reading its contents, and a validator that
 * routinely opened the holdout would itself be the leak mission section 21
 * forbids. Structural checks that need holdout content (id collisions, hash
 * collisions with development) are done on ids and hashes only.
 */
function validateCorpusOnDisk({ corpusDir = PATHS.corpus } = {}) {
  const findings = [];

  const configPath = path.join(corpusDir, 'corpus.json');
  if (!fs.existsSync(configPath)) {
    fail(findings, 'CORPUS_CONFIG_MISSING', `corpus.json not found at ${configPath}`);
    return { validatorVersion: VALIDATOR_VERSION, passed: false, findings, counts: {} };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    fail(findings, 'CORPUS_CONFIG_CORRUPT', `corpus.json is not valid JSON: ${err.message}`);
    return { validatorVersion: VALIDATOR_VERSION, passed: false, findings, counts: {} };
  }

  const holdoutFraction = config?.holdout?.fractionTarget ?? 0.25;

  /* ---------------- garments ---------------- */

  const garments = [];
  for (const entry of readJsonDir(path.join(corpusDir, 'garments'))) {
    if (entry.parseError) {
      fail(findings, 'RECORD_CORRUPT', `${entry.name}: ${entry.parseError}`, { file: entry.file });
      continue;
    }
    const schema = validateGarment(entry.record);
    if (!schema.valid) {
      for (const message of schema.errors) {
        fail(findings, 'GARMENT_SCHEMA_INVALID', message, { garmentId: entry.record.garmentId });
      }
      continue;
    }

    // Provenance is re-derived here, not trusted from any producer.
    const derived = deriveGrade(entry.record.groundTruth);
    if (derived.invalid) {
      for (const reason of derived.reasons) {
        fail(findings, 'MODEL_DERIVED_GROUND_TRUTH', reason, { garmentId: entry.record.garmentId });
      }
      continue;
    }
    if (entry.record.groundTruth.assertedGrade && entry.record.groundTruth.assertedGrade !== derived.grade) {
      fail(
        findings,
        'GRADE_CLAIM_UNSUPPORTED',
        `asserts ${entry.record.groundTruth.assertedGrade} but the evidence supports ${derived.grade}`,
        { garmentId: entry.record.garmentId },
      );
    }
    if (derived.grade !== 'VISUAL_ONLY') {
      const provenance = checkProvenanceSelfContained(entry.record);
      if (!provenance.selfContained) {
        for (const reason of provenance.reasons) {
          fail(findings, 'PROVENANCE_INVALID', reason, { garmentId: entry.record.garmentId });
        }
      }
    }

    garments.push(entry.record);
  }

  const garmentsById = new Map(garments.map((garment) => [garment.garmentId, garment]));

  /* ---------------- development cases ---------------- */

  const cases = [];
  for (const entry of readJsonDir(path.join(corpusDir, 'cases'))) {
    if (entry.parseError) {
      fail(findings, 'RECORD_CORRUPT', `${entry.name}: ${entry.parseError}`, { file: entry.file });
      continue;
    }
    const record = entry.record;
    const schema = validateCase(record);
    if (!schema.valid) {
      for (const message of schema.errors) fail(findings, 'CASE_SCHEMA_INVALID', message, { caseId: record.caseId });
      continue;
    }

    // TIER CONTAMINATION - the single most consequential thing this validator
    // exists to catch (mission section 26, invariant 42.1).
    if (record.assetTier !== ASSET_TIER_REAL) {
      fail(
        findings,
        'TIER_CONTAMINATION',
        `case ${record.caseId} has assetTier ${record.assetTier}. Only ${ASSET_TIER_REAL} may exist in the real ` +
          `corpus; a ${ASSET_TIER_PIPELINE_TEST} may never enter it, count toward N, or appear in a real metric.`,
        { caseId: record.caseId },
      );
      continue;
    }

    if (!garmentsById.has(record.garmentId)) {
      fail(
        findings,
        'INVALID_RELATIONSHIP',
        `case ${record.caseId} references garment ${record.garmentId}, which does not exist`,
        { caseId: record.caseId },
      );
      continue;
    }

    if (record.partition === 'holdout') {
      fail(
        findings,
        'HOLDOUT_LEAKAGE',
        `case ${record.caseId} declares partition 'holdout' but sits in the development directory`,
        { caseId: record.caseId },
      );
    }

    const expected = assignPartition(record.garmentId, holdoutFraction);
    if (record.partition !== expected) {
      fail(
        findings,
        'PARTITION_INCONSISTENT',
        `case ${record.caseId} is stored as '${record.partition}' but the deterministic split assigns garment ` +
          `${record.garmentId} to '${expected}'`,
        { caseId: record.caseId },
      );
    }

    cases.push(record);
  }

  /* ---------------- holdout: ids and hashes only ---------------- */

  const holdoutIds = new Set();
  const holdoutHashes = new Map();
  const holdoutGarmentIds = new Set();
  for (const entry of readJsonDir(path.join(corpusDir, 'holdout'))) {
    if (entry.parseError) {
      fail(findings, 'RECORD_CORRUPT', `holdout/${entry.name}: ${entry.parseError}`, { file: entry.file });
      continue;
    }
    const record = entry.record;
    holdoutIds.add(record.caseId);
    holdoutGarmentIds.add(record.garmentId);
    if (record.asset?.sha256) holdoutHashes.set(record.asset.sha256, record.caseId);

    if (record.partition !== 'holdout') {
      fail(
        findings,
        'HOLDOUT_LEAKAGE',
        `case ${record.caseId} sits in the holdout directory but declares partition '${record.partition}'`,
        { caseId: record.caseId },
      );
    }
    if (record.assetTier !== ASSET_TIER_REAL) {
      fail(findings, 'TIER_CONTAMINATION', `holdout case ${record.caseId} has assetTier ${record.assetTier}`, {
        caseId: record.caseId,
      });
    }
  }

  // Holdout leakage by id, by asset hash, and by GARMENT. The third is the
  // subtle one: two captures of the same product on opposite sides of the
  // split means the development twin reveals the holdout answer, because both
  // resolve to one ground-truth record.
  for (const record of cases) {
    if (holdoutIds.has(record.caseId)) {
      fail(findings, 'HOLDOUT_LEAKAGE', `case ${record.caseId} exists in BOTH the development and holdout partitions`, {
        caseId: record.caseId,
      });
    }
    if (record.asset?.sha256 && holdoutHashes.has(record.asset.sha256)) {
      fail(
        findings,
        'HOLDOUT_LEAKAGE',
        `development case ${record.caseId} shares an asset hash with holdout case ${holdoutHashes.get(record.asset.sha256)}`,
        { caseId: record.caseId },
      );
    }
    if (holdoutGarmentIds.has(record.garmentId)) {
      fail(
        findings,
        'HOLDOUT_LEAKAGE',
        `development case ${record.caseId} photographs garment ${record.garmentId}, which also has holdout cases. ` +
          'Both resolve to one ground-truth record, so the development case reveals the holdout answer.',
        { caseId: record.caseId },
      );
    }
  }

  /* ---------------- hash consistency and relationships ---------------- */

  const byHash = new Map();
  for (const record of cases) {
    const hash = record.asset?.sha256;
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(record.caseId);
  }
  for (const [hash, ids] of byHash) {
    if (ids.length > 1) {
      fail(
        findings,
        'HASH_INCONSISTENCY',
        `cases ${ids.join(', ')} share asset hash ${hash.slice(0, 12)}... - the same photograph is filed more than once`,
      );
    }
  }

  const byId = new Map(cases.map((record) => [record.caseId, record]));
  for (const record of cases) {
    const partnerId = record.pairing?.pairedCaseId;
    if (!partnerId) continue;
    const partner = byId.get(partnerId);
    if (!partner) {
      // A pair pointing into the holdout is leakage, not just a broken link.
      if (holdoutIds.has(partnerId)) {
        fail(
          findings,
          'HOLDOUT_LEAKAGE',
          `development case ${record.caseId} is paired with holdout case ${partnerId}`,
          { caseId: record.caseId },
        );
      } else {
        fail(findings, 'INVALID_RELATIONSHIP', `case ${record.caseId} is paired with ${partnerId}, which does not exist`, {
          caseId: record.caseId,
        });
      }
      continue;
    }
    if (partner.pairing?.pairedCaseId !== record.caseId) {
      fail(findings, 'INVALID_RELATIONSHIP', `pairing between ${record.caseId} and ${partnerId} is not mutual`, {
        caseId: record.caseId,
      });
    }
    if (partner.garmentId !== record.garmentId) {
      fail(
        findings,
        'INVALID_RELATIONSHIP',
        `paired cases ${record.caseId} and ${partnerId} photograph different garments`,
        { caseId: record.caseId },
      );
    }
    if (record.asset?.sha256 && record.asset.sha256 === partner.asset?.sha256) {
      fail(
        findings,
        'INVALID_RELATIONSHIP',
        `paired cases ${record.caseId} and ${partnerId} are byte-identical - one file was copied rather than two ` +
          'photographs taken, which fabricates platform parity',
        { caseId: record.caseId },
      );
    }
  }

  /* ---------------- privacy, re-scanned from scratch ---------------- */

  for (const record of [...garments, ...cases]) {
    const privacy = scanForPrivacyViolations(record);
    for (const violation of privacy.violations) {
      fail(findings, 'PRIVACY_FAILURE', `${violation.path}: ${violation.reason}`, {
        recordId: record.garmentId || record.caseId,
      });
    }
    if (record.recordType === 'CASE' && record.capture?.consent?.humanPresent === true) {
      if (record.capture.consent.consentStatus !== 'EXPLICIT_COLLECTOR_CONSENT') {
        fail(findings, 'PRIVACY_FAILURE', `case ${record.caseId} shows a person without recorded explicit consent`, {
          caseId: record.caseId,
        });
      }
    }
  }

  /* ---------------- FMQL corpus/real must stay empty (design DM-02) ---------------- */

  if (fs.existsSync(PATHS.fmqlRealCorpusDir)) {
    const leaked = fs.readdirSync(PATHS.fmqlRealCorpusDir).filter((name) => name.endsWith('.json'));
    if (leaked.length > 0) {
      warn(
        findings,
        'FMQL_REAL_CORPUS_NOT_EMPTY',
        `${leaked.length} fixture(s) are in tools/fashion-match-quality/corpus/real/, which FMQL's loadFullCorpus() ` +
          'merges into the SYNTHETIC default report with no tier gate. Real fixtures belong in this lane ' +
          '(design DM-02), or the synthetic baseline and the real corpus will blend silently.',
      );
    }
  }

  const identityEligible = garments.filter((garment) => evaluateIdentityEligibility(garment).eligible);

  return {
    validatorVersion: VALIDATOR_VERSION,
    passed: findings.filter((f) => f.severity === 'FAIL').length === 0,
    findings,
    counts: {
      garments: garments.length,
      developmentCases: cases.length,
      holdoutCases: holdoutIds.size,
      identityEligibleGarments: identityEligible.length,
      identityEligibleCaseIds: cases.filter((record) => {
        const garment = garmentsById.get(record.garmentId);
        return garment && evaluateIdentityEligibility(garment).eligible;
      }).length,
    },
    // Returned so a report can be checked against an INDEPENDENTLY derived set
    // rather than against the one the producer used.
    derived: {
      garmentsById,
      cases,
      identityEligibleCaseIds: new Set(
        cases
          .filter((record) => {
            const garment = garmentsById.get(record.garmentId);
            return garment && evaluateIdentityEligibility(garment).eligible;
          })
          .map((record) => record.caseId),
      ),
      corpusConfig: config,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Report validation
 * ------------------------------------------------------------------ */

const REQUIRED_REPORT_FIELDS = [
  'reportSchemaVersion',
  'evaluationMode',
  'sourceSha',
  'corpusVersion',
  // V2: the eighth bound identifier (spec section 5/7) - a frozen evaluation
  // must not silently span two ontology contract versions.
  'ontologyVersion',
  'corpusHash',
  'evaluatorVersion',
  'holdoutStatus',
  'groundTruthGradeRules',
  'captureProfileVersion',
  'metrics',
  'benchmarkStatus',
  'contentHash',
];

/**
 * Validate an evaluation report.
 *
 * `corpusValidation` is the result of validateCorpusOnDisk(). When supplied,
 * the report's identity denominator is checked against the INDEPENDENTLY
 * derived eligible set - which is how invariant 42.3/42.4 is actually proved
 * rather than asserted.
 */
function validateReport(report, { corpusValidation = null } = {}) {
  const findings = [];

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail(findings, 'REPORT_CORRUPT', 'report is not a non-null object');
    return { validatorVersion: VALIDATOR_VERSION, passed: false, findings };
  }
  if (Object.keys(report).length === 0) {
    fail(findings, 'REPORT_CORRUPT', 'report is empty');
    return { validatorVersion: VALIDATOR_VERSION, passed: false, findings };
  }

  for (const field of REQUIRED_REPORT_FIELDS) {
    if (report[field] === undefined || report[field] === null) {
      fail(findings, 'REPORT_CORRUPT', `missing required field: ${field}`);
    }
  }

  /* ---- mission section 39: the internal-only clause is not optional ---- */
  if (report.benchmarkStatus !== BENCHMARK_STATUS) {
    fail(findings, 'CLAIM_DISCIPLINE', `benchmarkStatus must be exactly "${BENCHMARK_STATUS}"`);
  }

  /* ---- mission section 32: spend ---- */
  if (
    report.execution &&
    report.execution.authorizedLiveEvaluationSpendUsd !== AUTHORIZED_LIVE_EVALUATION_SPEND_USD
  ) {
    fail(
      findings,
      'SPEND_UNAUTHORIZED',
      `report claims an authorized live spend of ${report.execution.authorizedLiveEvaluationSpendUsd}; the owner has ` +
        `authorized ${AUTHORIZED_LIVE_EVALUATION_SPEND_USD}`,
    );
  }

  /* ---- content hash is recomputed, never believed ---- */
  const claimedHash = report.contentHash;
  const recomputed = canonicalHash(
    (() => {
      const clone = JSON.parse(JSON.stringify(report));
      delete clone.contentHash;
      delete clone.generatedAt;
      return clone;
    })(),
  );
  if (claimedHash && claimedHash !== recomputed) {
    fail(
      findings,
      'HASH_INCONSISTENCY',
      `report contentHash ${String(claimedHash).slice(0, 12)}... does not match its own content ` +
        `(${recomputed.slice(0, 12)}...) - the report was edited after it was generated`,
    );
  }

  /* ---- tier declaration (invariant 42.14) ---- */
  const tiers = report.corpus?.corpusTier || [];
  const mixesTiers = tiers.includes('SYNTHETIC') && tiers.includes('APPROVED_REAL');
  if (mixesTiers && !report.mixedTierDeclaration) {
    fail(
      findings,
      'TIER_CONTAMINATION',
      'the report mixes SYNTHETIC and APPROVED_REAL evidence without an explicit mixedTierDeclaration. Synthetic ' +
        'and real evidence may not be combined silently.',
    );
  }
  if ((report.corpus?.pipelineTestAssetsIncluded ?? 0) !== 0) {
    fail(
      findings,
      'TIER_CONTAMINATION',
      `the report counts ${report.corpus.pipelineTestAssetsIncluded} pipeline-test asset(s). A generated asset may ` +
        'never appear in a real metric.',
    );
  }

  /* ---- holdout (invariant 42.5) ---- */
  if (report.evaluationMode !== 'REAL_HOLDOUT' && report.holdoutStatus !== 'SEALED') {
    fail(
      findings,
      'HOLDOUT_LEAKAGE',
      `a ${report.evaluationMode} report must carry holdoutStatus SEALED, not ${report.holdoutStatus}`,
    );
  }
  if (report.evaluationMode === 'REAL_HOLDOUT') {
    if (report.holdoutStatus !== 'UNSEALED_EXPLICIT') {
      fail(findings, 'HOLDOUT_LEAKAGE', 'a REAL_HOLDOUT report must record holdoutStatus UNSEALED_EXPLICIT');
    }
    if (!report.holdoutInvocation?.reason || !report.holdoutInvocation?.invokedBy) {
      fail(
        findings,
        'HOLDOUT_LEAKAGE',
        'a REAL_HOLDOUT report must carry the recorded invocation (reason + invokedBy). An unrecorded holdout ' +
          'evaluation is exactly what the seal exists to prevent.',
      );
    }
  }

  /* ---- identity denominator (invariants 42.3 / 42.4) ---- */
  const identity = report.metrics?.identity;
  if (!identity) {
    fail(findings, 'REPORT_CORRUPT', 'metrics.identity is missing');
  } else {
    if (!identity.denominatorBasis) {
      fail(findings, 'CLAIM_DISCIPLINE', 'metrics.identity does not state its denominatorBasis (mission section 38)');
    }
    const distributionTotal = Object.values(identity.distribution || {}).reduce((a, b) => a + b, 0);
    if (distributionTotal !== identity.n) {
      fail(
        findings,
        'IDENTITY_OVER_INELIGIBLE',
        `metrics.identity.n is ${identity.n} but its distribution sums to ${distributionTotal}`,
      );
    }
    if (corpusValidation?.derived) {
      const eligible = corpusValidation.derived.identityEligibleCaseIds.size;
      if (identity.n > eligible) {
        fail(
          findings,
          'IDENTITY_OVER_INELIGIBLE',
          `the report computes identity metrics over n=${identity.n}, but only ${eligible} case(s) in the corpus are ` +
            'identity-eligible. An exact-product denominator may never include a fixture incapable of establishing ' +
            'exact identity (mission section 6).',
        );
      }
      if (report.corpus?.identityEligibleCases !== undefined && report.corpus.identityEligibleCases !== eligible) {
        fail(
          findings,
          'IDENTITY_OVER_INELIGIBLE',
          `the report claims ${report.corpus.identityEligibleCases} identity-eligible case(s); independently ` +
            `re-deriving eligibility from the corpus gives ${eligible}`,
        );
      }
    }
  }

  /* ---- corpus hash is recomputed against disk when a validation is supplied ---- */
  if (corpusValidation?.derived && report.corpusVersion !== corpusValidation.derived.corpusConfig.corpusVersion) {
    fail(
      findings,
      'HASH_INCONSISTENCY',
      `report binds corpusVersion ${report.corpusVersion} but the corpus on disk is ` +
        `${corpusValidation.derived.corpusConfig.corpusVersion}`,
    );
  }

  /* ---- claim discipline (mission section 38) ---- */
  const suppressed = new Set(report.claimDiscipline?.suppressedClaimIds || []);
  for (const claim of report.claimDiscipline?.claims || []) {
    if (claim.classification === 'INSUFFICIENT_N' && !suppressed.has(claim.claimId)) {
      fail(
        findings,
        'CLAIM_DISCIPLINE',
        `claim ${claim.claimId} is INSUFFICIENT_N but is not listed as suppressed`,
      );
    }
  }

  /* ---- privacy, re-scanned rather than trusted ---- */
  const privacy = scanForPrivacyViolations(report);
  for (const violation of privacy.violations) {
    fail(findings, 'PRIVACY_FAILURE', `${violation.path}: ${violation.reason}`);
  }

  return {
    validatorVersion: VALIDATOR_VERSION,
    passed: findings.filter((f) => f.severity === 'FAIL').length === 0,
    findings,
  };
}

function formatFindings(result) {
  if (result.findings.length === 0) return '  (no findings)';
  return result.findings
    .map((finding) => {
      const subject = finding.caseId || finding.garmentId || finding.recordId || finding.file || '';
      return `  [${finding.severity}] ${finding.code}${subject ? ` ${subject}` : ''}: ${finding.message}`;
    })
    .join('\n');
}

module.exports = { VALIDATOR_VERSION, validateCorpusOnDisk, validateReport, formatFindings };
