'use strict';

/**
 * Live evaluation adapter — the Node orchestration half.
 *
 * The certified scanner runs in Deno (see adapter/deno/certifiedHarness.ts). This
 * side owns everything that is NOT certified scanner behaviour: preflight gates,
 * ceilings, resume, private persistence and sanitized aggregation. No certified
 * logic is reimplemented here.
 *
 * FAIL-CLOSED PREFLIGHT
 * Every gate below refuses execution rather than degrading. A paid run that
 * starts with a missing ceiling, a drifted snapshot or an unverifiable seal
 * cannot produce a defensible baseline, so it must not start at all.
 */

const fs = require('fs');
const path = require('path');

const certifiedSnapshot = require('./certifiedSnapshot');
const taxonomy = require('./errorTaxonomy');
const governedStorage = require('./governedStorage');
const { assertOutsideGit } = require('./imagePreparation');

const ADAPTER_VERSION = '1.0.0';

class PreflightRefused extends Error {
  constructor(gate, message) {
    super(`${gate}: ${message}`);
    this.name = 'PreflightRefused';
    this.gate = gate;
  }
}

/**
 * Read the owner-authorized ceilings.
 *
 * Absent is NOT zero and NOT unlimited — it is unauthorized. Both must be
 * present and positive before a single provider request may be made.
 */
function readCeilings(env = process.env) {
  const rawAttempts = env.KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS;
  const rawSpend = env.KSCAN_EVAL_SPEND_CEILING_USD;

  if (rawAttempts == null || String(rawAttempts).trim() === '') {
    throw new PreflightRefused('attempt_ceiling', 'KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS is not set; paid execution is unauthorized');
  }
  if (rawSpend == null || String(rawSpend).trim() === '') {
    throw new PreflightRefused('spend_ceiling', 'KSCAN_EVAL_SPEND_CEILING_USD is not set; paid execution is unauthorized');
  }

  const maxAttempts = Number(rawAttempts);
  const maxUsd = Number(rawSpend);
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new PreflightRefused('attempt_ceiling', 'must be a positive integer');
  }
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new PreflightRefused('spend_ceiling', 'must be a positive number');
  }
  return { maxAttempts, maxUsd };
}

/** The credential is checked for PRESENCE only. Its value is never read here. */
function requireCredential(env = process.env) {
  if (!env.GEMINI_API_KEY || String(env.GEMINI_API_KEY).trim() === '') {
    throw new PreflightRefused('credential', 'GEMINI_API_KEY is absent from the process environment');
  }
  return true;
}

/**
 * Prove the private output root is a safe destination BEFORE any paid call.
 *
 * Beneath the governed storage root, outside every Git worktree, writable, and
 * carrying an explicit retention expiry.
 */
function verifyPrivateOutputRoot(outputRoot, { storageRoot = process.env.KSCAN_EVAL_STORAGE_ROOT, retentionDays = 90, now = new Date() } = {}) {
  let resultsRoot;
  let imageRoot;
  try {
    resultsRoot = governedStorage.privateResultsRoot(null, storageRoot);
    imageRoot = governedStorage.governedImageRoot(storageRoot);
  } catch (error) {
    throw new PreflightRefused('storage_root', error.message);
  }
  const target = path.resolve(outputRoot);

  // Private results must never enter Git.
  assertOutsideGit(target);

  // Containment against the RESULTS root specifically — not merely "somewhere
  // under the common parent", which would permit writing into the source corpus.
  try {
    governedStorage.assertContained(target, resultsRoot, 'private output root');
  } catch (error) {
    throw new PreflightRefused('containment', error.message);
  }

  // Belt and braces: a results path must never land inside the governed corpus.
  const resolvedImageRoot = path.resolve(imageRoot);
  if (target === resolvedImageRoot || target.startsWith(resolvedImageRoot + path.sep)) {
    throw new PreflightRefused('root_collision', 'a run result would be written inside the governed image corpus');
  }

  fs.mkdirSync(target, { recursive: true });
  const probe = path.join(target, '.write-probe');
  try {
    fs.writeFileSync(probe, 'probe');
    fs.unlinkSync(probe);
  } catch (error) {
    throw new PreflightRefused('writable', `private output root is not writable: ${error.code || 'unknown'}`);
  }

  const retentionPath = path.join(target, 'retention.json');
  if (!fs.existsSync(retentionPath)) {
    const createdAt = new Date(now);
    const expiresAt = new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    fs.writeFileSync(
      retentionPath,
      `${JSON.stringify(
        {
          retentionDays,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          policy: 'Private evaluation run artifacts. Delete on expiry. Never committed, never shared.',
          containsImageBytes: false,
          containsPrompts: false,
          containsRawProviderResponses: false,
          containsCredentials: false,
        },
        null,
        2
      )}\n`
    );
  }
  let retention;
  try {
    retention = JSON.parse(fs.readFileSync(retentionPath, 'utf8'));
  } catch {
    throw new PreflightRefused('retention', 'retention.json is not valid JSON');
  }
  if (!retention.expiresAt || Number.isNaN(Date.parse(retention.expiresAt))) {
    throw new PreflightRefused('retention', 'retention.json must contain an explicit ISO expiresAt');
  }
  if (Date.parse(retention.expiresAt) <= new Date(now).getTime()) {
    throw new PreflightRefused('retention', 'retention.json has expired; execution is refused until the run root is retired');
  }
  return { root: target, retentionPath, retentionDays: retention.retentionDays, expiresAt: retention.expiresAt };
}

/**
 * Verify the executed bytes are the certified bytes.
 *
 * Returns the identity every run record must quote.
 */
function verifyExecutionSource(snapshotRoot) {
  const report = certifiedSnapshot.verifySnapshot(snapshotRoot);
  if (!report.ok) {
    throw new PreflightRefused(
      'certified_snapshot',
      `snapshot does not match the certified closure (${report.errors.length} error(s))`
    );
  }
  return {
    certifiedCommit: report.certifiedCommit,
    bundleHash: report.bundleHash,
    closureAggregateSha256: report.closureAggregateSha256,
    fileCount: report.fileCount,
  };
}

/** The seal must be valid and must match the dataset actually being scored. */
function verifySealAlignment(seal, manifest) {
  if (seal.datasetVersion !== manifest.datasetVersion) {
    throw new PreflightRefused('seal_alignment', 'holdout seal dataset version does not match the manifest');
  }
  if (seal.finalGroundTruthSha256 !== manifest.finalGroundTruthSha256) {
    throw new PreflightRefused('seal_alignment', 'holdout seal ground-truth hash does not match the manifest');
  }
  if (seal.adjudication && seal.adjudication.unresolvedCount !== 0) {
    throw new PreflightRefused('seal_alignment', 'holdout seal reports unresolved adjudications');
  }
  const sealed = [...seal.holdoutCaseIds].sort().join('|');
  const actual = [...manifest.split.holdout].sort().join('|');
  if (sealed !== actual) {
    throw new PreflightRefused('seal_alignment', 'holdout membership differs from the sealed set');
  }
  return true;
}

/**
 * Classify an adapter outcome into exactly one taxonomy category.
 *
 * Single source of truth: the adapter, the persistence layer and the report all
 * use `lib/errorTaxonomy.js`, so one terminal failure cannot appear under two
 * labels in two places.
 *
 * Ordering matters. A transport fault is decided before output validity, because
 * a request that never returned cannot have produced invalid output — counting
 * it in both would double-count one failure across two mutually exclusive
 * stages.
 */
function classifyOutcome(report) {
  if (!report) return { status: 'adapter_internal_error', retryable: false, stage: 'adapter' };

  const attempts = Array.isArray(report.providerAttempts) ? report.providerAttempts : [];
  const last = attempts[attempts.length - 1] || null;

  // Isolation: a blocked non-Gemini host is an evaluation-side terminal.
  const counters = report.counters || {};
  if (counters.unexpectedNetworkAttempts > 0) {
    return { status: 'network_blocked', retryable: false, stage: 'isolation' };
  }

  // The certified route owns the only fallback. Once both certified-legal
  // attempts have returned failures, the execution terminal is exhaustion; the
  // individual attempt records retain the underlying timeout/HTTP kinds.
  if (
    attempts.length >= 2
    && attempts.every((attempt) =>
      attempt.errorCategory
      || attempt.certifiedFailureKind
      || (Number.isFinite(attempt.httpStatus) && attempt.httpStatus >= 400)
    )
  ) {
    return { status: 'provider_exhausted', retryable: false, stage: 'transport' };
  }

  // Stage 1 — transport.
  if (last && last.errorCategory === 'timeout') {
    return { status: 'provider_timeout', retryable: true, stage: 'transport' };
  }
  if (last && last.errorCategory === 'transport_error') {
    return { status: 'provider_network_error', retryable: true, stage: 'transport' };
  }
  if (last && last.certifiedFailureKind) {
    const category = taxonomy.fromCertifiedKind(last.certifiedFailureKind);
    return { status: category, retryable: taxonomy.CATEGORIES[category].retryable, stage: 'transport' };
  }
  if (last && Number.isFinite(last.httpStatus) && last.httpStatus > 0 && last.httpStatus >= 400) {
    const category = taxonomy.fromHttpStatus(last.httpStatus);
    return { status: category, retryable: taxonomy.CATEGORIES[category].retryable, stage: 'transport' };
  }

  // Stage 2 — the adapter itself failed around the certified handler.
  if (report.handlerError) {
    return { status: 'adapter_internal_error', retryable: false, stage: 'adapter' };
  }

  // Stage 3 — output validity, reached only when a response actually arrived.
  if (!report.v2Present) {
    return { status: 'provider_output_invalid', retryable: false, stage: 'validation' };
  }

  return { status: 'provider_success', retryable: false, stage: 'complete' };
}

/**
 * Build the sanitized private run record for one case.
 *
 * Everything here is either an opaque id, a hash, a number, an enum, or the
 * parsed structured result. No prompt, image byte, raw provider response,
 * credential or absolute path is included.
 */
function buildCaseRecord({ caseId, report, runIdentityRecord, outcome, attemptsUsed, costUsd }) {
  const attempts = Array.isArray(report && report.providerAttempts) ? report.providerAttempts : [];
  return {
    schemaVersion: '1.0.0',
    caseId,
    runId: runIdentityRecord.runId,
    datasetVersion: runIdentityRecord.datasetVersion,
    datasetManifestSha256: runIdentityRecord.datasetManifestSha256,
    holdoutSealSha256: runIdentityRecord.holdoutSealSha256,
    sourceCommit: runIdentityRecord.sourceCommit,
    adapterVersion: ADAPTER_VERSION,
    certifiedCommit: runIdentityRecord.certifiedCommit,
    certifiedBundleHash: runIdentityRecord.certifiedBundleHash,
    modelConfigurationId: runIdentityRecord.modelConfigurationId,
    // Which execution produced this record. Control and candidate share the
    // model configuration by design, so without this a case file could not be
    // attributed to one of them after the fact. A record written before
    // Phase 2A existed carries no candidate version in its identity and is
    // recorded as the control, which is what it was.
    candidateVersion: runIdentityRecord.candidateVersion || 'certified-v140',
    status: outcome.status,
    failureStage: outcome.stage,
    errorTaxonomyVersion: taxonomy.TAXONOMY_VERSION,
    attemptCount: attemptsUsed,
    handlerLatencyMs: report ? report.handlerLatencyMs : null,
    providerAttempts: attempts.map((a) => ({
      model: a.model,
      httpStatus: a.httpStatus,
      latencyMs: a.latencyMs,
      promptTokenCount: a.promptTokenCount,
      candidatesTokenCount: a.candidatesTokenCount,
      totalTokenCount: a.totalTokenCount,
      errorCategory: a.errorCategory,
      certifiedFailureKind: a.certifiedFailureKind || null,
    })),
    // Mutually exclusive stages: a request that never returned is recorded as a
    // transport failure and is NOT also counted as a parse failure.
    parseStatus:
      outcome.stage === 'transport' || outcome.stage === 'isolation'
        ? 'not_reached'
        : outcome.stage === 'validation'
          ? 'invalid'
        : report && report.v2Present
          ? 'parsed'
          : 'invalid',
    costUsd,
    // The parsed structured result only. Explicitly permitted by the private
    // output boundary; the raw provider response is never emitted by the adapter.
    observed: report ? report.observed : null,
    boundaryCounters: report ? report.counters : null,
  };
}

module.exports = {
  ADAPTER_VERSION,
  PreflightRefused,
  readCeilings,
  requireCredential,
  verifyPrivateOutputRoot,
  verifyExecutionSource,
  verifySealAlignment,
  classifyOutcome,
  buildCaseRecord,
};
