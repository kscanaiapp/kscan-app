'use strict';

/**
 * Candidate instruction overlays.
 *
 * WHY AN OVERLAY RATHER THAN A REWRITTEN PROMPT
 *
 * The certified prompt is the thing under test. Rewriting it would produce a
 * candidate whose difference from the control is a whole prompt — impossible to
 * attribute, impossible to review line by line, and impossible to roll back to
 * "certified plus exactly this". An overlay is APPENDED, so the certified
 * instructions still reach the provider first, verbatim, in their certified
 * order, and the entire candidate delta is one reviewable artifact.
 *
 * WHY THE TEXT LIVES IN JSON
 *
 * The Node evaluation harness and the Deno certified harness both need the exact
 * same bytes. Holding the text in a data artifact that both read means there is
 * one overlay, not one per runtime that could drift apart. The artifact carries
 * its own `textSha256`; this module re-derives it on load and refuses a file
 * whose text no longer matches, so an edited overlay cannot masquerade as the
 * one a recorded run identity pins.
 *
 * WHAT AN OVERLAY MAY NOT DO
 *
 * It may not introduce a field, rename a field, change the response shape, or
 * tell the model to suppress an answer the evidence supports. In particular it
 * must never instruct the model to withhold a visible brand: the five
 * contradictory brand cases are excluded by the FROZEN SCORING CONTRACT, on the
 * scoring side, and are not prompt exceptions. Suppressing brands to score
 * better would be benchmark gaming, and `assertOverlayDiscipline()` refuses an
 * overlay that reads that way.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACT_DIR = path.join(__dirname, '..', 'adapter');

/** Overlay id -> artifact filename. The registry names the id; this maps it to bytes. */
const OVERLAY_ARTIFACTS = Object.freeze({
  'phase2a-fashion-specificity-v1': 'phase2a-instruction-overlay.v1.json',
  'phase6-decisive-specificity-v1': 'phase6-scanner-v1.0-a-overlay.v1.json',
});

class UnknownInstructionOverlay extends Error {
  constructor(overlayId) {
    super(
      `unknown instruction overlay ${JSON.stringify(overlayId)}; known overlays: `
      + `${Object.keys(OVERLAY_ARTIFACTS).join(', ')}`
    );
    this.name = 'UnknownInstructionOverlay';
    this.overlayId = overlayId;
  }
}

class OverlayIntegrityError extends Error {
  constructor(overlayId, detail) {
    super(`instruction overlay ${overlayId} failed integrity check: ${detail}`);
    this.name = 'OverlayIntegrityError';
    this.overlayId = overlayId;
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Phrases that would make the overlay a benchmark-suppression instruction rather
 * than an evidence-discipline instruction. Checked as a property of the artifact
 * so the rule survives a future overlay edit by someone who has not read this
 * file.
 */
const FORBIDDEN_PATTERNS = Object.freeze([
  { pattern: /suppress(?:ing)?\s+(?:the\s+)?brand/i, why: 'an overlay may not suppress a visible brand' },
  { pattern: /never\s+(?:return|report|name)\s+(?:a|any)\s+brand/i, why: 'an overlay may not forbid all brands' },
  { pattern: /always\s+(?:return|set)\s+brand_guess\s+to\s+null/i, why: 'an overlay may not blanket-null the brand' },
  { pattern: /\bnot_measured\b/i, why: 'an overlay may not reference scoring dispositions' },
  { pattern: /benchmark|eval(?:uation)?\s+score|test\s+set|ground\s+truth/i, why: 'an overlay may not reference the evaluation itself' },
]);

/**
 * Field names and abstention tokens the overlay is allowed to mention.
 * Anything the overlay names must already exist in the certified provider
 * contract; an overlay that invents a field would produce output the certified
 * parser silently drops.
 */
const CERTIFIED_PROVIDER_FIELDS = Object.freeze([
  'item_type',
  'subtype',
  'primary_color',
  'secondary_colors',
  'pattern',
  'material_estimate',
  'silhouette',
  'fit',
  'length',
  'sleeve_length',
  'neckline_or_lapel',
  'closure',
  'distinctive_features',
  'style_tags',
  'occasion_tags',
  'pockets',
  'visible_brand_text',
  'logo_detected',
  'brand_guess',
  'confidence_score',
  'scan_quality_note',
]);

/**
 * Reject an overlay that reads as benchmark suppression, or that names a field
 * the certified provider contract does not define.
 *
 * @param {{ overlayId: string, text: string }} overlay
 */
function assertOverlayDiscipline(overlay) {
  for (const { pattern, why } of FORBIDDEN_PATTERNS) {
    if (pattern.test(overlay.text)) {
      throw new OverlayIntegrityError(overlay.overlayId, why);
    }
  }
  // Any snake_case token in the overlay must be a certified provider field.
  // This catches an invented field far more reliably than review does.
  const known = new Set(CERTIFIED_PROVIDER_FIELDS);
  const mentioned = new Set(overlay.text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []);
  const invented = [...mentioned].filter((token) => !known.has(token));
  if (invented.length) {
    throw new OverlayIntegrityError(
      overlay.overlayId,
      `names field(s) absent from the certified provider contract: ${invented.sort().join(', ')}`
    );
  }
  return true;
}

const CACHE = new Map();

/**
 * Load an overlay by id. Fails closed on an unknown id, an unreadable artifact,
 * a mismatched declared candidate version, or drifted text.
 *
 * @param {string} overlayId
 * @returns {{ overlayId: string, candidateVersion: string, text: string,
 *             textSha256: string, mechanism: string, lineCount: number }}
 */
function resolveOverlay(overlayId) {
  if (typeof overlayId !== 'string' || !Object.prototype.hasOwnProperty.call(OVERLAY_ARTIFACTS, overlayId)) {
    throw new UnknownInstructionOverlay(overlayId);
  }
  if (CACHE.has(overlayId)) return CACHE.get(overlayId);

  const file = path.join(ARTIFACT_DIR, OVERLAY_ARTIFACTS[overlayId]);
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new OverlayIntegrityError(overlayId, `artifact is unreadable: ${error.code || error.message}`);
  }

  if (artifact.overlayId !== overlayId) {
    throw new OverlayIntegrityError(overlayId, `artifact declares overlayId ${artifact.overlayId}`);
  }
  if (!Array.isArray(artifact.lines) || artifact.lines.length === 0) {
    throw new OverlayIntegrityError(overlayId, 'artifact carries no lines');
  }
  if (artifact.mechanism !== 'append') {
    throw new OverlayIntegrityError(overlayId, `unsupported mechanism ${artifact.mechanism}`);
  }

  // Joined with a single newline, exactly as the Deno harness joins it. The
  // artifact stores lines rather than one escaped blob so a review diff shows
  // the sentence that changed, not a single unreadable line.
  const text = artifact.lines.join('\n');
  const derived = sha256Hex(text);
  if (derived !== artifact.textSha256) {
    throw new OverlayIntegrityError(
      overlayId,
      `text hashes to ${derived} but the artifact records ${artifact.textSha256}`
    );
  }

  const overlay = Object.freeze({
    overlayId,
    candidateVersion: artifact.candidateVersion,
    text,
    textSha256: derived,
    mechanism: artifact.mechanism,
    lineCount: artifact.lines.length,
  });
  assertOverlayDiscipline(overlay);
  CACHE.set(overlayId, overlay);
  return overlay;
}

module.exports = {
  OVERLAY_ARTIFACTS,
  CERTIFIED_PROVIDER_FIELDS,
  FORBIDDEN_PATTERNS,
  UnknownInstructionOverlay,
  OverlayIntegrityError,
  sha256Hex,
  assertOverlayDiscipline,
  resolveOverlay,
};
