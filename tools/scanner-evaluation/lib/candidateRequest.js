'use strict';

/**
 * Phase 2A candidate request construction.
 *
 * WHERE THIS SITS
 *
 * The certified v140 handler builds the whole provider request itself: the URL,
 * the model, the timeout, the retry plan, the generationConfig, the image part
 * and the prompt. None of that is reimplemented here and none of it is changed.
 * This module receives the request body the CERTIFIED code produced and returns
 * either that same body (control) or that body with the candidate instruction
 * overlay appended to its leading text part (candidate).
 *
 * WHY AT THE REQUEST BOUNDARY RATHER THAN IN THE PROMPT SOURCE
 *
 * The certified prompt lives inside the certified snapshot, which is immutable.
 * Applying the overlay to the constructed body is the only place a candidate can
 * change the instructions without editing a certified file. It also means the
 * transformation is a pure function of (certified body, candidate version) —
 * deterministic, inspectable, and diffable against the control.
 *
 * WHAT IS DELIBERATELY NOT TOUCHED
 *
 *   - `contents[].parts[].inline_data` — the image bytes. Path B selection picks
 *     exactly one governed image per case and this must not change it.
 *   - `generationConfig` — temperature, maxOutputTokens, responseMimeType and
 *     responseSchema are certified routing behaviour.
 *   - the model, the URL, the headers, the abort signal, the attempt loop.
 *   - the number of parts, their order, and every part after the first.
 *
 * A transform that altered any of those would no longer be "the certified
 * request plus instructions", so `applyCandidateRequest` asserts the shape it
 * received and `assertCertifiedStructurePreserved` re-checks the result.
 */

const crypto = require('crypto');

const candidateInstructions = require('./candidateInstructions');
const candidateRegistry = require('./candidateRegistry');

class CandidateRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CandidateRequestError';
  }
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Locate the single leading text part the overlay attaches to.
 *
 * Fails closed rather than searching: the certified body always puts the prompt
 * first and the image second, so "the first part is not a text part" means the
 * body is not the certified body and the transform must not guess.
 */
function locatePromptPart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CandidateRequestError('certified request body must be an object');
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) {
    throw new CandidateRequestError('certified request body must carry a non-empty contents array');
  }
  const content = body.contents[0];
  if (!content || !Array.isArray(content.parts) || content.parts.length === 0) {
    throw new CandidateRequestError('certified request contents[0] must carry a non-empty parts array');
  }
  const part = content.parts[0];
  if (!part || typeof part !== 'object' || typeof part.text !== 'string' || part.text.trim() === '') {
    throw new CandidateRequestError('certified request contents[0].parts[0] must be a non-empty text part');
  }
  return { content, part, promptText: part.text };
}

/** Extract the certified prompt without transforming anything. */
function certifiedPromptOf(body) {
  return locatePromptPart(body).promptText;
}

/**
 * Apply a candidate's instruction overlay to a certified request body.
 *
 * The control returns the SAME OBJECT it was given — not a clone — so a test can
 * assert reference identity and prove the control path is untouched code rather
 * than a copy that happens to be equal today.
 *
 * @param {{ certifiedRequestBody: object, candidateVersion: string }} options
 * @returns {{ body: object, candidateVersion: string, overlayId: string|null,
 *             overlaySha256: string|null, certifiedPromptSha256: string,
 *             promptSha256: string, transformed: boolean }}
 */
function applyCandidateRequest({ certifiedRequestBody, candidateVersion }) {
  const entry = candidateRegistry.resolveCandidate(candidateVersion);
  const located = locatePromptPart(certifiedRequestBody);
  const certifiedPromptSha256 = sha256Hex(located.promptText);

  if (entry.instructionOverlayId === null) {
    return {
      body: certifiedRequestBody,
      candidateVersion: entry.candidateVersion,
      overlayId: null,
      overlaySha256: null,
      certifiedPromptSha256,
      promptSha256: certifiedPromptSha256,
      transformed: false,
    };
  }

  const overlay = candidateInstructions.resolveOverlay(entry.instructionOverlayId);
  if (overlay.candidateVersion !== entry.candidateVersion) {
    throw new CandidateRequestError(
      `overlay ${overlay.overlayId} declares candidate ${overlay.candidateVersion}, `
      + `but it was resolved for ${entry.candidateVersion}`
    );
  }

  // Append. The certified text stays first, byte for byte.
  const promptText = `${located.promptText}${overlay.text}`;
  const body = {
    ...certifiedRequestBody,
    contents: certifiedRequestBody.contents.map((content, contentIndex) =>
      contentIndex !== 0
        ? content
        : {
          ...content,
          parts: content.parts.map((part, partIndex) =>
            partIndex !== 0 ? part : { ...part, text: promptText }
          ),
        }
    ),
  };

  assertCertifiedStructurePreserved(certifiedRequestBody, body);

  return {
    body,
    candidateVersion: entry.candidateVersion,
    overlayId: overlay.overlayId,
    overlaySha256: overlay.textSha256,
    certifiedPromptSha256,
    promptSha256: sha256Hex(promptText),
    transformed: true,
  };
}

/**
 * Prove the transform changed the prompt text and nothing else.
 *
 * Everything except `contents[0].parts[0].text` must serialize identically, so
 * an accidental change to the image part, the generation config, or a later
 * content block is a loud failure rather than a silent one.
 */
function assertCertifiedStructurePreserved(before, after) {
  const strip = (body) => {
    const clone = JSON.parse(JSON.stringify(body));
    clone.contents[0].parts[0].text = '<prompt>';
    return JSON.stringify(clone);
  };
  if (strip(before) !== strip(after)) {
    throw new CandidateRequestError(
      'candidate request transform changed something other than the leading prompt text'
    );
  }
  const beforePrompt = before.contents[0].parts[0].text;
  const afterPrompt = after.contents[0].parts[0].text;
  if (!afterPrompt.startsWith(beforePrompt)) {
    throw new CandidateRequestError('candidate prompt must begin with the certified prompt, verbatim');
  }
  return true;
}

/**
 * The candidate contribution to the countTokens cache identity and the provider
 * request identity.
 *
 * `promptSha256` alone would be enough to separate control from candidate in
 * practice, but `candidateVersion` is carried explicitly so a future candidate
 * whose overlay happened to produce identical text still cannot reuse another
 * candidate's cached count or accounting.
 *
 * @param {string} candidateVersion
 * @param {string} certifiedPrompt
 */
function candidateRequestIdentity(candidateVersion, certifiedPrompt) {
  if (typeof certifiedPrompt !== 'string' || certifiedPrompt.trim() === '') {
    throw new CandidateRequestError('candidate request identity requires the certified prompt text');
  }
  const entry = candidateRegistry.resolveCandidate(candidateVersion);
  const overlay = entry.instructionOverlayId
    ? candidateInstructions.resolveOverlay(entry.instructionOverlayId)
    : null;
  const promptText = overlay ? `${certifiedPrompt}${overlay.text}` : certifiedPrompt;
  return Object.freeze({
    candidateVersion: entry.candidateVersion,
    overlayId: overlay ? overlay.overlayId : null,
    overlaySha256: overlay ? overlay.textSha256 : null,
    certifiedPromptSha256: sha256Hex(certifiedPrompt),
    promptSha256: sha256Hex(promptText),
  });
}

module.exports = {
  CandidateRequestError,
  sha256Hex,
  locatePromptPart,
  certifiedPromptOf,
  applyCandidateRequest,
  assertCertifiedStructurePreserved,
  candidateRequestIdentity,
};
