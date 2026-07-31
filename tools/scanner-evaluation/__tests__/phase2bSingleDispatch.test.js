'use strict';

/**
 * Phase 2B: the single-dispatch integration contract.
 *
 * The invariant under test is narrow and expensive to get wrong: ONE provider
 * dispatch per request, for ONE resolved version. A control-plus-candidate
 * double dispatch would double provider cost and latency and produce two answers
 * for one user scan with no rule for choosing between them.
 *
 * The last section is adversarial: each block simulates a specific integration
 * mistake and asserts the contract catches it, so a future integration that
 * reintroduces one fails here rather than in production.
 *
 * The provider transport is injected and mocked throughout. Nothing here makes a
 * network call, and one test proves it against the real certified bundle.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const candidateArtifact = require('../lib/candidateArtifact');
const candidateRegistry = require('../lib/candidateRegistry');
const candidateRequest = require('../lib/candidateRequest');
const preflightReservation = require('../lib/preflightReservation');
const simulation = require('../lib/integrationSimulation');
const trustedVersionResolver = require('../lib/trustedVersionResolver');

const CONTROL = candidateRegistry.CONTROL_VERSION;
const CANDIDATE = candidateRegistry.PHASE2A_VERSION;
const ROOT = path.join(__dirname, '..', '..', '..');
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT || 'C:/Users/jsmit/KScan-eval-storage-private';
const SNAPSHOT_ROOT = path.join(STORAGE_ROOT, 'snapshots', 'certified-v140-f5f4ed2');
const OVERLAY_FILE = path.join(ROOT, 'tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json');

const PHASE2A_MARKER = 'K SCAN AI PHASE 2A CANDIDATE INSTRUCTIONS';

function v2Result(overrides = {}) {
  return {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-0001',
    status: 'completed',
    resolutionLevel: 'subtype',
    item: {
      category: 'footwear',
      subtype: 'low_top_sneaker',
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: 'red', secondary: ['white'] },
      material: ['canvas'],
      silhouette: ['low profile'],
      pattern: ['solid'],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
    confidence: { category: 0.82, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    exactProduct: null,
    evidence: [{ evidenceId: 'ev-1', observations: ['A red low-top sneaker.'] }],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.82 },
    ...overrides,
  };
}

/** A recording transport, so every dispatch and the prompt it carried is inspectable. */
function recordingDispatch({ attempts = 1, observed = v2Result() } = {}) {
  const calls = [];
  const dispatch = ({ version, body, attempt }) => {
    calls.push({ version, attempt, prompt: body.contents[0].parts[0].text });
    return {
      v2Present: true,
      observed,
      counters: { unexpectedNetworkAttempts: 0 },
      providerAttempts: Array.from({ length: attempts }, (_, index) => ({
        model: index === 0 ? 'gemini-3.6-flash' : 'gemini-3.5-flash-lite',
        httpStatus: index < attempts - 1 ? 503 : 200,
        latencyMs: 1,
        errorCategory: index < attempts - 1 ? 'provider_5xx' : null,
        certifiedFailureKind: index < attempts - 1 ? 'http_5xx_transient' : null,
      })),
    };
  };
  return { dispatch, calls };
}

// ── The happy paths ─────────────────────────────────────────────────────────

test('no trusted configuration runs certified v140 through one dispatch', () => {
  const { dispatch, calls } = recordingDispatch();
  const result = simulation.simulateScanRequest({ trustedConfig: null, dispatch });

  assert.equal(result.resolution.resolvedVersion, CONTROL);
  assert.equal(result.metadata.scannerVersionReason, trustedVersionResolver.RESOLUTION_REASONS.NO_TRUSTED_CONFIGURATION);
  assert.equal(result.dispatchCount, 1);
  assert.deepEqual(result.dispatchedVersions, [CONTROL]);
  assert.equal(calls.length, 1);

  // The certified request reached the provider unchanged.
  assert.equal(result.requestBody, result.certifiedRequestBody, 'the control dispatches the certified object itself');
  assert.equal(calls[0].prompt.includes(PHASE2A_MARKER), false);
  assert.equal(result.metadata.overlayApplied, false);
  assert.equal(result.metadata.overlayApplicationCount, 0);
  assert.equal(result.metadata.status, 'provider_success');
  assert.equal(result.metadata.parseStatus, 'parsed');
});

test('trusted selection runs the candidate through one dispatch, overlay applied once', () => {
  const { dispatch, calls } = recordingDispatch();
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch,
  });

  assert.equal(result.resolution.resolvedVersion, CANDIDATE);
  assert.equal(result.metadata.scannerVersionReason, trustedVersionResolver.RESOLUTION_REASONS.EXPLICIT_CANDIDATE);
  assert.equal(result.dispatchCount, 1);
  assert.equal(calls.length, 1);

  // Applied exactly once — not zero, not twice.
  const occurrences = calls[0].prompt.split(PHASE2A_MARKER).length - 1;
  assert.equal(occurrences, 1, 'the overlay must appear exactly once in the dispatched prompt');
  assert.equal(result.metadata.overlayApplied, true);
  assert.equal(result.metadata.overlayApplicationCount, 1);

  // The certified prompt is still first, verbatim.
  const certifiedPrompt = result.certifiedRequestBody.contents[0].parts[0].text;
  assert.equal(calls[0].prompt.startsWith(certifiedPrompt), true);
  assert.equal(result.metadata.status, 'provider_success');
});

test('the candidate changes the instructions and nothing else about the request', () => {
  const control = simulation.simulateScanRequest({ trustedConfig: null, dispatch: recordingDispatch().dispatch });
  const candidate = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });

  const strip = (body) => {
    const clone = JSON.parse(JSON.stringify(body));
    clone.contents[0].parts[0].text = '<prompt>';
    return JSON.stringify(clone);
  };
  assert.equal(strip(candidate.requestBody), strip(control.requestBody));
  assert.deepEqual(candidate.requestBody.generationConfig, control.requestBody.generationConfig);
  assert.deepEqual(candidate.requestBody.contents[0].parts[1], control.requestBody.contents[0].parts[1]);
  assert.equal(candidate.requestBody.contents[0].parts.length, 2);
});

test('the certified fallback is represented separately from candidate selection', () => {
  // Reaching the fallback MODEL is a transport event inside one logical request.
  // It is not a second selected version and must not read as one.
  const { dispatch, calls } = recordingDispatch({ attempts: 2 });
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch,
  });

  assert.equal(result.dispatchCount, 1, 'the certified fallback is one dispatch, not two');
  assert.equal(calls.length, 1);
  assert.equal(result.metadata.attemptCount, 2);
  assert.equal(result.metadata.fallbackInvoked, true);
  assert.equal(result.metadata.scannerVersion, CANDIDATE);
  assert.deepEqual(result.dispatchedVersions, [CANDIDATE]);
});

// ── Identity ────────────────────────────────────────────────────────────────

test('request identity includes the resolved version and cannot collide', () => {
  const control = simulation.simulateScanRequest({ trustedConfig: null, dispatch: recordingDispatch().dispatch });
  const candidate = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });

  assert.equal(control.requestIdentity.candidateVersion, CONTROL);
  assert.equal(candidate.requestIdentity.candidateVersion, CANDIDATE);
  assert.equal(
    control.requestIdentity.certifiedPromptSha256,
    candidate.requestIdentity.certifiedPromptSha256,
    'both start from one certified prompt'
  );
  assert.notEqual(control.requestIdentity.promptSha256, candidate.requestIdentity.promptSha256);

  // And the countTokens cache identity cannot collide, even though model, image,
  // snapshot, dataset and selection contract are all identical.
  const base = {
    model: 'gemini-3.6-flash',
    serializedRequestPayload: 'payload',
    imageSha256: 'a'.repeat(64),
    systemInstructionSha256: 'b'.repeat(64),
    toolDeclarationsSha256: 'd'.repeat(64),
    generationConfigSha256: 'e'.repeat(64),
    certifiedSourceSha256: 'f'.repeat(64),
    datasetVersion: '0.3.1',
    selectionContractSha256: '9'.repeat(64),
  };
  const cacheOf = (side) => preflightReservation.exactRequestIdentity({
    ...base,
    promptSha256: side.requestIdentity.promptSha256,
    candidateVersion: side.resolution.resolvedVersion,
  });
  assert.notEqual(cacheOf(control), cacheOf(candidate));
});

test('result identity includes the resolved version', () => {
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });
  assert.equal(result.metadata.scannerVersion, CANDIDATE);
  assert.equal(result.metadata.scannerArtifactSha256, candidateArtifact.describe(CANDIDATE).artifactSha256);
  assert.equal(result.metadata.scannerInstructionSha256, candidateArtifact.describe(CANDIDATE).instructionSha256);
});

// ── Sanitized metadata ──────────────────────────────────────────────────────

test('execution metadata carries no prompt, instruction, image, response, credential or PII', () => {
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    clientRequest: {
      userId: 'user-12345',
      email: 'someone@example.com',
      accessToken: 'secret-token-value',
      imageBase64: 'SENSITIVEIMAGEBYTES',
    },
    dispatch: recordingDispatch().dispatch,
  });

  const serialized = JSON.stringify(result.metadata);
  for (const [description, needle] of Object.entries({
    'the certified prompt': "You are K Scan AI's",
    'the candidate instructions': PHASE2A_MARKER,
    'a fashion instruction line': 'subtype must be a narrower kind',
    'image bytes': 'SENSITIVEIMAGEBYTES',
    'a user id': 'user-12345',
    'an email': 'someone@example.com',
    'a token': 'secret-token-value',
  })) {
    assert.equal(serialized.includes(needle), false, `metadata must not contain ${description}`);
  }

  // What it DOES carry is ids, hashes, enums, counts and booleans.
  assert.equal(Object.isFrozen(result.metadata), true);
  for (const [key, value] of Object.entries(result.metadata)) {
    assert.ok(
      value === null || ['string', 'number', 'boolean'].includes(typeof value),
      `metadata.${key} must be a scalar, got ${typeof value}`
    );
  }
});

test('the simulation reaches no Supabase, commerce or production endpoint', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'integrationSimulation.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of [/supabase/i, /https?:\/\//, /\bfetch\s*\(/, /farfetch|kickscrew|commerce/i]) {
    assert.equal(forbidden.test(code), false, `the simulation must not reference ${forbidden}`);
  }
  // It ships no transport at all, so it cannot dispatch by accident.
  assert.throws(
    () => simulation.simulateScanRequest({ trustedConfig: null }),
    /a provider transport must be injected/
  );
});

// ── Mutation and negative proofs ────────────────────────────────────────────

test('MUTATION: the dispatch guard refuses a second provider call', () => {
  // The guard is tested directly, because an invariant reachable only through
  // the full pipeline is easy to weaken by accident.
  let transportCalls = 0;
  const guard = simulation.createDispatchGuard(() => {
    transportCalls += 1;
    return { v2Present: true, observed: v2Result(), counters: {}, providerAttempts: [] };
  });

  guard.dispatch({ version: CONTROL, body: {}, attempt: 1 });
  assert.equal(guard.count(), 1);
  assert.equal(transportCalls, 1);

  // The control-plus-candidate comparison an integration might be tempted to add.
  assert.throws(
    () => guard.dispatch({ version: CANDIDATE, body: {}, attempt: 1 }),
    simulation.SimulationError
  );
  assert.throws(
    () => guard.dispatch({ version: CANDIDATE, body: {}, attempt: 1 }),
    /control-plus-candidate execution is forbidden/
  );
  assert.equal(transportCalls, 1, 'the refused calls must never reach the transport, or they are already paid for');
});

test('MUTATION: no outcome shape produces more than one dispatch', () => {
  // Every terminal the pipeline can reach, each asserted to cost exactly one
  // provider call. A retry sneaking into any branch would show up here.
  const shapes = {
    success: () => ({
      v2Present: true, observed: v2Result(), counters: {},
      providerAttempts: [{ model: 'gemini-3.6-flash', httpStatus: 200, latencyMs: 1 }],
    }),
    'certified fallback': () => ({
      v2Present: true, observed: v2Result(), counters: {},
      providerAttempts: [
        { model: 'gemini-3.6-flash', httpStatus: 503, latencyMs: 1, errorCategory: 'provider_5xx', certifiedFailureKind: 'http_5xx_transient' },
        { model: 'gemini-3.5-flash-lite', httpStatus: 200, latencyMs: 1 },
      ],
    }),
    'invalid output': () => ({
      v2Present: true, observed: { nope: true }, counters: {},
      providerAttempts: [{ model: 'gemini-3.6-flash', httpStatus: 200, latencyMs: 1 }],
    }),
    timeout: () => ({
      v2Present: false, observed: null, counters: {},
      providerAttempts: [{ model: 'gemini-3.6-flash', httpStatus: 0, latencyMs: 1, errorCategory: 'timeout' }],
    }),
    'permanent quota': () => ({
      v2Present: false, observed: null, counters: {},
      providerAttempts: [{ model: 'gemini-3.6-flash', httpStatus: 429, latencyMs: 1, certifiedFailureKind: 'http_429_quota' }],
    }),
    'transport throw': () => { throw new Error('socket reset'); },
  };

  for (const version of [CONTROL, CANDIDATE]) {
    for (const [description, dispatch] of Object.entries(shapes)) {
      let calls = 0;
      const counted = (input) => { calls += 1; return dispatch(input); };
      const result = simulation.simulateScanRequest({
        trustedConfig: version === CONTROL ? null : { scannerVersion: version },
        dispatch: counted,
      });
      assert.equal(calls, 1, `${version} / ${description} must cost exactly one provider call`);
      assert.equal(result.dispatchCount, 1);
      assert.deepEqual(result.dispatchedVersions, [version]);
    }
  }
});

test('MUTATION: the candidate never becomes the default', () => {
  for (const noSelection of [null, undefined, {}, { rolloutNote: 'canary' }]) {
    const result = simulation.simulateScanRequest({ trustedConfig: noSelection, dispatch: recordingDispatch().dispatch });
    assert.equal(result.resolution.resolvedVersion, CONTROL, 'absent selection must never yield the candidate');
    assert.equal(result.metadata.overlayApplied, false);
  }
});

test('MUTATION: client-controlled data cannot activate the candidate', () => {
  const { dispatch, calls } = recordingDispatch();
  const result = simulation.simulateScanRequest({
    // The client asks for the candidate every way it can.
    clientRequest: {
      scannerVersion: CANDIDATE,
      headers: { 'x-scanner-version': CANDIDATE },
      query: { scannerVersion: CANDIDATE },
      featureFlags: { scannerV2: true },
    },
    trustedConfig: null,
    dispatch,
  });

  assert.equal(result.resolution.resolvedVersion, CONTROL);
  assert.equal(calls[0].prompt.includes(PHASE2A_MARKER), false, 'no client channel may reach the provider prompt');

  // And passing the client request AS the trusted configuration still fails closed.
  const misWired = simulation.simulateScanRequest({
    trustedConfig: { requestId: 'r-1', scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });
  assert.equal(misWired.resolution.resolvedVersion, CONTROL);
  assert.equal(
    misWired.metadata.scannerVersionReason,
    trustedVersionResolver.RESOLUTION_REASONS.UNTRUSTED_INPUT_REJECTED
  );
});

test('MUTATION: an unknown version never dispatches', () => {
  const { dispatch, calls } = recordingDispatch();
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: 'phase2a-v9.9.9' },
    dispatch,
  });
  assert.equal(result.resolution.resolvedVersion, CONTROL);
  assert.equal(result.metadata.scannerVersionFellBack, true);
  assert.equal(calls.length, 1, 'it still serves the request');
  assert.deepEqual(result.dispatchedVersions, [CONTROL], 'but never under the unknown identifier');
  assert.equal(calls[0].prompt.includes(PHASE2A_MARKER), false);
});

test('MUTATION: a duplicated overlay is detectable', () => {
  const certifiedBody = simulation.defaultCertifiedRequestBody();
  const once = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: certifiedBody,
    candidateVersion: CANDIDATE,
  });
  // Applying the transform to an already-transformed body is the integration
  // mistake: the overlay would reach the model twice.
  const twice = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: once.body,
    candidateVersion: CANDIDATE,
  });

  const countIn = (body) => body.contents[0].parts[0].text.split(PHASE2A_MARKER).length - 1;
  assert.equal(countIn(once.body), 1);
  assert.equal(countIn(twice.body), 2, 'double application is real, so the detection below is meaningful');
  assert.notEqual(twice.promptSha256, once.promptSha256, 'the prompt hash exposes the duplication');

  // The simulation applies it exactly once per execution.
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });
  assert.equal(result.metadata.overlayApplicationCount, 1);
  assert.equal(countIn(result.requestBody), 1);
});

test('MUTATION: a request identity missing the version is refused', () => {
  const base = {
    model: 'gemini-3.6-flash',
    serializedRequestPayload: 'payload',
    imageSha256: 'a'.repeat(64),
    systemInstructionSha256: 'b'.repeat(64),
    promptSha256: 'c'.repeat(64),
    toolDeclarationsSha256: 'd'.repeat(64),
    generationConfigSha256: 'e'.repeat(64),
    certifiedSourceSha256: 'f'.repeat(64),
    datasetVersion: '0.3.1',
    selectionContractSha256: '9'.repeat(64),
  };
  assert.throws(() => preflightReservation.exactRequestIdentity(base), /candidateVersion is required/);
  assert.throws(
    () => preflightReservation.exactRequestIdentity({ ...base, candidateVersion: '' }),
    /candidateVersion is required/
  );
});

test('MUTATION: a result identity missing the version is detectable', () => {
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });
  // Every metadata record names its version; a record without one could not be
  // attributed after the fact, because control and candidate share the model
  // configuration by design.
  assert.equal(typeof result.metadata.scannerVersion, 'string');
  assert.ok(result.metadata.scannerVersion.length > 0);
  assert.equal(candidateRegistry.isKnown(result.metadata.scannerVersion), true);
  assert.ok('scannerVersionReason' in result.metadata);
  assert.ok('scannerArtifactSha256' in result.metadata);
});

test('MUTATION: raw instruction logging is detectable', () => {
  const descriptor = candidateArtifact.describe(CANDIDATE);
  const result = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: recordingDispatch().dispatch,
  });

  // The metadata carries the instruction DIGEST, never the instruction text.
  assert.equal(result.metadata.scannerInstructionSha256, descriptor.instructionSha256);
  assert.equal(JSON.stringify(result.metadata).includes(descriptor.instructionText.slice(0, 40)), false);

  // A record that DID log the text would be caught by this same check.
  const leaking = { ...result.metadata, instructions: descriptor.instructionText };
  assert.equal(JSON.stringify(leaking).includes(PHASE2A_MARKER), true, 'the detection is real');
});

test('MUTATION: invalid provider output never reaches the projection', () => {
  const invalid = simulation.simulateScanRequest({
    trustedConfig: { scannerVersion: CANDIDATE },
    dispatch: () => ({
      v2Present: true,
      observed: { result: 'ok', data: { thing: 'a shoe, maybe' } },
      counters: {},
      providerAttempts: [{ model: 'gemini-3.6-flash', httpStatus: 200, latencyMs: 1 }],
    }),
  });
  assert.equal(invalid.metadata.status, 'provider_output_invalid');
  assert.equal(invalid.metadata.parseStatus, 'invalid');
  assert.equal(invalid.projection, null);
  assert.equal(invalid.candidateFindings, null);
  assert.equal(invalid.dispatchCount, 1, 'invalid output must not trigger a retry dispatch');
});

// ── Against the real certified bundle ───────────────────────────────────────

test('the simulation drives the real certified v140 bundle for both versions', async (t) => {
  if (!fs.existsSync(SNAPSHOT_ROOT)) {
    t.skip('certified snapshot is required for this test');
    return;
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2b-sim-'));

  try {
    const denoDispatch = ({ version }) => {
      const out = path.join(outDir, `${version}.json`);
      execFileSync('deno', [
        'run',
        `--allow-read=${SNAPSHOT_ROOT},${path.join(ROOT, 'tools/scanner-evaluation/adapter')}`,
        `--allow-write=${outDir}`,
        '--allow-env',
        '--no-lock',
        'tools/scanner-evaluation/adapter/deno/certifiedHarness.ts',
        '--cert-root', SNAPSHOT_ROOT,
        '--scenario', 'completed',
        '--case-id', 'phase2b-simulation',
        '--out', out,
        ...(version === CONTROL
          ? ['--candidate-version', CONTROL]
          : ['--candidate-version', CANDIDATE, '--overlay-file', OVERLAY_FILE]),
      ], { cwd: ROOT, stdio: 'pipe' });
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    };

    const control = simulation.simulateScanRequest({ trustedConfig: null, dispatch: denoDispatch });
    const candidate = simulation.simulateScanRequest({
      trustedConfig: { scannerVersion: CANDIDATE },
      dispatch: denoDispatch,
    });

    for (const [version, side] of [[CONTROL, control], [CANDIDATE, candidate]]) {
      assert.equal(side.dispatchCount, 1, `${version} must dispatch once`);
      assert.equal(side.metadata.status, 'provider_success');
      assert.equal(side.metadata.parseStatus, 'parsed');
      assert.equal(side.validation.ok, true);
      assert.equal(side.metadata.scannerVersion, version);
      assert.equal(side.report.counters.unexpectedNetworkAttempts, 0);
      assert.equal(side.report.counters.supabaseHostAttempts, 0);
      assert.equal(side.report.counters.commerceHostAttempts, 0);
    }

    // The overlay reached the certified request exactly once, and only for the
    // candidate — measured by the harness, inside the certified path.
    assert.equal(control.report.overlayApplications.promptsExtended, 0);
    assert.equal(candidate.report.overlayApplications.promptsExtended, 1);
    assert.equal(control.report.overlayId, null);
    assert.equal(candidate.report.overlayId, 'phase2a-fashion-specificity-v1');
    assert.deepEqual(candidate.report.modelsUsed, control.report.modelsUsed);

    // Control post-validation is not applicable; candidate's is.
    assert.equal(control.candidateFindings.applicable, false);
    assert.equal(candidate.candidateFindings.applicable, true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
