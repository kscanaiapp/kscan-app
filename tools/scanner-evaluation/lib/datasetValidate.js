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
  // Phase 0B section 8. AI-generated imagery used only to fill documented
  // coverage gaps. Barred from brand/exact-product truth and from the holdout.
  'synthetic_image',
]);

const SYNTHETIC_SOURCE_CLASSES = new Set(['synthetic_text_proxy', 'synthetic_image']);

const FACE_REVIEW_STATES = new Set([
  'no_face_present',
  'face_present_masked',
  'face_present_blocked',
  'not_reviewed',
]);

const PLATE_REVIEW_STATES = new Set([
  'no_plate_present',
  'plate_present_masked',
  'plate_present_blocked',
  'not_reviewed',
]);

const DERIVATIVE_STATUSES = new Set([
  'original_approved',
  'masked_derivative',
  'cropped_derivative',
  'synthetic_original',
]);

const REVIEWER_ROLES = new Set(['primary', 'secondary', 'adjudicator']);

/** Fields both reviewers must independently label (Phase 0B section 9). */
const DUAL_REVIEW_FIELDS = Object.freeze([
  'category',
  'clothingType',
  'subtype',
  'primaryColor',
  'brand',
  'exactProduct',
  'expectedResultType',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Keys that would place a reviewer identity inside a case record. */
const IDENTITY_KEY_RE = /^(reviewer(name|email|id)|labeledby|authorizedby|owner(name|email))$/i;

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
 * Phase 0B privacy, retention and EXIF requirements (section 10).
 * Gated behind `requirePhase0bPrivacy` so the frozen v0.1.0 seed manifest
 * remains valid under its own contract.
 */
function validatePrivacyAndRetention(errors, caseRecord) {
  if (!ISO_DATE_RE.test(caseRecord.privacyReviewDate || '')) {
    pushError(errors, 'privacyReviewDate', 'required ISO date (YYYY-MM-DD) of the privacy review');
  }
  if (!isNonEmptyString(caseRecord.retentionPolicyRef)) {
    pushError(errors, 'retentionPolicyRef', 'required reference to the governing retention policy');
  }
  if (caseRecord.retentionExpiry != null && !ISO_DATE_RE.test(caseRecord.retentionExpiry)) {
    pushError(errors, 'retentionExpiry', 'must be an ISO date when present');
  }
  if (typeof caseRecord.exifRemoved !== 'boolean') {
    pushError(errors, 'exifRemoved', 'required boolean EXIF removal state');
  } else if (caseRecord.exifRemoved === false) {
    pushError(errors, 'exifRemoved', 'case may not be admitted while EXIF is still present');
  }
  if (!FACE_REVIEW_STATES.has(caseRecord.faceReviewState)) {
    pushError(errors, 'faceReviewState', 'required face-review state');
  } else if (caseRecord.faceReviewState === 'not_reviewed') {
    pushError(errors, 'faceReviewState', 'case may not be admitted before a face review');
  } else if (caseRecord.faceReviewState === 'face_present_blocked') {
    pushError(errors, 'faceReviewState', 'case is blocked: face privacy could not be resolved');
  }
  if (!PLATE_REVIEW_STATES.has(caseRecord.plateReviewState)) {
    pushError(errors, 'plateReviewState', 'required plate-review state');
  } else if (caseRecord.plateReviewState === 'not_reviewed') {
    pushError(errors, 'plateReviewState', 'case may not be admitted before a plate review');
  } else if (caseRecord.plateReviewState === 'plate_present_blocked') {
    pushError(errors, 'plateReviewState', 'case is blocked: plate privacy could not be resolved');
  }
  if (!DERIVATIVE_STATUSES.has(caseRecord.derivativeStatus)) {
    pushError(errors, 'derivativeStatus', 'required derivative status');
  }
  if (!isNonEmptyString(caseRecord.governedStorageRef)) {
    pushError(errors, 'governedStorageRef', 'required governed storage reference');
  }
}

/** Reviewer labels, adjudication and reviewer-identity prohibition (section 9). */
function validateReviewMetadata(errors, caseRecord, options) {
  const labels = caseRecord.reviewerLabels;

  if (labels !== undefined) {
    if (!Array.isArray(labels)) {
      pushError(errors, 'reviewerLabels', 'must be an array');
      return;
    }
    const roles = new Set();
    labels.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        pushError(errors, `reviewerLabels[${index}]`, 'must be an object');
        return;
      }
      if (!REVIEWER_ROLES.has(entry.reviewerRole)) {
        pushError(errors, `reviewerLabels[${index}].reviewerRole`, 'invalid reviewerRole');
      }
      roles.add(entry.reviewerRole);
      if (!entry.labels || typeof entry.labels !== 'object') {
        pushError(errors, `reviewerLabels[${index}].labels`, 'labels object required');
      }
      if (!LABEL_CONFIDENCES.has(entry.confidence)) {
        pushError(errors, `reviewerLabels[${index}].confidence`, 'invalid reviewer confidence');
      }
      // A policy or role reference is sufficient; an identity is never stored.
      for (const key of Object.keys(entry)) {
        if (IDENTITY_KEY_RE.test(key.replace(/[_-]/g, ''))) {
          pushError(
            errors,
            `reviewerLabels[${index}].${key}`,
            'reviewer identity must not be stored in the case record'
          );
        }
      }
    });

    if (options.requireTwoReviewers && !(roles.has('primary') && roles.has('secondary'))) {
      pushError(
        errors,
        'reviewerLabels',
        'two independent reviews (primary and secondary) are required for this dataset version'
      );
    }

    // Disagreement on any dual-review field forces adjudication.
    const primary = labels.find((l) => l && l.reviewerRole === 'primary');
    const secondary = labels.find((l) => l && l.reviewerRole === 'secondary');
    if (primary && secondary && primary.labels && secondary.labels) {
      const disagreed = DUAL_REVIEW_FIELDS.filter((field) => {
        const a = primary.labels[field];
        const b = secondary.labels[field];
        if (a === undefined || b === undefined) return false;
        return String(a) !== String(b);
      });
      const adjudication = caseRecord.adjudication || {};
      if (disagreed.length > 0) {
        if (adjudication.required !== true) {
          pushError(
            errors,
            'adjudication.required',
            `reviewers disagree on ${disagreed.join(', ')}; adjudication is required`
          );
        }
        const recorded = Array.isArray(adjudication.fields) ? adjudication.fields : [];
        for (const field of disagreed) {
          if (!recorded.includes(field)) {
            pushError(errors, 'adjudication.fields', `unadjudicated disagreement on ${field}`);
          }
        }
      }
    }
  } else if (options.requireTwoReviewers) {
    pushError(errors, 'reviewerLabels', 'two independent reviews are required for this dataset version');
  }
}

/** Synthetic-image restrictions (section 8). */
function validateSyntheticRestrictions(errors, caseRecord) {
  if (!SYNTHETIC_SOURCE_CLASSES.has(caseRecord.sourceClass)) return;

  for (const field of ['brand', 'exactProduct']) {
    const value = caseRecord[field];
    if (isNonEmptyString(value) && !isUncertainty(value)) {
      pushError(
        errors,
        field,
        `synthetic source may not carry ${field} ground truth`
      );
    }
  }
  if (caseRecord.sourceClass === 'synthetic_image') {
    const meta = caseRecord.syntheticMeta;
    if (!meta || typeof meta !== 'object') {
      pushError(errors, 'syntheticMeta', 'synthetic imagery requires generation metadata');
      return;
    }
    if (!isNonEmptyString(meta.generationMethod)) {
      pushError(errors, 'syntheticMeta.generationMethod', 'required');
    }
    if (!isNonEmptyString(meta.reason)) {
      pushError(errors, 'syntheticMeta.reason', 'required: which documented coverage gap this fills');
    }
    if (!isNonEmptyString(meta.realismReview)) {
      pushError(errors, 'syntheticMeta.realismReview', 'required realism review outcome');
    }
  }
}

/**
 * Validate a single governed case record.
 * @param {object} caseRecord
 * @param {{ expectedDatasetVersion?: string, requirePhase0bPrivacy?: boolean,
 *           requireTwoReviewers?: boolean }} [options]
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
  if (options.requirePhase0bPrivacy) validatePrivacyAndRetention(errors, caseRecord);
  validateReviewMetadata(errors, caseRecord, options);
  validateSyntheticRestrictions(errors, caseRecord);
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
  SOURCE_CLASSES,
  SYNTHETIC_SOURCE_CLASSES,
  FACE_REVIEW_STATES,
  PLATE_REVIEW_STATES,
  DERIVATIVE_STATUSES,
  REVIEWER_ROLES,
  DUAL_REVIEW_FIELDS,
  isUncertainty,
  validateCase,
  validateManifest,
};
