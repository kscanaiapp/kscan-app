'use strict';

/**
 * OWNER-CAPTURED TRANSCRIPT IMPORTER — spec sections 8 / 32-33.
 *
 * The harness may ingest REAL transcripts supplied separately by the owner,
 * labeled sourceTier: OWNER_CAPTURED, capturedBy: OWNER, system:
 * ELISE|CONCIERGE, captureDate, contextKnown: YES/NO. The harness itself
 * must NEVER generate these. No owner transcripts are supplied in this
 * dispatch: REAL EXTRACTION VALIDATION / SYSTEM QUALITY CORPUS is
 * READY_NO_CORPUS, which spec sections 8/32/33 say explicitly is NOT a
 * blocker for V1 completion. This module exists so the importer is ready
 * the moment transcripts arrive, without a code redesign.
 *
 * Owner-captured text must be MANUALLY SANITIZED before import (spec section
 * 55) -- this importer still runs the privacy guard and REJECTS (never
 * silently redacts) anything that looks unsanitized.
 */

const { checkPrivacy } = require('../schema/privacyGuard');

const REQUIRED_FIELDS = ['sourceTier', 'capturedBy', 'system', 'captureDate', 'contextKnown', 'text'];

/**
 * @typedef {Object} OwnerTranscript
 * @property {'OWNER_CAPTURED'} sourceTier
 * @property {'OWNER'} capturedBy
 * @property {'ELISE'|'CONCIERGE'} system
 * @property {string} captureDate - ISO date
 * @property {'YES'|'NO'} contextKnown - whether the owner also captured the Closet/Signature Style context this response was grounded in
 * @property {string} text - the sanitized transcript text
 * @property {object} [knownContext] - optional Closet/Signature Style snapshot, required if contextKnown === 'YES'
 */

function validateOwnerTranscript(transcript) {
  const errors = [];
  if (typeof transcript !== 'object' || transcript === null) {
    return { valid: false, errors: ['transcript is not an object'] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in transcript)) errors.push(`missing required field "${field}"`);
  }
  if (transcript.sourceTier !== 'OWNER_CAPTURED') errors.push('sourceTier must be exactly "OWNER_CAPTURED"');
  if (transcript.capturedBy !== 'OWNER') errors.push('capturedBy must be exactly "OWNER" (the harness itself must never author these)');
  if (!['ELISE', 'CONCIERGE'].includes(transcript.system)) errors.push('system must be ELISE or CONCIERGE');
  if (!['YES', 'NO'].includes(transcript.contextKnown)) errors.push('contextKnown must be YES or NO');
  if (transcript.contextKnown === 'YES' && !transcript.knownContext) {
    errors.push('contextKnown is YES but no knownContext snapshot was supplied');
  }
  if (typeof transcript.text !== 'string' || !transcript.text.trim()) errors.push('text must be a non-empty string');

  const privacy = checkPrivacy(transcript);
  if (!privacy.safe) {
    errors.push(
      `PRIVACY GUARD REJECTED this transcript (must be manually sanitized before import, spec section 55): ${privacy.violations
        .map((v) => `${v.path}:${v.patternId || v.reason}`)
        .join(', ')}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Import a batch of owner transcripts, preserving provenance fields exactly
 * and rejecting (never silently dropping or redacting) anything invalid.
 * @param {OwnerTranscript[]} transcripts
 * @returns {{ imported: OwnerTranscript[], rejected: Array<{transcript: unknown, errors: string[]}> }}
 */
function importOwnerTranscripts(transcripts) {
  const imported = [];
  const rejected = [];
  for (const t of transcripts || []) {
    const result = validateOwnerTranscript(t);
    if (result.valid) {
      imported.push({ ...t }); // provenance fields preserved verbatim
    } else {
      rejected.push({ transcript: t, errors: result.errors });
    }
  }
  return { imported, rejected };
}

/** Status string for the final report, per spec section 8/32/33. */
function corpusReadinessStatus(importedCount) {
  return importedCount > 0 ? `OWNER_CAPTURED_PRESENT(${importedCount})` : 'READY_NO_CORPUS';
}

module.exports = { validateOwnerTranscript, importOwnerTranscripts, corpusReadinessStatus, REQUIRED_FIELDS };
