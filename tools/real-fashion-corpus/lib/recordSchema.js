'use strict';

/**
 * Garment and case record schemas (mission sections 6, 7, 14, 16, 19, 26, 30).
 *
 * Validation returns { valid, errors } and never throws for an ordinary bad
 * record - callers decide whether to reject. Every error string is written to
 * be actionable on its own, because these strings are what a non-engineer
 * collector actually reads (mission section 23).
 */

const {
  GARMENT_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  ALLOWED_EVIDENCE_TYPES,
  FORBIDDEN_EVIDENCE_TYPES,
  GROUND_TRUTH_GRADES,
  ASSET_TIERS,
  ASSET_TIER_REAL,
  ASSET_TIER_PIPELINE_TEST,
  COLLECTION_SOURCES,
  CAPTURE_TYPES,
  CONSENT_STATUSES,
  CAPTURE_ENVIRONMENTS,
  PLATFORMS,
  CAPTURE_PROFILES,
  CASE_STATUSES,
  PARTITIONS,
  CATEGORIES,
  DIFFICULTY_STRATA,
  IMAGE_FORMATS,
  EXIF_POLICY_VERSION,
} = require('./constants');

const { deriveGrade, nonEmptyString } = require('./groundTruth');
const { scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');

const ID_PATTERN_GARMENT = /^G\d{3,}$/;
const ID_PATTERN_CASE = /^C\d{4,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isIsoDate(value) {
  if (!ISO_DATE.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function checkEnum(errors, field, value, allowed) {
  if (!allowed.includes(value)) {
    errors.push(`${field} must be one of [${allowed.join(', ')}], got ${JSON.stringify(value)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Garment record
 * ------------------------------------------------------------------ */

function validateEvidenceRecord(errors, prefix, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  // Forbidden types are checked BEFORE the allow-list so the error message
  // names the actual violation (mission section 5) rather than a generic
  // "not in the allowed list".
  if (FORBIDDEN_EVIDENCE_TYPES.includes(record.evidenceType)) {
    errors.push(
      `${prefix}.evidenceType ${record.evidenceType} is model-derived and forbidden as ground truth ` +
        '(mission section 5: the model being evaluated may never create its own truth)',
    );
    return;
  }
  if (record.modelDerived === true) {
    errors.push(`${prefix}.modelDerived is true - model output may never be ground truth (mission section 5)`);
    return;
  }
  checkEnum(errors, `${prefix}.evidenceType`, record.evidenceType, ALLOWED_EVIDENCE_TYPES);

  if (!isIsoDate(record.verifiedOn)) {
    errors.push(`${prefix}.verifiedOn must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(record.verifiedOn)}`);
  }
  if (!nonEmptyString(record.verifiedBy)) {
    errors.push(`${prefix}.verifiedBy is required (which collector verified this)`);
  }

  // Mission section 19: a URL is supplementary evidence, never the only
  // evidence. observedFacts is what survives link rot.
  if (!record.observedFacts || typeof record.observedFacts !== 'object' || Array.isArray(record.observedFacts)) {
    errors.push(
      `${prefix}.observedFacts is required and must be an object - it records the facts read off the tag/page at ` +
        'labeling time, so the record survives the page disappearing (mission section 19)',
    );
  } else if (Object.keys(record.observedFacts).length === 0) {
    errors.push(`${prefix}.observedFacts must not be empty - record what was actually observed`);
  }

  if (record.urlPointer !== undefined && record.urlPointer !== null && !nonEmptyString(record.urlPointer)) {
    errors.push(`${prefix}.urlPointer, when present, must be a non-empty string or null`);
  }
}

function validateGarment(garment) {
  const errors = [];

  if (!garment || typeof garment !== 'object' || Array.isArray(garment)) {
    return { valid: false, errors: ['garment must be a non-null object'] };
  }
  if (garment.recordType !== 'GARMENT') {
    errors.push(`recordType must be 'GARMENT', got ${JSON.stringify(garment.recordType)}`);
  }
  if (garment.schemaVersion !== GARMENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${GARMENT_SCHEMA_VERSION}', got ${JSON.stringify(garment.schemaVersion)}`);
  }
  if (!ID_PATTERN_GARMENT.test(String(garment.garmentId || ''))) {
    errors.push(`garmentId must match G### (e.g. G001), got ${JSON.stringify(garment.garmentId)}`);
  }

  checkEnum(errors, 'category', garment.category, CATEGORIES);

  const collection = garment.collection;
  if (!collection || typeof collection !== 'object') {
    errors.push('collection is required (who collected this garment and from where)');
  } else {
    if (!nonEmptyString(collection.collectorId)) {
      errors.push('collection.collectorId is required (mission section 35 - collector diversity is reported)');
    }
    checkEnum(errors, 'collection.source', collection.source, COLLECTION_SOURCES);
    if (collection.source === 'AUTHORIZED_IN_STORE' && collection.storePolicyRespected !== true) {
      errors.push(
        'collection.storePolicyRespected must be true for AUTHORIZED_IN_STORE captures ' +
          '(mission section 10 - do not violate store policies)',
      );
    }
  }

  /* -------- ground truth -------- */
  const groundTruth = garment.groundTruth;
  if (!groundTruth || typeof groundTruth !== 'object') {
    errors.push('groundTruth is required');
  } else {
    if (!Array.isArray(groundTruth.evidence)) {
      errors.push('groundTruth.evidence must be an array (may be empty for a VISUAL_ONLY garment)');
    } else {
      groundTruth.evidence.forEach((record, idx) =>
        validateEvidenceRecord(errors, `groundTruth.evidence[${idx}]`, record),
      );
    }

    const identity = groundTruth.identity;
    if (!identity || typeof identity !== 'object') {
      errors.push('groundTruth.identity is required (may have empty style/variant for VISUAL_ONLY)');
    } else {
      // DM-06: STYLE / VARIANT / RETAIL OFFER are kept as separate levels so a
      // future Canonical Product Identity join is a field mapping, not a
      // schema rewrite. Neither level is required to be populated.
      if (identity.style !== undefined && (typeof identity.style !== 'object' || identity.style === null)) {
        errors.push('groundTruth.identity.style, when present, must be an object');
      }
      if (identity.variant !== undefined && (typeof identity.variant !== 'object' || identity.variant === null)) {
        errors.push('groundTruth.identity.variant, when present, must be an object');
      }
    }

    if (!isIsoDate(groundTruth.catalogStateVerifiedOn)) {
      errors.push(
        'groundTruth.catalogStateVerifiedOn must be an ISO date - it records WHEN retailer/manufacturer ' +
          'catalogue state was checked, so a future reader can tell a pipeline change from a delisting ' +
          '(mission section 20)',
      );
    }

    // The asserted grade is a CLAIM, checked against the derived grade. This
    // is the guard against grade inflation (see docs/DESIGN.md section 3).
    if (groundTruth.assertedGrade !== undefined) {
      checkEnum(errors, 'groundTruth.assertedGrade', groundTruth.assertedGrade, GROUND_TRUTH_GRADES);
      const derived = deriveGrade(groundTruth);
      if (derived.invalid) {
        for (const reason of derived.reasons) errors.push(`groundTruth: ${reason}`);
      } else if (derived.grade !== groundTruth.assertedGrade) {
        errors.push(
          `groundTruth.assertedGrade is ${groundTruth.assertedGrade} but the evidence present only supports ` +
            `${derived.grade}. Missing: ${derived.reasons.join('; ') || 'n/a'}`,
        );
      }
    }
  }

  /* -------- result-set hard negatives (mission section 14) -------- */
  if (garment.resultSetHardNegatives !== undefined) {
    if (!Array.isArray(garment.resultSetHardNegatives)) {
      errors.push('resultSetHardNegatives, when present, must be an array');
    } else {
      garment.resultSetHardNegatives.forEach((entry, idx) => {
        const prefix = `resultSetHardNegatives[${idx}]`;
        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix} must be an object`);
          return;
        }
        if (!nonEmptyString(entry.reason)) {
          errors.push(`${prefix}.reason is required (why this product must not be confused with the garment)`);
        }
        if (!entry.identity || typeof entry.identity !== 'object') {
          errors.push(`${prefix}.identity is required (identity evidence for the product to be excluded)`);
        }
        // A result-set hard negative is metadata only. If it claims a capture
        // it would inflate the real-case count, which section 14 forbids.
        if (entry.assetPath !== undefined || entry.caseId !== undefined) {
          errors.push(
            `${prefix} must not carry assetPath or caseId - a RESULT_SET_HARD_NEGATIVE is metadata only. ` +
              'A separately photographed confusable garment is an INPUT_HARD_NEGATIVE and belongs in a case record ' +
              '(mission section 14 keeps these distinct).',
          );
        }
      });
    }
  }

  if (garment.revisions !== undefined && !Array.isArray(garment.revisions)) {
    errors.push('revisions, when present, must be an array (append-only correction history, mission section 36)');
  }

  const privacy = scanForPrivacyViolations(garment);
  for (const violation of privacy.violations) {
    errors.push(`privacy_violation at ${violation.path}: ${violation.reason}`);
  }

  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Case record
 * ------------------------------------------------------------------ */

function validateDimensions(errors, prefix, dims, { required }) {
  if (dims === undefined || dims === null) {
    if (required) errors.push(`${prefix} is required (mission section 15 - record actual dimensions, do not fabricate parity)`);
    return;
  }
  if (typeof dims !== 'object') {
    errors.push(`${prefix} must be an object { width, height }`);
    return;
  }
  for (const axis of ['width', 'height']) {
    if (!Number.isInteger(dims[axis]) || dims[axis] <= 0) {
      errors.push(`${prefix}.${axis} must be a positive integer, got ${JSON.stringify(dims[axis])}`);
    }
  }
}

function validateCase(record) {
  const errors = [];

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['case must be a non-null object'] };
  }
  if (record.recordType !== 'CASE') {
    errors.push(`recordType must be 'CASE', got ${JSON.stringify(record.recordType)}`);
  }
  if (record.schemaVersion !== CASE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${CASE_SCHEMA_VERSION}', got ${JSON.stringify(record.schemaVersion)}`);
  }
  if (!ID_PATTERN_CASE.test(String(record.caseId || ''))) {
    errors.push(`caseId must match C#### (e.g. C0001), got ${JSON.stringify(record.caseId)}`);
  }
  if (!ID_PATTERN_GARMENT.test(String(record.garmentId || ''))) {
    errors.push(
      `garmentId must match G### - every case names the physical garment it captured (mission section 7), ` +
        `got ${JSON.stringify(record.garmentId)}`,
    );
  }

  checkEnum(errors, 'assetTier', record.assetTier, ASSET_TIERS);
  checkEnum(errors, 'status', record.status, CASE_STATUSES);
  checkEnum(errors, 'partition', record.partition, PARTITIONS);

  /* -------- capture -------- */
  const capture = record.capture;
  if (!capture || typeof capture !== 'object') {
    errors.push('capture is required');
  } else {
    checkEnum(errors, 'capture.captureProfile', capture.captureProfile, CAPTURE_PROFILES);
    checkEnum(errors, 'capture.captureType', capture.captureType, CAPTURE_TYPES);
    checkEnum(errors, 'capture.environment', capture.environment, CAPTURE_ENVIRONMENTS);

    if (!isIsoDate(capture.capturedOn)) {
      errors.push(`capture.capturedOn must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(capture.capturedOn)}`);
    }

    const device = capture.device;
    if (!device || typeof device !== 'object') {
      errors.push('capture.device is required { platform, model }');
    } else {
      checkEnum(errors, 'capture.device.platform', device.platform, PLATFORMS);
      if (!nonEmptyString(device.model)) {
        errors.push('capture.device.model is required (e.g. "iPhone 15 Pro") - paired-device analysis needs it');
      }
      // The capture profile must agree with the platform, or platform
      // stratification silently measures the wrong thing.
      if (device.platform === 'ios' && capture.captureProfile === 'android-current-v1') {
        errors.push("capture.device.platform is 'ios' but captureProfile is 'android-current-v1'");
      }
      if (device.platform === 'android' && capture.captureProfile === 'ios-current-v1') {
        errors.push("capture.device.platform is 'android' but captureProfile is 'ios-current-v1'");
      }
    }

    // Mission section 15: record what was actually captured/processed/uploaded.
    validateDimensions(errors, 'capture.capturedDimensions', capture.capturedDimensions, { required: true });
    validateDimensions(errors, 'capture.processedDimensions', capture.processedDimensions, { required: false });
    validateDimensions(errors, 'capture.uploadedDimensions', capture.uploadedDimensions, { required: false });
    checkEnum(errors, 'capture.format', capture.format, IMAGE_FORMATS);

    /* -------- capture privacy (mission section 16) -------- */
    const consent = capture.consent;
    if (!consent || typeof consent !== 'object') {
      errors.push('capture.consent is required { humanPresent, consentStatus }');
    } else {
      if (typeof consent.humanPresent !== 'boolean') {
        errors.push('capture.consent.humanPresent must be a boolean');
      }
      checkEnum(errors, 'capture.consent.consentStatus', consent.consentStatus, CONSENT_STATUSES);
      if (consent.humanPresent === true && consent.consentStatus !== 'EXPLICIT_COLLECTOR_CONSENT') {
        errors.push(
          'a capture with a human present requires capture.consent.consentStatus = EXPLICIT_COLLECTOR_CONSENT ' +
            '(mission section 16)',
        );
      }
      if (capture.captureType === 'WORN' && consent.humanPresent !== true) {
        errors.push("capture.captureType 'WORN' implies a human is present - set capture.consent.humanPresent = true");
      }
      if (consent.humanPresent === true && consent.unrelatedPeoplePresent === true) {
        errors.push('capture.consent.unrelatedPeoplePresent must not be true (mission section 16 - no unrelated people)');
      }
      // Mission section 16: never create biometric annotations, never infer
      // sensitive attributes. Refuse the field rather than trusting nobody
      // will add one.
      for (const forbidden of ['biometric', 'biometrics', 'faceEmbedding', 'inferredAge', 'inferredGender', 'inferredEthnicity']) {
        if (consent[forbidden] !== undefined || capture[forbidden] !== undefined) {
          errors.push(
            `${forbidden} is forbidden - the corpus never creates biometric annotations or infers sensitive ` +
              'attributes (mission section 16)',
          );
        }
      }
    }
  }

  /* -------- asset -------- */
  const asset = record.asset;
  if (!asset || typeof asset !== 'object') {
    errors.push('asset is required { assetPath, sha256, byteSize, exifSanitization }');
  } else {
    if (!nonEmptyString(asset.assetPath)) {
      errors.push('asset.assetPath is required (path relative to the mounted corpus asset root)');
    } else if (asset.assetPath.includes('..') || /^([a-zA-Z]:)?[\\/]/.test(asset.assetPath)) {
      errors.push(
        `asset.assetPath must be a relative path inside the asset root with no '..' segment, got ${JSON.stringify(asset.assetPath)}`,
      );
    }
    if (!SHA256_HEX.test(String(asset.sha256 || ''))) {
      errors.push(`asset.sha256 must be a 64-character lowercase hex digest, got ${JSON.stringify(asset.sha256)}`);
    }
    if (!Number.isInteger(asset.byteSize) || asset.byteSize <= 0) {
      errors.push(`asset.byteSize must be a positive integer, got ${JSON.stringify(asset.byteSize)}`);
    }

    const exif = asset.exifSanitization;
    if (!exif || typeof exif !== 'object') {
      errors.push('asset.exifSanitization is required (mission section 17 - the EXIF policy must be recorded)');
    } else {
      if (exif.policyVersion !== EXIF_POLICY_VERSION) {
        errors.push(
          `asset.exifSanitization.policyVersion must be '${EXIF_POLICY_VERSION}', got ${JSON.stringify(exif.policyVersion)}`,
        );
      }
      if (exif.locationStripped !== true) {
        errors.push(
          'asset.exifSanitization.locationStripped must be true - an asset retaining location EXIF is rejected ' +
            '(mission section 17)',
        );
      }
      if (!nonEmptyString(exif.sanitizedOn)) {
        errors.push('asset.exifSanitization.sanitizedOn is required');
      }
    }
  }

  /* -------- pairing (mission section 15) -------- */
  if (record.pairing !== undefined && record.pairing !== null) {
    if (typeof record.pairing !== 'object') {
      errors.push('pairing, when present, must be an object { pairedCaseId, pairGroupId }');
    } else {
      if (record.pairing.pairedCaseId !== undefined && record.pairing.pairedCaseId !== null) {
        if (!ID_PATTERN_CASE.test(String(record.pairing.pairedCaseId))) {
          errors.push(`pairing.pairedCaseId must match C####, got ${JSON.stringify(record.pairing.pairedCaseId)}`);
        }
        if (record.pairing.pairedCaseId === record.caseId) {
          errors.push('pairing.pairedCaseId must not be the case itself');
        }
      }
    }
  }

  /* -------- difficulty strata (mission section 13) -------- */
  if (record.difficultyStrata !== undefined) {
    if (!Array.isArray(record.difficultyStrata)) {
      errors.push('difficultyStrata, when present, must be an array');
    } else {
      for (const stratum of record.difficultyStrata) {
        if (!DIFFICULTY_STRATA.includes(stratum)) {
          errors.push(`difficultyStrata contains unknown value ${JSON.stringify(stratum)}`);
        }
      }
    }
  }

  /* -------- input hard negative (mission section 14) -------- */
  if (record.inputHardNegativeOf !== undefined && record.inputHardNegativeOf !== null) {
    if (!ID_PATTERN_GARMENT.test(String(record.inputHardNegativeOf))) {
      errors.push(
        `inputHardNegativeOf must be a garmentId (G###) - an INPUT_HARD_NEGATIVE is a real capture easy to ` +
          `confuse with that garment, got ${JSON.stringify(record.inputHardNegativeOf)}`,
      );
    }
    if (record.inputHardNegativeOf === record.garmentId) {
      errors.push('inputHardNegativeOf must name a DIFFERENT garment than the one this case captured');
    }
  }

  /* -------- pipeline-test tier (mission section 26) -------- */
  if (record.assetTier === ASSET_TIER_PIPELINE_TEST) {
    if (record.pipelineTestPurpose === undefined || !nonEmptyString(record.pipelineTestPurpose)) {
      errors.push(
        'a PIPELINE_TEST_ASSET case must state pipelineTestPurpose (what infrastructure behaviour it exercises)',
      );
    }
  } else if (record.assetTier === ASSET_TIER_REAL && record.pipelineTestPurpose !== undefined) {
    errors.push('a REAL_CAPTURE case must not carry pipelineTestPurpose');
  }

  const privacy = scanForPrivacyViolations(record);
  for (const violation of privacy.violations) {
    errors.push(`privacy_violation at ${violation.path}: ${violation.reason}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  GARMENT_SCHEMA_VERSION,
  CASE_SCHEMA_VERSION,
  validateGarment,
  validateCase,
  isIsoDate,
  ID_PATTERN_GARMENT,
  ID_PATTERN_CASE,
  SHA256_HEX,
};
