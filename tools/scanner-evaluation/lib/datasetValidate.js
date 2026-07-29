'use strict';

/**
 * Uncertainty tokens allowed on governed label fields.
 * Never invent concrete ground truth merely to fill a field.
 */
const UNCERTAINTY_TOKENS = new Set(['unknown', 'not_visible', 'not_applicable']);

const EXPECTED_RESULT_TYPES = new Set([
  'likely_exact_match',
  'closest_matches',
  'identified_style',
  'insufficient_evidence',
]);

const AUTHORIZATION_STATUSES = new Set([
  'approved_internal_eval',
  'approved_qa_fixture',
  'pending_authorization',
  'unauthorized',
  'synthetic_no_image',
]);

const REVIEW_STATUSES = new Set([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'needs_masking',
]);

const SOURCE_CLASSES = new Set([
  'kscan_qa_fixture',
  'approved_tester_image',
  'closet_correction_authorized',
  'licensed_apparel',
  'internally_generated',
  'synthetic_text_proxy',
]);

const PRIVACY_DISPOSITIONS = new Set([
  'hash_and_label_only',
  'governed_fixture_reference',
  'synthetic_text_only',
  'masked_derivative_approved',
  'blocked_private',
]);

const LABEL_CONFIDENCES = new Set(['high', 'medium', 'low', 'unknown']);

const REQUIRED_FIELDS = [
  'caseId',
  'datasetVersion',
  'imageReferences',
  'imageHashes',
  'imageCount',
  'sameItemAcrossImages',
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
  'reviewStatus',
  'reviewerCount',
  'labelConfidence',
  'sourceClass',
  'authorizationStatus',
  'privacyDisposition',
  'notes',
];

const CASE_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const DATASET_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/Users\/|\/home\/|\/tmp\/|file:\/\/)/i;
const USER_ID_RE = /\b(?:actor[_-]?id|user[_-]?id|auth\.users|@[a-z0-9.-]+\.[a-z]{2,})\b/i;

function isUncertainty(value) {
  return typeof value === 'string' && UNCERTAINTY_TOKENS.has(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushError(errors, path, message) {
  errors.push({ path, message });
}

function validateUncertainField(errors, path, value) {
  if (!isNonEmptyString(value)) {
    pushError(errors, path, 'must be a non-empty string or uncertainty token');
    return;
  }
  if (value.length > 128) {
    pushError(errors, path, 'exceeds 128 characters');
  }
}

function validateSecondaryColors(errors, path, value) {
  if (isUncertainty(value)) return;
  if (!Array.isArray(value)) {
    pushError(errors, path, 'must be an array of strings or an uncertainty token');
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      pushError(errors, `${path}[${index}]`, 'must be a non-empty string');
    }
  });
}

function validatePrivacySurface(errors, caseRecord) {
  const blob = JSON.stringify(caseRecord);
  if (USER_ID_RE.test(blob)) {
    pushError(errors, 'privacy', 'manifest must not contain raw user identifiers or emails');
  }
  const refs = Array.isArray(caseRecord.imageReferences) ? caseRecord.imageReferences : [];
  refs.forEach((ref, index) => {
    if (ref && typeof ref.refValue === 'string' && ABSOLUTE_PATH_RE.test(ref.refValue)) {
      pushError(
        errors,
        `imageReferences[${index}].refValue`,
        'must not contain absolute local filesystem paths'
      );
    }
  });
  if (typeof caseRecord.notes === 'string' && ABSOLUTE_PATH_RE.test(caseRecord.notes)) {
    pushError(errors, 'notes', 'must not contain absolute local filesystem paths');
  }
}

/**
 * Validate a single governed case record.
 * @param {object} caseRecord
 * @param {{ expectedDatasetVersion?: string }} [options]
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string}> }}
 */
function validateCase(caseRecord, options = {}) {
  const errors = [];
  if (!caseRecord || typeof caseRecord !== 'object' || Array.isArray(caseRecord)) {
    return { ok: false, errors: [{ path: '', message: 'case must be an object' }] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in caseRecord)) {
      pushError(errors, field, 'required field missing');
    }
  }

  if ('caseId' in caseRecord) {
    if (!CASE_ID_RE.test(caseRecord.caseId || '')) {
      pushError(errors, 'caseId', 'invalid caseId format');
    }
  }

  if ('datasetVersion' in caseRecord) {
    if (!DATASET_VERSION_RE.test(caseRecord.datasetVersion || '')) {
      pushError(errors, 'datasetVersion', 'must be semver X.Y.Z');
    } else if (
      options.expectedDatasetVersion &&
      caseRecord.datasetVersion !== options.expectedDatasetVersion
    ) {
      pushError(
        errors,
        'datasetVersion',
        `does not match expected dataset version ${options.expectedDatasetVersion}`
      );
    }
  }

  if ('imageReferences' in caseRecord) {
    if (!Array.isArray(caseRecord.imageReferences)) {
      pushError(errors, 'imageReferences', 'must be an array');
    } else {
      caseRecord.imageReferences.forEach((ref, index) => {
        if (!ref || typeof ref !== 'object') {
          pushError(errors, `imageReferences[${index}]`, 'must be an object');
          return;
        }
        if (!isNonEmptyString(ref.refType) || !isNonEmptyString(ref.refValue)) {
          pushError(errors, `imageReferences[${index}]`, 'refType and refValue required');
        }
      });
    }
  }

  if ('imageHashes' in caseRecord) {
    if (!Array.isArray(caseRecord.imageHashes)) {
      pushError(errors, 'imageHashes', 'must be an array');
    } else {
      caseRecord.imageHashes.forEach((hash, index) => {
        if (!HASH_RE.test(hash || '')) {
          pushError(errors, `imageHashes[${index}]`, 'must be sha256:<64 hex>');
        }
      });
    }
  }

  if ('imageCount' in caseRecord && (!Number.isInteger(caseRecord.imageCount) || caseRecord.imageCount < 0)) {
    pushError(errors, 'imageCount', 'must be a non-negative integer');
  }

  if ('sameItemAcrossImages' in caseRecord) {
    const allowed = new Set([true, false, 'unknown', 'not_applicable']);
    if (!allowed.has(caseRecord.sameItemAcrossImages)) {
      pushError(errors, 'sameItemAcrossImages', 'invalid value');
    }
  }

  for (const field of [
    'category',
    'clothingType',
    'subtype',
    'primaryColor',
    'material',
    'pattern',
    'brand',
    'exactProduct',
  ]) {
    if (field in caseRecord) validateUncertainField(errors, field, caseRecord[field]);
  }

  if ('secondaryColors' in caseRecord) {
    validateSecondaryColors(errors, 'secondaryColors', caseRecord.secondaryColors);
  }

  if (
    'expectedResultType' in caseRecord &&
    !EXPECTED_RESULT_TYPES.has(caseRecord.expectedResultType)
  ) {
    pushError(errors, 'expectedResultType', 'invalid expected result type');
  }

  if ('expectedAbstention' in caseRecord && typeof caseRecord.expectedAbstention !== 'boolean') {
    pushError(errors, 'expectedAbstention', 'must be boolean');
  }

  if ('reviewStatus' in caseRecord && !REVIEW_STATUSES.has(caseRecord.reviewStatus)) {
    pushError(errors, 'reviewStatus', 'invalid reviewStatus');
  }

  if (
    'reviewerCount' in caseRecord &&
    (!Number.isInteger(caseRecord.reviewerCount) || caseRecord.reviewerCount < 0)
  ) {
    pushError(errors, 'reviewerCount', 'must be a non-negative integer');
  }

  if ('labelConfidence' in caseRecord && !LABEL_CONFIDENCES.has(caseRecord.labelConfidence)) {
    pushError(errors, 'labelConfidence', 'invalid labelConfidence');
  }

  if ('sourceClass' in caseRecord && !SOURCE_CLASSES.has(caseRecord.sourceClass)) {
    pushError(errors, 'sourceClass', 'invalid sourceClass');
  }

  if (
    'authorizationStatus' in caseRecord &&
    !AUTHORIZATION_STATUSES.has(caseRecord.authorizationStatus)
  ) {
    pushError(errors, 'authorizationStatus', 'invalid or missing authorizationStatus');
  }

  if (
    caseRecord.authorizationStatus === 'unauthorized' ||
    caseRecord.authorizationStatus === 'pending_authorization'
  ) {
    pushError(
      errors,
      'authorizationStatus',
      'case is not authorized for governed evaluation scoring'
    );
  }

  if (
    'privacyDisposition' in caseRecord &&
    !PRIVACY_DISPOSITIONS.has(caseRecord.privacyDisposition)
  ) {
    pushError(errors, 'privacyDisposition', 'invalid privacyDisposition');
  }

  if ('notes' in caseRecord && typeof caseRecord.notes !== 'string') {
    pushError(errors, 'notes', 'must be a string');
  }

  validatePrivacySurface(errors, caseRecord);
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a manifest document containing cases[].
 * @param {object} manifest
 * @param {{ expectedDatasetVersion?: string }} [options]
 */
function validateManifest(manifest, options = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'manifest must be an object' }], cases: [] };
  }
  if (!Array.isArray(manifest.cases)) {
    return {
      ok: false,
      errors: [{ path: 'cases', message: 'cases must be an array' }],
      cases: [],
    };
  }

  const seen = new Set();
  const validated = [];
  manifest.cases.forEach((caseRecord, index) => {
    const result = validateCase(caseRecord, options);
    if (!result.ok) {
      result.errors.forEach((err) => {
        pushError(errors, `cases[${index}].${err.path}`, err.message);
      });
    }
    if (caseRecord && typeof caseRecord.caseId === 'string') {
      if (seen.has(caseRecord.caseId)) {
        pushError(errors, `cases[${index}].caseId`, `duplicate caseId: ${caseRecord.caseId}`);
      }
      seen.add(caseRecord.caseId);
    }
    validated.push(caseRecord);
  });

  if (
    options.expectedDatasetVersion &&
    manifest.datasetVersion &&
    manifest.datasetVersion !== options.expectedDatasetVersion
  ) {
    pushError(
      errors,
      'datasetVersion',
      `manifest datasetVersion does not match ${options.expectedDatasetVersion}`
    );
  }

  return { ok: errors.length === 0, errors, cases: validated };
}

module.exports = {
  UNCERTAINTY_TOKENS,
  EXPECTED_RESULT_TYPES,
  REQUIRED_FIELDS,
  isUncertainty,
  validateCase,
  validateManifest,
};
