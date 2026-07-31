'use strict';

/**
 * The canonical candidate artifact API.
 *
 * WHAT THIS IS
 *
 * One narrow, pure surface that answers everything an integration point needs to
 * know about a scanner version: what it is called, which artifact defines it,
 * what that artifact hashes to, what instructions it carries, and which
 * certified control it is measured against.
 *
 * WHY IT EXISTS SEPARATELY FROM THE REGISTRY AND THE OVERLAY LOADER
 *
 * Phase 2A deliberately split identity (`candidateRegistry`) from instruction
 * bytes (`candidateInstructions`), because they fail for different reasons and
 * must be validated separately. That split is correct, but it means a caller
 * wanting "the candidate" had to know both modules, join them itself, and get
 * the join right every time.
 *
 * A future production integration point is exactly such a caller, and it is the
 * one place where getting the join wrong would be most expensive. This module is
 * that join, written once: `describe()` returns a frozen descriptor, and
 * `artifactSha256` covers the WHOLE descriptor rather than only the instruction
 * text, so a change to the mechanism, the overlay id, the validation policy or
 * the model configuration moves the hash even when the instructions are
 * untouched.
 *
 * PURITY
 *
 * No environment, no globals, no clock, no network, no mutable module state
 * beyond the overlay loader's content-addressed cache. The same version string
 * always yields the same descriptor and the same hash, in any process, on any
 * platform. Determinism is a property this module is REQUIRED to have, because
 * the artifact hash it produces is quoted in run identities and, later, in
 * production telemetry.
 *
 * WHAT IT MUST NEVER CARRY
 *
 * The certified prompt, provider credentials, model secrets, image data,
 * benchmark labels, case-specific instructions, retailer logic or commerce
 * logic. `assertArtifactContainsNoForbiddenContent` enforces the ones that are
 * decidable from the artifact text, and the descriptor exposes no field that
 * could hold the others.
 */

const crypto = require('crypto');

const candidateInstructions = require('./candidateInstructions');
const candidateRegistry = require('./candidateRegistry');

/** The shape version of the DESCRIPTOR, independent of any one candidate. */
const DESCRIPTOR_SCHEMA_VERSION = '1.0.0';

class CandidateArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CandidateArtifactError';
  }
}

/**
 * Deterministic JSON serialization: keys sorted at every level, no incidental
 * whitespace.
 *
 * `JSON.stringify` preserves insertion order, so two descriptors with identical
 * content but different key order would serialize differently and hash
 * differently. Sorting removes that as a source of drift, which matters because
 * this hash is meant to be stable across processes and code revisions, not
 * merely within one run.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Content that must never appear in a candidate instruction artifact.
 *
 * Only the decidable cases are checked here. The undecidable ones — provider
 * credentials, image data, model secrets — are excluded structurally instead:
 * the artifact is a list of instruction lines and the descriptor exposes no
 * field that could carry them.
 */
const FORBIDDEN_ARTIFACT_CONTENT = Object.freeze([
  {
    pattern: /You are K Scan AI's fashion identification engine/i,
    why: 'the certified prompt may not be duplicated into the candidate artifact',
  },
  {
    pattern: /\b(?:AIza[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z]{16,}|Bearer\s+[0-9A-Za-z._-]{16,})/,
    why: 'the artifact may not carry a credential',
  },
  {
    pattern: /\bdata:image\/[a-z]+;base64,/i,
    why: 'the artifact may not carry image data',
  },
  {
    pattern: /\b(?:farfetch|kickscrew|shopify|amazon|retailer_id|affiliate)\b/i,
    why: 'the artifact may not carry retailer or commerce logic',
  },
  {
    pattern: /\bcase-[0-9a-f]{8,}|\btiera-[a-z_]+-[0-9a-f]{6,}/i,
    why: 'the artifact may not carry case-specific instructions or benchmark labels',
  },
]);

/**
 * Reject an artifact carrying content that does not belong to it.
 *
 * @param {{ overlayId: string, text: string }} overlay
 */
function assertArtifactContainsNoForbiddenContent(overlay) {
  for (const { pattern, why } of FORBIDDEN_ARTIFACT_CONTENT) {
    if (pattern.test(overlay.text)) {
      throw new CandidateArtifactError(`artifact ${overlay.overlayId} is invalid: ${why}`);
    }
  }
  return true;
}

const DESCRIPTOR_CACHE = new Map();

/**
 * Describe one scanner version.
 *
 * Returns a frozen descriptor. The control describes itself with a null
 * instruction artifact — it is a real, selectable version, not an absence — so a
 * caller can treat control and candidate uniformly without branching on which
 * one it holds.
 *
 * @param {string} candidateVersion an explicit, registered version
 */
function describe(candidateVersion) {
  const entry = candidateRegistry.resolveCandidate(candidateVersion);
  if (DESCRIPTOR_CACHE.has(entry.candidateVersion)) return DESCRIPTOR_CACHE.get(entry.candidateVersion);

  let overlay = null;
  if (entry.instructionOverlayId !== null) {
    overlay = candidateInstructions.resolveOverlay(entry.instructionOverlayId);
    assertArtifactContainsNoForbiddenContent(overlay);
    if (overlay.candidateVersion !== entry.candidateVersion) {
      throw new CandidateArtifactError(
        `artifact ${overlay.overlayId} declares candidate ${overlay.candidateVersion}, `
        + `but was resolved for ${entry.candidateVersion}`
      );
    }
  }

  // The hashed body deliberately EXCLUDES the instruction text and includes its
  // digest instead. The text is already covered by `instructionSha256`, and
  // keeping it out means the artifact hash can be logged and compared freely
  // without the hash itself becoming a channel for the instruction content.
  const hashedBody = {
    descriptorSchemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    candidateVersion: entry.candidateVersion,
    controlVersion: candidateRegistry.CONTROL_VERSION,
    role: entry.role,
    modelConfigurationId: entry.modelConfigurationId,
    postValidationPolicy: entry.postValidationPolicy,
    overlayId: overlay ? overlay.overlayId : null,
    mechanism: overlay ? overlay.mechanism : null,
    instructionSha256: overlay ? overlay.textSha256 : null,
  };

  const descriptor = Object.freeze({
    ...hashedBody,
    /** Deterministic instruction content. Null for the certified control. */
    instructionText: overlay ? overlay.text : null,
    instructionLineCount: overlay ? overlay.lineCount : 0,
    /** Covers everything above except the instruction text itself. */
    artifactSha256: sha256Hex(canonicalize(hashedBody)),
  });

  DESCRIPTOR_CACHE.set(entry.candidateVersion, descriptor);
  return descriptor;
}

/** Every registered version, described. Control first, order stable. */
function describeAll() {
  return candidateRegistry.versions().map(describe);
}

/**
 * The supported certified control identifier.
 *
 * Exposed as a function rather than a re-exported constant so an integration
 * point asks the artifact layer what the control is, instead of hardcoding a
 * string that could drift away from the registry.
 */
function controlVersion() {
  return candidateRegistry.CONTROL_VERSION;
}

module.exports = {
  DESCRIPTOR_SCHEMA_VERSION,
  FORBIDDEN_ARTIFACT_CONTENT,
  CandidateArtifactError,
  canonicalize,
  sha256Hex,
  assertArtifactContainsNoForbiddenContent,
  describe,
  describeAll,
  controlVersion,
};
