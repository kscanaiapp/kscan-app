'use strict';

/**
 * Run identity, holdout sealing, and resume-identity matching (Phase 1 repairs
 * F-3 and F-4).
 *
 * WHY THIS EXISTS
 *
 * 1. RUN IDENTITY. A run had no identifier. Two runs against different adapters,
 *    ceilings or splits produced indistinguishable output directories, so a
 *    resume could graft results from one configuration onto another and the
 *    combined report would look complete. Resume previously compared only the
 *    dataset version, which is the one thing least likely to differ.
 *
 * 2. SPLIT ISOLATION. The runner had no notion of the development/holdout split
 *    even though the frozen manifest carries one. A single `--execute` therefore
 *    processed all 41 cases in one pass, executing the holdout alongside the
 *    development set. That destroys the holdout's only purpose: it is the sole
 *    check standing between a tuned harness and a self-confirming result, and it
 *    is worthless the moment it is observed at the same time as the development
 *    set.
 *
 * 3. HOLDOUT SEAL. The holdout may only run against labels that were locked
 *    BEFORE any development result was visible. A seal record pins the locked
 *    labels by hash, so a label edited after development execution invalidates
 *    the seal instead of silently becoming the new ground truth.
 */

const crypto = require('crypto');

const SPLIT_DEVELOPMENT = 'development';
const SPLIT_HOLDOUT = 'holdout';
const SPLITS = Object.freeze([SPLIT_DEVELOPMENT, SPLIT_HOLDOUT]);

/**
 * Build the immutable run identifier.
 *
 * Shape: baseline-v<datasetVersion>-<adapterId>-<YYYYMMDD-HHMM>-<shortSha>-<split>-<mode>
 * Every component that could change the meaning of a result is in the name, so
 * two runs that differ in any of them cannot collide in one directory.
 *
 * CANDIDATE SEGMENT. `parts.candidateVersion` is optional and is appended only
 * when it is a non-empty string. The certified v140 control passes null (see
 * `candidateRegistry.runIdSegment`), so a certified run id is byte-identical to
 * the one this function produced before Phase 2A existed, while a candidate run
 * carries its version in the name and therefore cannot share a directory,
 * manifest or result file with the control.
 */
function buildRunId(parts) {
  const required = ['datasetVersion', 'adapterId', 'timestamp', 'mode', 'researchSha', 'split'];
  for (const field of required) {
    if (!parts || !parts[field]) {
      throw new Error(`run identity requires ${field}`);
    }
  }
  if (!SPLITS.includes(parts.split)) {
    throw new Error(`run identity split must be one of ${SPLITS.join(', ')}, received ${parts.split}`);
  }
  if (parts.candidateVersion != null && typeof parts.candidateVersion !== 'string') {
    throw new Error('run identity candidateVersion must be a string when present');
  }
  if (typeof parts.candidateVersion === 'string' && /[\\/\s]/.test(parts.candidateVersion)) {
    // The segment becomes a directory name. A separator would let a candidate id
    // escape its run directory.
    throw new Error(`run identity candidateVersion may not contain whitespace or a path separator: ${parts.candidateVersion}`);
  }
  const stamp = String(parts.timestamp).replace(/[-:]/g, '').replace(/\.\d+Z?$/, '').replace('T', '-').slice(0, 13);
  const shortSha = String(parts.researchSha).slice(0, 7);
  const candidateSegment =
    typeof parts.candidateVersion === 'string' && parts.candidateVersion.trim() !== ''
      ? [parts.candidateVersion.trim()]
      : [];
  return [
    'baseline',
    `v${parts.datasetVersion}`,
    parts.adapterId,
    stamp,
    shortSha,
    parts.split,
    parts.mode === 'execute' ? 'exec' : 'dry',
    ...candidateSegment,
  ].join('-');
}

/**
 * The fields whose change makes two runs incomparable. Kept explicit rather than
 * "everything in the manifest" so an added report field does not spuriously
 * invalidate a legitimate resume.
 */
const IDENTITY_FIELDS = Object.freeze([
  'runId',
  'datasetVersion',
  'datasetAggregateSha256',
  'datasetManifestSha256',
  'holdoutSealSha256',
  'adapterId',
  'certifiedBundleSha256',
  'certifiedCommit',
  'certifiedSnapshotSha256',
  'selectionContractSha256',
  'modelConfigurationId',
  // Phase 2A candidates deliberately share the certified MODEL topology, so
  // `modelConfigurationId` is identical on control and candidate and cannot
  // separate them. The candidate version is what makes two results
  // incomparable, so it is its own identity field. Runs recorded before
  // Phase 2A carry it on neither side and are unaffected: `compareIdentity`
  // skips a field that is undefined in both records.
  'candidateVersion',
  'split',
  'scoringContractVersion',
  'capturePreparationMode',
  // A different preparation manifest means different bytes reached the provider,
  // so results from before and after are not comparable and must not be merged.
  // The manifest hash already covers the policy, the codec and every derivative
  // hash, but they are ALSO named here so a mismatch says which thing changed
  // instead of only "the manifest differs". Owner-required: the codec version,
  // preparation parameters, derivative hashes and manifest hash all stay part of
  // the immutable run identity because this stage is production-equivalent rather
  // than byte-for-byte identical to production.
  'preparationManifestSha256',
  'preparationPolicy',
  'preparationCodec',
  'preparationTransformSignature',
  'hardCallCeiling',
  'spendCeilingUsd',
]);

/**
 * Compare a prior run manifest against the current configuration.
 * Returns every mismatch rather than the first, so one resume attempt surfaces
 * the whole disagreement.
 */
function compareIdentity(prior, current) {
  const mismatches = [];
  for (const field of IDENTITY_FIELDS) {
    const before = prior ? prior[field] : undefined;
    const after = current ? current[field] : undefined;
    if (before === undefined && after === undefined) continue;
    if (before !== after) {
      mismatches.push({ field, prior: before === undefined ? null : before, current: after === undefined ? null : after });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Assert a resume is legitimate. Throws with the full mismatch list.
 */
function assertResumable(prior, current) {
  if (!prior) return { ok: true, firstRun: true };
  const comparison = compareIdentity(prior, current);
  if (!comparison.ok) {
    const detail = comparison.mismatches
      .map((m) => `${m.field}: run manifest ${JSON.stringify(m.prior)} vs current ${JSON.stringify(m.current)}`)
      .join('; ');
    throw new Error(`invalid resume state: ${detail}`);
  }
  return { ok: true, firstRun: false };
}

/**
 * Hash the locked ground-truth labels of a case set.
 *
 * Only the fields that ARE the ground truth are hashed. Curation notes and
 * provenance are excluded: editing a note must not invalidate a seal, but
 * editing an expected label must.
 */
const LOCKED_LABEL_FIELDS = Object.freeze([
  'caseId',
  'category',
  'clothingType',
  'subtype',
  'primaryColor',
  'secondaryColors',
  'material',
  'pattern',
  'brand',
  'exactProduct',
  'expectedResultType',
  'expectedAbstention',
  'nonFashion',
  'brandVisible',
  'brandEvidenceClass',
  'exactProductKnowable',
  'imageHashes',
]);

function lockedLabelHash(cases) {
  const normalized = cases
    .slice()
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
    .map((caseRecord) => {
      const picked = {};
      for (const field of LOCKED_LABEL_FIELDS) {
        if (caseRecord[field] !== undefined) picked[field] = caseRecord[field];
      }
      return picked;
    });
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Validate a holdout seal record against the current holdout cases.
 *
 * A holdout run is permitted only when the seal exists, names these exact cases,
 * records both independent reviews plus adjudication, and its locked-label hash
 * still reproduces. Any drift invalidates the run rather than being absorbed.
 *
 * @param {object|null} seal
 * @param {Array<object>} holdoutCases
 * @param {{ datasetAggregateSha256?: string }} context
 */
function verifyHoldoutSeal(seal, holdoutCases, context = {}) {
  const errors = [];
  if (!seal || typeof seal !== 'object') {
    return {
      ok: false,
      errors: [{
        check: 'holdout_seal_present',
        message:
          'no holdout seal record exists. The holdout may not execute until reviewer A and reviewer B '
          + 'have independently locked labels and adjudication has completed.',
      }],
    };
  }

  for (const field of ['sealedAt', 'reviewerACompletedAt', 'reviewerBCompletedAt', 'adjudicationCompletedAt']) {
    if (!seal[field] || Number.isNaN(Date.parse(seal[field]))) {
      errors.push({ check: 'holdout_seal_completeness', message: `seal.${field} must be an ISO timestamp` });
    }
  }
  if (!seal.reviewArtifactSha256) {
    errors.push({ check: 'holdout_seal_review_artifact', message: 'seal.reviewArtifactSha256 is required' });
  }

  if (context.datasetAggregateSha256 && seal.datasetAggregateSha256 !== context.datasetAggregateSha256) {
    errors.push({
      check: 'holdout_seal_dataset',
      message: `seal was taken against dataset aggregate ${seal.datasetAggregateSha256}, current is ${context.datasetAggregateSha256}`,
    });
  }

  const sealedIds = [...(seal.holdoutCaseIds || [])].sort();
  const currentIds = holdoutCases.map((c) => c.caseId).sort();
  if (JSON.stringify(sealedIds) !== JSON.stringify(currentIds)) {
    errors.push({
      check: 'holdout_seal_membership',
      message: `sealed holdout membership (${sealedIds.length}) does not match current holdout (${currentIds.length})`,
    });
  }

  const observedHash = lockedLabelHash(holdoutCases);
  if (seal.lockedLabelSha256 !== observedHash) {
    errors.push({
      check: 'holdout_seal_labels',
      message:
        `holdout labels changed after sealing: seal ${seal.lockedLabelSha256}, observed ${observedHash}. `
        + 'Any holdout-label change after sealing invalidates the run.',
    });
  }

  return { ok: errors.length === 0, errors, observedLockedLabelSha256: observedHash };
}

/**
 * Partition governed cases by the frozen split.
 *
 * The frozen manifest records the split at the top level as case-id arrays, so a
 * case that appears in neither is an error rather than a silent omission from
 * both aggregates.
 */
function partitionBySplit(cases, split) {
  const dev = new Set(split && split.development ? split.development : []);
  const hold = new Set(split && split.holdout ? split.holdout : []);
  const development = [];
  const holdout = [];
  const unassigned = [];
  for (const caseRecord of cases) {
    if (hold.has(caseRecord.caseId)) holdout.push(caseRecord);
    else if (dev.has(caseRecord.caseId)) development.push(caseRecord);
    else unassigned.push(caseRecord.caseId);
  }
  return { development, holdout, unassigned };
}

module.exports = {
  SPLIT_DEVELOPMENT,
  SPLIT_HOLDOUT,
  SPLITS,
  IDENTITY_FIELDS,
  LOCKED_LABEL_FIELDS,
  buildRunId,
  compareIdentity,
  assertResumable,
  lockedLabelHash,
  verifyHoldoutSeal,
  partitionBySplit,
};
