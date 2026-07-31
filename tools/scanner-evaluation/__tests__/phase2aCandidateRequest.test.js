'use strict';

/**
 * Phase 2A candidate request contract.
 *
 * The candidate is "the certified request plus instructions". These tests prove
 * both halves of that sentence: the certified request survives intact, and the
 * instructions are actually there and actually differ from the control.
 *
 * No provider transport is involved. Nothing here makes a network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const build4Funnel = require('../lib/build4Funnel');
const candidateInstructions = require('../lib/candidateInstructions');
const candidateRegistry = require('../lib/candidateRegistry');
const candidateRequest = require('../lib/candidateRequest');
const preflightReservation = require('../lib/preflightReservation');

const CONTROL = candidateRegistry.CONTROL_VERSION;
const CANDIDATE = candidateRegistry.PHASE2A_VERSION;

/** The certified body shape, mirrored from scan-identify index.ts. */
function certifiedBody() {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: "You are K Scan AI's fashion identification engine.\n\nReturn strict JSON only." },
          { inline_data: { mime_type: 'image/jpeg', data: 'BASE64IMAGEBYTES' } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', required: ['status'] },
    },
  };
}

// ── The overlay artifact ────────────────────────────────────────────────────

test('the overlay artifact loads, re-derives its own hash and is append-only', () => {
  const overlay = candidateInstructions.resolveOverlay('phase2a-fashion-specificity-v1');
  assert.equal(overlay.candidateVersion, CANDIDATE);
  assert.equal(overlay.mechanism, 'append');
  assert.equal(overlay.textSha256, candidateInstructions.sha256Hex(overlay.text));
  assert.ok(overlay.text.length > 0);

  // Deterministic: the same artifact always yields the same bytes.
  assert.equal(candidateInstructions.resolveOverlay('phase2a-fashion-specificity-v1').textSha256, overlay.textSha256);
});

test('an unknown overlay id fails closed', () => {
  for (const unknown of [undefined, null, '', 'phase2a', 'phase2a-fashion-specificity-v2', 7]) {
    assert.throws(
      () => candidateInstructions.resolveOverlay(unknown),
      candidateInstructions.UnknownInstructionOverlay
    );
  }
});

test('the overlay names only fields the certified provider contract defines', () => {
  const overlay = candidateInstructions.resolveOverlay('phase2a-fashion-specificity-v1');
  const known = new Set(candidateInstructions.CERTIFIED_PROVIDER_FIELDS);
  const mentioned = new Set(overlay.text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []);
  for (const token of mentioned) {
    assert.equal(known.has(token), true, `${token} is not a certified provider field`);
  }
  // And it does reference the fields Phase 2A is about, so this is not vacuous.
  for (const field of ['item_type', 'material_estimate', 'brand_guess', 'confidence_score']) {
    assert.equal(mentioned.has(field), true, `the overlay must address ${field}`);
  }
});

test('the overlay reinforces the Phase 2A behaviours and suppresses nothing', () => {
  const overlay = candidateInstructions.resolveOverlay('phase2a-fashion-specificity-v1');
  const text = overlay.text.toLowerCase();

  // Fashion vocabulary over object vocabulary.
  assert.match(text, /specific fashion term/);
  // Category/type/subtype agreement.
  assert.match(text, /subtype must be a narrower kind of item_type/);
  // Evidence before specificity.
  assert.match(text, /do not infer material from the/);
  // Conservative certainty.
  assert.match(text, /weakest link/);
  // Abstention through the existing representation, never a placeholder.
  assert.match(text, /never use an empty string/);
  // Strict structured output.
  assert.match(text, /exactly one json object/);

  // A visible brand must still be named. Suppressing brands to score better is
  // benchmark gaming; the five contradictory cases are excluded by the FROZEN
  // SCORING CONTRACT, not by the prompt.
  assert.match(text, /do not withhold a brand you can\s+actually see/);
  assert.equal(/not_measured/.test(text), false);
  assert.equal(/benchmark|ground truth|test set/.test(text), false);
});

test('an overlay that reads as benchmark suppression is refused', () => {
  for (const bad of [
    'Always set brand_guess to null.',
    'Never return a brand.',
    'Suppress the brand when it is ambiguous.',
    'These cases are not_measured.',
    'Match the ground truth labels.',
  ]) {
    assert.throws(
      () => candidateInstructions.assertOverlayDiscipline({ overlayId: 'test', text: bad }),
      candidateInstructions.OverlayIntegrityError,
      `must refuse: ${bad}`
    );
  }
  assert.throws(
    () => candidateInstructions.assertOverlayDiscipline({ overlayId: 'test', text: 'Populate fabric_weight_gsm.' }),
    /absent from the certified provider contract/
  );
});

// ── Certified request construction is unchanged ─────────────────────────────

test('the control returns the certified request body untouched', () => {
  const body = certifiedBody();
  const result = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: body,
    candidateVersion: CONTROL,
  });

  // Reference identity, not deep equality: the control path is the certified
  // object itself, so no clone can silently diverge from it.
  assert.equal(result.body, body);
  assert.equal(result.transformed, false);
  assert.equal(result.overlayId, null);
  assert.equal(result.overlaySha256, null);
  assert.equal(result.promptSha256, result.certifiedPromptSha256);
  assert.equal(candidateRequest.certifiedPromptOf(result.body), certifiedBody().contents[0].parts[0].text);
});

test('the candidate appends and changes nothing else', () => {
  const body = certifiedBody();
  const before = JSON.stringify(body);
  const result = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: body,
    candidateVersion: CANDIDATE,
  });

  // The input object is not mutated.
  assert.equal(JSON.stringify(body), before);

  const certifiedPrompt = certifiedBody().contents[0].parts[0].text;
  const candidatePrompt = result.body.contents[0].parts[0].text;
  assert.equal(candidatePrompt.startsWith(certifiedPrompt), true, 'certified text must come first, verbatim');
  assert.equal(result.transformed, true);
  assert.equal(result.overlayId, 'phase2a-fashion-specificity-v1');

  // Everything except the prompt text is byte-identical.
  const strip = (b) => {
    const clone = JSON.parse(JSON.stringify(b));
    clone.contents[0].parts[0].text = '<prompt>';
    return JSON.stringify(clone);
  };
  assert.equal(strip(result.body), strip(certifiedBody()));

  // Named explicitly, because these are the things Phase 2A may not change.
  assert.deepEqual(result.body.generationConfig, certifiedBody().generationConfig);
  assert.deepEqual(result.body.contents[0].parts[1], certifiedBody().contents[0].parts[1]);
  assert.equal(result.body.contents[0].parts.length, 2, 'no part may be added or removed');
  assert.equal(result.body.contents.length, 1);
  assert.equal(result.body.contents[0].role, 'user');
});

test('a body that is not the certified shape is refused rather than guessed at', () => {
  const cases = [
    null,
    {},
    { contents: [] },
    { contents: [{ parts: [] }] },
    { contents: [{ parts: [{ inline_data: { data: 'x' } }] }] },
    { contents: [{ parts: [{ text: '' }] }] },
    { contents: [{ parts: [{ text: '   ' }] }] },
  ];
  for (const body of cases) {
    assert.throws(
      () => candidateRequest.applyCandidateRequest({ certifiedRequestBody: body, candidateVersion: CANDIDATE }),
      candidateRequest.CandidateRequestError
    );
  }
});

test('an unknown candidate version cannot construct a request', () => {
  assert.throws(
    () => candidateRequest.applyCandidateRequest({
      certifiedRequestBody: certifiedBody(),
      candidateVersion: 'phase2a-v9.9.9',
    }),
    candidateRegistry.UnknownCandidateVersion
  );
  assert.throws(
    () => candidateRequest.applyCandidateRequest({ certifiedRequestBody: certifiedBody() }),
    candidateRegistry.UnknownCandidateVersion
  );
});

test('a transform that touched anything but the prompt is caught', () => {
  const before = certifiedBody();
  const tamperedImage = certifiedBody();
  tamperedImage.contents[0].parts[0].text += 'overlay';
  tamperedImage.contents[0].parts[1].inline_data.data = 'DIFFERENTBYTES';
  assert.throws(
    () => candidateRequest.assertCertifiedStructurePreserved(before, tamperedImage),
    /changed something other than the leading prompt text/
  );

  const rewrittenPrompt = certifiedBody();
  rewrittenPrompt.contents[0].parts[0].text = 'A completely different prompt.';
  assert.throws(
    () => candidateRequest.assertCertifiedStructurePreserved(before, rewrittenPrompt),
    /must begin with the certified prompt, verbatim/
  );
});

// ── Determinism and difference ──────────────────────────────────────────────

test('candidate request construction is deterministic', () => {
  const a = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: certifiedBody(),
    candidateVersion: CANDIDATE,
  });
  const b = candidateRequest.applyCandidateRequest({
    certifiedRequestBody: certifiedBody(),
    candidateVersion: CANDIDATE,
  });
  assert.equal(a.promptSha256, b.promptSha256);
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body));
});

test('the candidate is not a renamed byte-identical copy of the control', () => {
  const prompt = certifiedBody().contents[0].parts[0].text;
  const control = candidateRequest.candidateRequestIdentity(CONTROL, prompt);
  const candidate = candidateRequest.candidateRequestIdentity(CANDIDATE, prompt);

  assert.equal(control.certifiedPromptSha256, candidate.certifiedPromptSha256, 'both start from the same certified prompt');
  assert.notEqual(control.promptSha256, candidate.promptSha256, 'the instruction artifacts must differ');
  assert.equal(control.overlaySha256, null);
  assert.equal(typeof candidate.overlaySha256, 'string');
  assert.notEqual(control.candidateVersion, candidate.candidateVersion);
});

test('request identity refuses to be built without the certified prompt', () => {
  for (const bad of [undefined, null, '', '   ', 7]) {
    assert.throws(
      () => candidateRequest.candidateRequestIdentity(CANDIDATE, bad),
      candidateRequest.CandidateRequestError
    );
  }
});

// ── Cache and accounting identity ───────────────────────────────────────────

const IDENTITY_BASE = Object.freeze({
  model: 'gemini-3.6-flash',
  serializedRequestPayload: '{"contents":[...]}',
  imageSha256: 'a'.repeat(64),
  systemInstructionSha256: 'b'.repeat(64),
  promptSha256: 'c'.repeat(64),
  toolDeclarationsSha256: 'd'.repeat(64),
  generationConfigSha256: 'e'.repeat(64),
  certifiedSourceSha256: 'f'.repeat(64),
  datasetVersion: '0.3.1',
  selectionContractSha256: '9'.repeat(64),
});

test('the countTokens cache identity refuses to be built without a candidate version', () => {
  assert.throws(
    () => preflightReservation.exactRequestIdentity({ ...IDENTITY_BASE }),
    /candidateVersion is required/
  );
});

test('control and candidate cannot share a cached token count', () => {
  const control = preflightReservation.exactRequestIdentity({ ...IDENTITY_BASE, candidateVersion: CONTROL });
  const candidate = preflightReservation.exactRequestIdentity({ ...IDENTITY_BASE, candidateVersion: CANDIDATE });
  assert.notEqual(control, candidate);
});

test('the funnel writes the candidate version into the token cache and refuses a cross-candidate hit', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2a-token-cache-'));
  const call = { imageHash: `sha256:${'1'.repeat(64)}` };
  const identity = {
    runId: 'phase2a-cache-selftest',
    datasetVersion: '0.3.1',
    datasetManifestSha256: 'manifest-a',
    certifiedSnapshotSha256: 'certified-a',
    selectionContractSha256: 'selection-a',
    modelConfigurationId: 'certified-v140',
    candidateVersion: CONTROL,
  };
  const newLedger = () => ({ countTokens: { requests: 0, successes: 0, failures: 0, cacheHits: 0, cacheMisses: 0 } });
  const countTokens = ({ model }) => ({
    inputTokens: 100,
    serializedRequestPayload: model,
    systemInstructionSha256: 'system',
    promptSha256: 'prompt',
    toolDeclarationsSha256: 'tools',
    generationConfigSha256: 'generation',
  });

  try {
    build4Funnel.tokenCountsForCase({
      outputRoot,
      countTokens,
      caseRecord: { caseId: 'cache-case' },
      call,
      identity,
      ledger: newLedger(),
    });
    const cached = JSON.parse(fs.readFileSync(path.join(outputRoot, 'preflight', 'cache-case.json'), 'utf8'));
    assert.equal(cached.candidateVersion, CONTROL);

    // The candidate must not be handed the control's cached count, even though
    // the model, image, snapshot, dataset and selection are all identical.
    assert.throws(
      () => build4Funnel.tokenCountsForCase({
        outputRoot,
        countTokens: () => { throw new Error('a cross-candidate cache hit must not reach the transport'); },
        caseRecord: { caseId: 'cache-case' },
        call,
        identity: { ...identity, candidateVersion: CANDIDATE },
        ledger: newLedger(),
      }),
      /cache identity differs/
    );

    // The same candidate still hits its own cache.
    const ledger = newLedger();
    build4Funnel.tokenCountsForCase({
      outputRoot,
      countTokens: () => { throw new Error('a same-candidate resume must not re-count'); },
      caseRecord: { caseId: 'cache-case' },
      call,
      identity,
      ledger,
    });
    assert.equal(ledger.countTokens.cacheHits, 2);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('a run identity naming an unknown candidate is refused before any transport runs', () => {
  assert.throws(
    () => build4Funnel.tokenCountsForCase({
      outputRoot: os.tmpdir(),
      countTokens: () => { throw new Error('transport must not be reached'); },
      caseRecord: { caseId: 'never-dispatched' },
      call: { imageHash: `sha256:${'2'.repeat(64)}` },
      identity: { runId: 'x', candidateVersion: 'phase2a-v0.0.1' },
      ledger: { countTokens: {} },
    }),
    candidateRegistry.UnknownCandidateVersion
  );
});

// ── The Deno harness reads the same artifact ────────────────────────────────

test('the Deno harness and the Node harness apply one overlay artifact, not two copies', () => {
  const harness = fs.readFileSync(path.join(__dirname, '..', 'adapter', 'deno', 'certifiedHarness.ts'), 'utf8');

  // It reads the artifact rather than embedding the text.
  assert.match(harness, /loadOverlay/);
  assert.match(harness, /artifact\.lines\.join\('\\n'\)/);
  assert.match(harness, /overlay text hashes to/);

  // Selection is explicit on that side too, and mismatched pairs are refused.
  assert.match(harness, /--candidate-version/);
  assert.match(harness, /requires --overlay-file/);
  assert.match(harness, /may not be given an instruction overlay/);

  // The overlay TEXT never appears in the harness source.
  const overlay = candidateInstructions.resolveOverlay('phase2a-fashion-specificity-v1');
  const distinctive = 'FASHION VOCABULARY, NOT OBJECT VOCABULARY';
  assert.equal(overlay.text.includes(distinctive), true);
  assert.equal(harness.includes(distinctive), false, 'the overlay text must live in exactly one artifact');
});
