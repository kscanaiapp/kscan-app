'use strict';

/**
 * Privacy-safe correction-event schema (design only).
 * Phase 0A: no production collection, no Supabase tables, no identity linkage.
 */

const CORRECTION_EVENT_SCHEMA_VERSION = '0.1.0';

const CORRECTION_REQUIRED_FIELDS = [
  'correctionEventId',
  'schemaVersion',
  'fieldChanged',
  'originalValue',
  'correctedValue',
  'originalFieldConfidence',
  'pipelineVersion',
  'governedCaseReference',
  'consentState',
  'privacySafeSourceClass',
  'originalPredictionSummary',
];

/**
 * Validate a candidate local/simulated correction event.
 * Rejects records that appear to carry personal identifiers.
 */
function validateCorrectionEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'correction event must be an object' }] };
  }
  for (const field of CORRECTION_REQUIRED_FIELDS) {
    if (!(field in event) || event[field] === undefined || event[field] === null) {
      errors.push({ path: field, message: 'required' });
    }
  }
  if (event.schemaVersion && event.schemaVersion !== CORRECTION_EVENT_SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `expected ${CORRECTION_EVENT_SCHEMA_VERSION}`,
    });
  }
  const blob = JSON.stringify(event);
  if (/\b(?:actor[_-]?id|user[_-]?id|@[a-z0-9.-]+\.[a-z]{2,})\b/i.test(blob)) {
    errors.push({
      path: 'privacy',
      message: 'correction event must not attach personal identity',
    });
  }
  if (event.consentState && event.consentState !== 'authorized_internal_qa') {
    errors.push({
      path: 'consentState',
      message: 'only authorized_internal_qa consent is accepted in Phase 0A simulations',
    });
  }
  return { ok: errors.length === 0, errors };
}

function createSimulatedCorrectionEvent(partial) {
  return {
    correctionEventId: partial.correctionEventId || 'sim-correction-001',
    schemaVersion: CORRECTION_EVENT_SCHEMA_VERSION,
    fieldChanged: partial.fieldChanged,
    originalValue: partial.originalValue,
    correctedValue: partial.correctedValue,
    originalFieldConfidence: partial.originalFieldConfidence ?? null,
    pipelineVersion: partial.pipelineVersion || 'scan-identify-local-research',
    governedCaseReference: partial.governedCaseReference || null,
    consentState: partial.consentState || 'authorized_internal_qa',
    privacySafeSourceClass: partial.privacySafeSourceClass || 'closet_correction_authorized',
    originalPredictionSummary: partial.originalPredictionSummary || {},
    notes: partial.notes || '',
  };
}

module.exports = {
  CORRECTION_EVENT_SCHEMA_VERSION,
  CORRECTION_REQUIRED_FIELDS,
  validateCorrectionEvent,
  createSimulatedCorrectionEvent,
};
