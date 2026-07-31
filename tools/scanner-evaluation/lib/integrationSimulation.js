'use strict';

/**
 * Production-integration simulation.
 *
 * WHAT THIS IS
 *
 * The pipeline a future production integration would run, assembled from the
 * REAL parts that already exist — the trusted resolver, the canonical candidate
 * artifact, the candidate request transform, the schema boundary, the scoring
 * projection and the terminal classifier — with the provider transport injected.
 *
 * It does not import the production Edge Function entry point, and it does not
 * modify any production file. It exists to prove the SHAPE of the integration is
 * sound before deployable source is touched: one resolution, one request path,
 * one dispatch, one terminal result, one sanitized metadata record.
 *
 * WHY A SIMULATION RATHER THAN A PATCH
 *
 * The governing production baseline is not yet established, so any patch written
 * now would be authored against a SHA that will move. The behaviour, however,
 * does not move — so the behaviour is what gets specified and tested here, and
 * the integration map (see the Phase 2B manifest) records where it would attach.
 *
 * THE INVARIANT THIS EXISTS TO PROTECT
 *
 * Exactly one provider dispatch per request, for exactly one resolved version.
 * A control-plus-candidate double dispatch would double provider cost, double
 * latency, and produce two answers for one user scan with no rule for choosing
 * between them. `dispatchCount` is returned on every result so a caller — and
 * every test below — can assert it rather than trust it.
 */

const candidateArtifact = require('./candidateArtifact');
const candidateRegistry = require('./candidateRegistry');
const candidateRequest = require('./candidateRequest');
const candidateValidation = require('./candidateValidation');
const liveAdapter = require('./liveAdapter');
const normalizedResultValidation = require('./normalizedResultValidation');
const scoringProjection = require('./scoringProjection');
const trustedVersionResolver = require('./trustedVersionResolver');

const SIMULATION_VERSION = '1.0.0';

class SimulationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimulationError';
  }
}

/**
 * A stand-in for the request body production's certified prompt construction
 * produces.
 *
 * Deliberately NOT imported from the Edge Function: this phase may not touch
 * production source, and the simulation only needs the request SHAPE the
 * candidate transform operates on — a leading text part followed by the image
 * part. The real certified prompt is exercised end to end by the Deno harness,
 * which loads the certified bundle itself.
 */
function defaultCertifiedRequestBody({ imageBase64 = 'BASE64IMAGEBYTES' } = {}) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: "You are K Scan AI's fashion identification engine.\n\nReturn strict JSON only." },
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };
}

/**
 * Wrap a transport so it can be called at most once per logical request.
 *
 * Factored out as its own unit because it is THE invariant of this module, and
 * an invariant that can only be exercised through the full pipeline is one that
 * is easy to weaken by accident. A second call throws rather than being counted
 * and reported afterwards: by the time a report is read, the second provider
 * call has already been paid for.
 *
 * @param {(input: {version: string, body: object, attempt: number}) => object} transport
 */
function createDispatchGuard(transport) {
  let count = 0;
  const versions = [];
  return {
    dispatch(input) {
      count += 1;
      versions.push(input.version);
      if (count > 1) {
        throw new SimulationError(
          `one request produced ${count} provider dispatches; control-plus-candidate execution is forbidden`
        );
      }
      return transport(input);
    },
    count: () => count,
    versions: () => [...versions],
  };
}

/**
 * Run one simulated scan request.
 *
 * @param {object} options
 * @param {object|null} options.trustedConfig trusted SERVER-SIDE configuration
 * @param {object} [options.clientRequest] client-controlled data. Passed in so a
 *   test can prove it reaches NOTHING that decides the version.
 * @param {(input: {version: string, body: object, attempt: number}) => object} options.dispatch
 *   injected provider transport. Returns a report shaped like the certified
 *   harness's: `{ v2Present, observed, providerAttempts, counters }`.
 * @param {(context: object) => object} [options.buildCertifiedRequestBody]
 * @param {string[]} [options.supportedVersions]
 */
function simulateScanRequest({
  trustedConfig,
  clientRequest = {},
  dispatch,
  buildCertifiedRequestBody = defaultCertifiedRequestBody,
  supportedVersions,
} = {}) {
  if (typeof dispatch !== 'function') {
    throw new SimulationError('a provider transport must be injected; the simulation ships none');
  }

  // ── 1. Trusted resolution, sealed for this execution ─────────────────────
  // The client request is NOT passed to the resolver. It is not a parameter of
  // resolution and never becomes one.
  const execution = trustedVersionResolver.createExecutionResolution(
    trustedConfig,
    supportedVersions ? { supportedVersions } : {}
  );
  const resolution = execution.resolve();
  const version = resolution.resolvedVersion;

  // A resolved version is always supported — the resolver guarantees it — so
  // this describe() cannot throw. Asserting it here anyway means a future
  // resolver change that broke the guarantee fails loudly at the seam.
  if (!candidateRegistry.isKnown(version)) {
    throw new SimulationError(`resolver returned an unsupported version: ${version}`);
  }
  const descriptor = candidateArtifact.describe(version);

  // ── 2. One request path ──────────────────────────────────────────────────
  const certifiedBody = buildCertifiedRequestBody({ clientRequest });
  const certifiedPrompt = candidateRequest.certifiedPromptOf(certifiedBody);
  const prepared = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: certifiedBody,
    candidateVersion: version,
  });
  const requestIdentity = candidateRequest.candidateRequestIdentity(version, certifiedPrompt);

  // ── 3. Exactly one dispatch ──────────────────────────────────────────────
  const guard = createDispatchGuard(dispatch);

  let report;
  let handlerError = null;
  try {
    report = guard.dispatch({ version, body: prepared.body, attempt: 1 });
  } catch (error) {
    if (error instanceof SimulationError) throw error;
    handlerError = 'dispatch_failed';
    report = { handlerError, v2Present: false, observed: null, providerAttempts: [], counters: {} };
  }
  const dispatchCount = guard.count();
  const dispatchedVersions = guard.versions();
  if (!report || !Array.isArray(report.providerAttempts)) {
    throw new SimulationError('the injected transport returned an invalid report');
  }

  // ── 4. Terminal classification, then the schema boundary ─────────────────
  let outcome = liveAdapter.classifyOutcome(report);
  let validation = null;
  let projection = null;
  let candidateFindings = null;

  if (outcome.status === 'provider_success') {
    validation = normalizedResultValidation.validateNormalizedResult(report.observed);
    if (!validation.ok) {
      outcome = { status: 'provider_output_invalid', retryable: false, stage: 'validation' };
    } else {
      candidateFindings = candidateValidation.findCandidateViolations(validation.value, {
        candidateVersion: version,
      });
      projection = scoringProjection.projectV2ForScoring(validation.value, {
        schemaParseFailure: false,
        // The certified fallback is represented SEPARATELY from candidate
        // selection: reaching the fallback model is a transport event within one
        // logical request, not a second selected version.
        fallbackInvoked: report.providerAttempts.length > 1,
      });
    }
  }

  // ── 5. Sanitized execution metadata ──────────────────────────────────────
  // Ids, hashes, enums, counts and booleans only. No prompt, no instruction
  // text, no image bytes, no raw provider response, no credential, no PII.
  const metadata = Object.freeze({
    simulationVersion: SIMULATION_VERSION,
    ...trustedVersionResolver.selectionTelemetry(resolution),
    scannerArtifactSha256: descriptor.artifactSha256,
    scannerInstructionSha256: descriptor.instructionSha256,
    requestPromptSha256: requestIdentity.promptSha256,
    certifiedPromptSha256: requestIdentity.certifiedPromptSha256,
    overlayApplied: prepared.transformed,
    overlayApplicationCount: prepared.transformed ? 1 : 0,
    dispatchCount,
    attemptCount: report.providerAttempts.length,
    fallbackInvoked: report.providerAttempts.length > 1,
    status: outcome.status,
    failureStage: outcome.stage,
    parseStatus:
      outcome.stage === 'transport' || outcome.stage === 'isolation'
        ? 'not_reached'
        : outcome.stage === 'validation'
          ? 'invalid'
          : report.v2Present ? 'parsed' : 'invalid',
    candidateFindingCount: candidateFindings && Array.isArray(candidateFindings.findings)
      ? candidateFindings.findings.length
      : 0,
    handlerError,
  });

  return {
    resolution,
    descriptor,
    requestIdentity,
    requestBody: prepared.body,
    certifiedRequestBody: certifiedBody,
    dispatchCount,
    dispatchedVersions,
    report,
    outcome,
    validation,
    projection,
    candidateFindings,
    metadata,
  };
}

module.exports = {
  SIMULATION_VERSION,
  SimulationError,
  createDispatchGuard,
  defaultCertifiedRequestBody,
  simulateScanRequest,
};
