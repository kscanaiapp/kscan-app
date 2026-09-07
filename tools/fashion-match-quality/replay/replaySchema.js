'use strict';

const { scanForPrivacyViolations } = require('../schema/privacyGuard');

const SCHEMA_VERSION = 'fmql-replay-schema-v1';

/**
 * A replay record captures a previously-observed (sanitized) request/response
 * pair for offline replay (spec section 22, L2). This build did not find
 * any existing sanitized scan-identify request/response fixtures committed
 * to the repository that would be safe to replay (see BLOCKER LEDGER:
 * REPLAY CORPUS: NONE) - this schema/runner exist so a future owner-supplied
 * or hand-sanitized corpus can be dropped in without redesigning the lab.
 *
 * A replay record must NEVER carry raw image bytes, auth material, or any
 * of the privacy-guard-prohibited fields - it captures the STRUCTURED
 * request/response shape only (garmentIdentification + candidateProducts +
 * the response actually returned), exactly like a fixture.
 */
function validateReplayRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return { valid: false, errors: ['replay record must be a non-null object'] };
  }
  if (typeof record.replayId !== 'string' || !record.replayId) {
    errors.push('replayId is required');
  }
  if (typeof record.capturedAt !== 'string') {
    errors.push('capturedAt (ISO timestamp) is required');
  }
  if (!record.request || typeof record.request !== 'object') {
    errors.push('request is required');
  }
  if (!record.observedResponse || typeof record.observedResponse !== 'object') {
    errors.push('observedResponse is required');
  }
  if (!record.sanitization || record.sanitization.reviewedBy === undefined) {
    errors.push('sanitization.reviewedBy is required (who attested this record is safe to replay)');
  }

  const privacy = scanForPrivacyViolations(record);
  if (!privacy.safe) {
    for (const v of privacy.violations) errors.push(`privacy_violation at ${v.path}: ${v.reason}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { SCHEMA_VERSION, validateReplayRecord };
