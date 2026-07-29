'use strict';

/**
 * Experiment / reproducibility metadata contract.
 * Results missing required versioning fields are invalid for production consideration.
 */

const REQUIRED_EXPERIMENT_FIELDS = [
  'experimentId',
  'sourceSha',
  'scanIdentifyTreeHash',
  'sharedContractTreeHash',
  'datasetVersion',
  'pipelineVersion',
  'promptVersion',
  'modelConfiguration',
  'schemaVersion',
  'preprocessingVersion',
  'thresholdVersion',
  'retrievalVersion',
  'rerankingVersion',
  'startedAt',
  'completedAt',
  'caseCount',
  'metrics',
  'latency',
  'modelCallCount',
  'costEstimate',
  'notes',
];

const SHA_RE = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+/;

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validateExperimentRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: [{ path: '', message: 'experiment record must be an object' }] };
  }

  for (const field of REQUIRED_EXPERIMENT_FIELDS) {
    if (!(field in record) || record[field] === undefined || record[field] === null) {
      pushError(errors, field, 'required for reproducibility');
    }
  }

  if (record.experimentId != null && typeof record.experimentId !== 'string') {
    pushError(errors, 'experimentId', 'must be a string');
  }
  if (record.sourceSha != null && !SHA_RE.test(String(record.sourceSha))) {
    pushError(errors, 'sourceSha', 'must be a 40- or 64-char hex SHA');
  }
  if (record.scanIdentifyTreeHash != null && !SHA_RE.test(String(record.scanIdentifyTreeHash))) {
    pushError(errors, 'scanIdentifyTreeHash', 'must be a hex tree hash');
  }
  if (
    record.sharedContractTreeHash != null &&
    !SHA_RE.test(String(record.sharedContractTreeHash))
  ) {
    pushError(errors, 'sharedContractTreeHash', 'must be a hex tree hash');
  }
  if (record.datasetVersion != null && !SEMVER_RE.test(String(record.datasetVersion))) {
    pushError(errors, 'datasetVersion', 'must start with semver');
  }
  if (record.caseCount != null && (!Number.isInteger(record.caseCount) || record.caseCount < 0)) {
    pushError(errors, 'caseCount', 'must be a non-negative integer');
  }
  if (record.metrics != null && (typeof record.metrics !== 'object' || Array.isArray(record.metrics))) {
    pushError(errors, 'metrics', 'must be an object');
  }
  if (
    record.modelCallCount != null &&
    (!Number.isInteger(record.modelCallCount) || record.modelCallCount < 0)
  ) {
    pushError(errors, 'modelCallCount', 'must be a non-negative integer');
  }
  if (record.modelConfiguration != null && typeof record.modelConfiguration !== 'object') {
    pushError(errors, 'modelConfiguration', 'must be an object');
  }

  return { ok: errors.length === 0, errors };
}

function assertDatasetVersionMatch(experiment, expectedDatasetVersion) {
  if (!experiment || experiment.datasetVersion !== expectedDatasetVersion) {
    return {
      ok: false,
      errors: [
        {
          path: 'datasetVersion',
          message: `experiment datasetVersion must equal ${expectedDatasetVersion}`,
        },
      ],
    };
  }
  return { ok: true, errors: [] };
}

module.exports = {
  REQUIRED_EXPERIMENT_FIELDS,
  validateExperimentRecord,
  assertDatasetVersionMatch,
};
