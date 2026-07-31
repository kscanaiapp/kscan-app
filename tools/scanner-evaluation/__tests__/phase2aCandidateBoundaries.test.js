'use strict';

/**
 * Phase 2A candidate boundaries: regression and mutation coverage.
 *
 * The tests in this file are written so that they FAIL if a boundary is removed.
 * Each mutation block deliberately breaks one invariant and asserts that the
 * production code notices — a test that only exercises the correct path proves
 * the code works today, not that it will keep working after the next edit.
 *
 * The candidate-difference proof at the end is the one test that shows Phase 2A
 * is operationally distinct: a prompt-sensitive mock answers the certified
 * prompt one way and the certified-prompt-plus-overlay another, through the real
 * certified bundle, with no change to the scorer or to any governed label.
 *
 * Only the provider transport is mocked. Nothing here makes a network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const baselineInputSelection = require('../lib/baselineInputSelection');
const build4Funnel = require('../lib/build4Funnel');
const candidateRegistry = require('../lib/candidateRegistry');
const candidateRequest = require('../lib/candidateRequest');
const candidateValidation = require('../lib/candidateValidation');
const compareCandidates = require('../lib/compareCandidates');
const governedStorage = require('../lib/governedStorage');
const imagePreparation = require('../lib/imagePreparation');
const liveAdapter = require('../lib/liveAdapter');
const normalizedResultValidation = require('../lib/normalizedResultValidation');
const preflightReservation = require('../lib/preflightReservation');
const runnerState = require('../lib/runnerState');
const scoreFields = require('../lib/scoreFields');
const scoringProjection = require('../lib/scoringProjection');

const ROOT = governedStorage.ROOT;
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT || 'C:/Users/jsmit/KScan-eval-storage-private';
const SNAPSHOT_ROOT = path.join(STORAGE_ROOT, 'snapshots', 'certified-v140-f5f4ed2');
const OVERLAY_FILE = path.join(ROOT, 'tools/scanner-evaluation/adapter/phase2a-instruction-overlay.v1.json');
const MANIFEST_PATH = path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json');
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const SELECTION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/execution/baseline-input-selection.v1.json'), 'utf8')
);
const PRICING = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json'), 'utf8')
);
const MANIFEST_SHA256 = baselineInputSelection.sha256Hex(fs.readFileSync(MANIFEST_PATH));

const CONTROL = candidateRegistry.CONTROL_VERSION;
const CANDIDATE = candidateRegistry.PHASE2A_VERSION;

function v2Result(overrides = {}) {
  const base = {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-0001',
    status: 'completed',
    resolutionLevel: 'subtype',
    item: {
      category: 'pants',
      subtype: 'wide_leg_jeans',
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
      colors: { primary: 'dark blue', secondary: [] },
      material: ['denim'],
      silhouette: ['wide leg'],
      pattern: [],
      attributes: { pockets: [], visible: [], distinctive: [] },
    },
    confidence: { category: 0.71, subtype: null, brand: null, modelFamily: null, exactProduct: null },
    exactProduct: null,
    evidence: [{ evidenceId: 'ev-1', observations: ['Dark blue wide-leg denim jeans.'] }],
    conflicts: [],
    compatibility: { legacyProjectionAvailable: true, globalConfidence: 0.71 },
  };
  const merged = { ...base, ...overrides };
  if (overrides.item) merged.item = { ...base.item, ...overrides.item };
  return merged;
}

const LABEL = Object.freeze(MANIFEST.cases.find((c) => c.caseId === 'set-501xx-jeans'));

// ── Certified v140 behaviour is unchanged ───────────────────────────────────

test('the certified control path carries no candidate behaviour whatsoever', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'certified prompt' }, { inline_data: { data: 'IMG' } }] }],
    generationConfig: { temperature: 0.2 },
  };
  const control = candidateRequest.applyCandidateRequest({ certifiedRequestBody: body, candidateVersion: CONTROL });
  assert.equal(control.body, body);
  assert.equal(control.transformed, false);

  const findings = candidateValidation.findCandidateViolations(v2Result(), { candidateVersion: CONTROL });
  assert.equal(findings.applicable, false);
  assert.deepEqual(findings.findings, []);

  // And the certified run identity is still the pre-Phase-2A string.
  const runIdentity = require('../lib/runIdentity');
  assert.equal(
    runIdentity.buildRunId({
      datasetVersion: '0.3.1',
      adapterId: 'v140',
      timestamp: '2026-07-30T12:00:00.000Z',
      mode: 'execute',
      researchSha: '5e41243',
      split: 'development',
      candidateVersion: candidateRegistry.runIdSegment(CONTROL),
    }),
    'baseline-v0.3.1-v140-20260730-1200-5e41243-development-exec'
  );
});

// ── Field-level behaviour the candidate is meant to change ──────────────────

test('material and pattern abstentions are scored as abstentions, not as answers', () => {
  const projected = scoringProjection.projectV2ForScoring(v2Result());
  assert.equal(projected.material, 'denim');
  assert.equal(projected.pattern, null, 'an empty V2 list is an abstention');

  // The governed label for this case records pattern as an uncertainty token,
  // so declining is the correct behaviour and is credited as such.
  const scored = scoreFields.scoreCase(LABEL, projected);
  const pattern = scored.fields.find((f) => f.field === 'pattern');
  assert.equal(pattern.disposition, scoreFields.DISPOSITIONS.CORRECT_ABSTENTION);
  assert.equal(pattern.gradeable, false, 'an abstention against an uncertain label is not identification accuracy');

  // Asserting a pattern against that same label is unsupported certainty.
  const asserted = scoreFields.scoreCase(LABEL, { ...projected, pattern: 'solid' });
  assert.equal(
    asserted.fields.find((f) => f.field === 'pattern').disposition,
    scoreFields.DISPOSITIONS.UNSUPPORTED_CERTAINTY
  );
  assert.ok(asserted.totalPenalty > scored.totalPenalty);
});

test('a concrete brand with evidence, without evidence, and empty are three different outcomes', () => {
  const withEvidence = v2Result({
    item: { brand: { value: 'Levi', confidence: 0.7, provenance: 'visible_text', evidence: [{ type: 'visible_brand_text' }] } },
  });
  assert.deepEqual(candidateValidation.findCandidateViolations(withEvidence, { candidateVersion: CANDIDATE }).findings, []);

  const withoutEvidence = v2Result({
    item: { brand: { value: 'Levi', confidence: null, provenance: 'unknown', evidence: [] } },
  });
  assert.equal(
    candidateValidation.findCandidateViolations(withoutEvidence, { candidateVersion: CANDIDATE })
      .findings.some((f) => f.code === 'brand_without_recorded_evidence'),
    true
  );

  // Empty is refused at the schema boundary and can never reach scoring.
  const empty = normalizedResultValidation.validateNormalizedResult(
    v2Result({ item: { brand: { value: '', confidence: null, provenance: 'unknown', evidence: [] } } })
  );
  assert.equal(empty.ok, false);

  // Abstaining scores CORRECT against this case's not_visible brand label, and
  // asserting one scores as a false positive.
  const abstained = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(v2Result()));
  const abstainedBrand = abstained.fields.find((f) => f.field === 'brand');
  assert.equal(abstainedBrand.disposition, scoreFields.DISPOSITIONS.CORRECT);
  assert.equal(abstainedBrand.brandFalsePositive, false);

  const claimed = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(withEvidence));
  assert.equal(claimed.fields.find((f) => f.field === 'brand').brandFalsePositive, true);
});

// ── Funnel: success, fallback, resume, accounting ───────────────────────────

function funnelFixture(candidateVersion, runId) {
  const outputRoot = governedStorage.privateResultsRoot(runId, STORAGE_ROOT);
  fs.rmSync(outputRoot, { recursive: true, force: true });
  const call = {
    caseId: LABEL.caseId,
    imageRef: SELECTION.selections.find((s) => s.caseId === LABEL.caseId).selectedRef,
    imageHash: SELECTION.selections.find((s) => s.caseId === LABEL.caseId).selectedHash,
  };
  return {
    outputRoot,
    manifest: MANIFEST,
    manifestSha256: MANIFEST_SHA256,
    selectionArtifact: SELECTION,
    cases: [LABEL],
    plans: [{
      caseId: LABEL.caseId,
      imageCount: LABEL.imageCount,
      multiImageSet: true,
      consolidatedCallEmitted: false,
      plannedCallCount: 1,
      calls: [call],
    }],
    storageRoot: STORAGE_ROOT,
    runIdentityRecord: {
      runId,
      datasetVersion: MANIFEST.datasetVersion,
      datasetManifestSha256: MANIFEST_SHA256,
      holdoutSealSha256: null,
      sourceCommit: 'phase2a-selftest',
      certifiedCommit: 'f5f4ed2',
      certifiedBundleHash: 'bundle',
      certifiedSnapshotSha256: 'snapshot',
      selectionContractSha256: SELECTION.selectionContractSha256,
      modelConfigurationId: 'certified-v140',
      candidateVersion,
    },
    pricing: PRICING,
    spendCeilingUsd: 10,
    attemptCeiling: 2,
    countTokens: ({ model, call: c }) => ({
      inputTokens: model === build4Funnel.PRIMARY_MODEL ? 1234 : 1201,
      serializedRequestPayload: JSON.stringify({ model, imageSha256: c.imageHash }),
      systemInstructionSha256: 'system',
      promptSha256: 'prompt',
      toolDeclarationsSha256: 'none',
      generationConfigSha256: 'generation',
    }),
  };
}

function successReport(attempts = 1) {
  return {
    v2Present: true,
    observed: v2Result(),
    handlerLatencyMs: 5,
    counters: { unexpectedNetworkAttempts: 0 },
    providerAttempts: Array.from({ length: attempts }, (_, index) => ({
      model: index === 0 ? build4Funnel.PRIMARY_MODEL : build4Funnel.FALLBACK_MODEL,
      httpStatus: index < attempts - 1 ? 503 : 200,
      latencyMs: 1,
      promptTokenCount: 1200,
      candidatesTokenCount: 200,
      totalTokenCount: 1400,
      errorCategory: index < attempts - 1 ? 'provider_5xx' : null,
      certifiedFailureKind: index < attempts - 1 ? 'http_5xx_transient' : null,
    })),
  };
}

test('primary success and the certified fallback path both terminate scoreably for the candidate', () => {
  for (const [name, attempts] of [['primary', 1], ['fallback', 2]]) {
    const runId = `phase2a-${name}-selftest`;
    const fixture = funnelFixture(CANDIDATE, runId);
    try {
      const report = build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(attempts) });
      assert.equal(report.completedCaseCount, 1);
      assert.equal(report.scoredCaseCount, 1);

      const record = runnerState.readCaseResult(fixture.outputRoot, LABEL.caseId);
      assert.equal(record.status, 'provider_success');
      assert.equal(record.candidateVersion, CANDIDATE);
      assert.equal(record.attemptCount, attempts);
      assert.equal(record.profiles.trust_weighted.flags.fallbackInvoked, attempts > 1, `${name}: fallback flag`);
      // The certified fallback is the ONLY retry. The adapter adds none.
      assert.ok(record.attemptCount <= 2, 'no attempt beyond the certified plan');
    } finally {
      fs.rmSync(fixture.outputRoot, { recursive: true, force: true });
    }
  }
});

test('a candidate run resumes without re-dispatching or re-charging', () => {
  const runId = 'phase2a-resume-selftest';
  const fixture = funnelFixture(CANDIDATE, runId);
  try {
    const first = build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(1) });
    const resumed = build4Funnel.executeGovernedRun({
      ...fixture,
      countTokens: () => { throw new Error('resume duplicated countTokens'); },
      executeAdapter: () => { throw new Error('resume duplicated generation'); },
      resume: true,
    });
    assert.deepEqual(resumed.skippedAlreadyComplete, [LABEL.caseId]);
    assert.equal(resumed.completedCaseCount, 1);
    assert.equal(resumed.reservation.totalGenerateAttempts, first.reservation.totalGenerateAttempts);
    assert.equal(resumed.reservation.totalAccountedUsd, first.reservation.totalAccountedUsd);
  } finally {
    fs.rmSync(fixture.outputRoot, { recursive: true, force: true });
  }
});

test('a resume may not graft the candidate onto a control run directory', () => {
  const runId = 'phase2a-graft-selftest';
  const fixture = funnelFixture(CONTROL, runId);
  try {
    build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(1) });
    const asCandidate = funnelFixture(CANDIDATE, runId);
    // funnelFixture cleared the directory; rebuild the control run under it.
    build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(1) });
    assert.throws(
      () => build4Funnel.executeGovernedRun({
        ...asCandidate,
        outputRoot: fixture.outputRoot,
        executeAdapter: () => { throw new Error('a grafted resume must not dispatch'); },
        resume: true,
      }),
      /candidateVersion/
    );
  } finally {
    fs.rmSync(fixture.outputRoot, { recursive: true, force: true });
  }
});

test('an ambiguous dispatch is refused rather than repeated as duplicate paid work', () => {
  const runId = 'phase2a-ambiguous-selftest';
  const fixture = funnelFixture(CANDIDATE, runId);
  try {
    // Complete once, then simulate a crash: a dispatch marker with no terminal.
    build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(1) });
    fs.rmSync(path.join(fixture.outputRoot, 'cases', `${LABEL.caseId}.json`));
    fs.writeFileSync(
      path.join(fixture.outputRoot, 'dispatch', `${LABEL.caseId}.json`),
      JSON.stringify({ schemaVersion: '1.0.0', caseId: LABEL.caseId, runId, terminal: false })
    );

    const report = build4Funnel.executeGovernedRun({
      ...fixture,
      executeAdapter: () => { throw new Error('automatic redispatch must not happen'); },
      resume: true,
    });
    assert.deepEqual(report.refusedCaseIds, [LABEL.caseId]);
    const failure = JSON.parse(fs.readFileSync(path.join(fixture.outputRoot, 'failures', `${LABEL.caseId}.json`), 'utf8'));
    assert.equal(failure.status, 'adapter_internal_error');
    assert.match(failure.message, /duplicate paid work/);
  } finally {
    fs.rmSync(fixture.outputRoot, { recursive: true, force: true });
  }
});

// ── Storage boundaries ──────────────────────────────────────────────────────

test('candidate runs obey the same storage-root and traversal protections as the control', () => {
  for (const hostile of ['../escape', 'a/b', 'a\\b']) {
    assert.throws(() => governedStorage.privateResultsRoot(hostile, STORAGE_ROOT), /path separator or traversal/);
  }
  assert.throws(() => governedStorage.requireStorageRoot(''), /not set/);
  assert.throws(() => governedStorage.requireStorageRoot(path.join(STORAGE_ROOT, 'tier-a')), /must be the storage root/);

  // A candidate output root outside the governed results tree is refused.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2a-outside-'));
  try {
    assert.throws(
      () => liveAdapter.verifyPrivateOutputRoot(outside, { storageRoot: STORAGE_ROOT }),
      liveAdapter.PreflightRefused
    );
    // And one inside the governed IMAGE corpus is refused separately.
    assert.throws(
      () => liveAdapter.verifyPrivateOutputRoot(path.join(STORAGE_ROOT, 'tier-a', 'run'), { storageRoot: STORAGE_ROOT }),
      liveAdapter.PreflightRefused
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }

  // A governed image ref may not traverse out of the corpus.
  assert.throws(
    () => governedStorage.resolveImageRef('kscan-eval://tier-a/../../secrets.txt', { storageRoot: STORAGE_ROOT }),
    /traversal/
  );
});

// ── Mutation proofs ─────────────────────────────────────────────────────────

test('MUTATION: silently redirecting the certified path to Phase 2A is detected', () => {
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'certified prompt' }, { inline_data: { data: 'IMG' } }] }],
  };
  const control = candidateRequest.applyCandidateRequest({ certifiedRequestBody: body, candidateVersion: CONTROL });
  const redirected = candidateRequest.applyCandidateRequest({ certifiedRequestBody: body, candidateVersion: CANDIDATE });

  // The redirect is observable in three independent places, so removing any one
  // of the three checks still leaves the mutation detectable.
  assert.notEqual(redirected.promptSha256, control.promptSha256);
  assert.notEqual(redirected.candidateVersion, control.candidateVersion);
  assert.notEqual(
    preflightReservation.exactRequestIdentity({
      model: 'm', serializedRequestPayload: 'p', imageSha256: 'i', systemInstructionSha256: 's',
      promptSha256: redirected.promptSha256, toolDeclarationsSha256: 't', generationConfigSha256: 'g',
      certifiedSourceSha256: 'c', datasetVersion: '0.3.1', selectionContractSha256: 'sel',
      candidateVersion: CANDIDATE,
    }),
    preflightReservation.exactRequestIdentity({
      model: 'm', serializedRequestPayload: 'p', imageSha256: 'i', systemInstructionSha256: 's',
      promptSha256: control.promptSha256, toolDeclarationsSha256: 't', generationConfigSha256: 'g',
      certifiedSourceSha256: 'c', datasetVersion: '0.3.1', selectionContractSha256: 'sel',
      candidateVersion: CONTROL,
    })
  );
});

test('MUTATION: candidate results overwriting certified results is detected', () => {
  const control = { candidateVersion: CONTROL, runId: 'run-a', outputRoot: '/results/run-a' };
  assert.throws(
    () => candidateRegistry.assertDistinctResultIdentity(control, { candidateVersion: CANDIDATE, runId: 'run-a' }),
    candidateRegistry.ResultIdentityCollision
  );
  assert.throws(
    () => candidateRegistry.assertDistinctResultIdentity(control, { candidateVersion: CANDIDATE, outputRoot: '/results/run-a' }),
    candidateRegistry.ResultIdentityCollision
  );

  // At the funnel, an existing result refuses a non-resume overwrite outright.
  const runId = 'phase2a-overwrite-selftest';
  const fixture = funnelFixture(CANDIDATE, runId);
  try {
    build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(1) });
    assert.throws(
      () => build4Funnel.executeGovernedRun({ ...fixture, executeAdapter: () => successReport(1) }),
      runnerState.DuplicateOutput
    );
  } finally {
    fs.rmSync(fixture.outputRoot, { recursive: true, force: true });
  }
});

test('MUTATION: invalid candidate output entering scoring is detected', () => {
  const runId = 'phase2a-invalid-selftest';
  const fixture = funnelFixture(CANDIDATE, runId);
  try {
    const report = build4Funnel.executeGovernedRun({
      ...fixture,
      executeAdapter: () => ({
        v2Present: true,
        // Valid JSON, invalid schema.
        observed: { result: 'ok', data: { thing: 'a shoe, maybe' } },
        handlerLatencyMs: 5,
        counters: { unexpectedNetworkAttempts: 0 },
        providerAttempts: [{ model: build4Funnel.PRIMARY_MODEL, httpStatus: 200, latencyMs: 1 }],
      }),
    });
    assert.equal(report.completedCaseCount, 1);
    assert.equal(report.scoredCaseCount, 0, 'invalid output must never be scored');

    const record = runnerState.readCaseResult(fixture.outputRoot, LABEL.caseId);
    assert.equal(record.status, 'provider_output_invalid');
    assert.equal(record.scoreability, 'not_scoreable');
    assert.equal(record.profiles, null);
    assert.equal(record.projection, null, 'an invalid result may not even be projected');
    assert.equal(record.candidateFindings, null, 'candidate validation may not run on invalid output');
  } finally {
    fs.rmSync(fixture.outputRoot, { recursive: true, force: true });
  }
});

test('MUTATION: crediting an abstention as a correct identification is detected', () => {
  const abstaining = scoringProjection.projectV2ForScoring(v2Result({
    status: 'insufficient_visual_evidence',
    resolutionLevel: 'unknown',
    item: {
      category: null, subtype: null, material: [], pattern: [],
      colors: { primary: null, secondary: [] },
      brand: { value: null, confidence: null, provenance: 'unknown', evidence: [] },
    },
    confidence: { category: null, subtype: null, brand: null, modelFamily: null, exactProduct: null },
  }));
  const scored = scoreFields.scoreCase(LABEL, abstaining);
  const agg = scoreFields.aggregateScores([scored]);

  // The label carries a concrete category, so declining it is NOT correct.
  const category = scored.fields.find((f) => f.field === 'category');
  assert.equal(category.disposition, scoreFields.DISPOSITIONS.UNKNOWN_WHEN_EVIDENCE_EXISTS);
  assert.notEqual(category.disposition, scoreFields.DISPOSITIONS.CORRECT);
  assert.equal(agg.identification.category.gradeableN, 1);
  assert.equal(agg.identification.category.correct, 0);
  assert.equal(agg.identification.category.correctRate, 0);
  assert.ok(scored.totalPenalty > 0, 'a full abstention on a gradeable case cannot be free');
});

test('MUTATION: an empty brand becoming a concrete prediction is detected', () => {
  // The empty string is refused outright at the schema boundary.
  assert.equal(
    normalizedResultValidation.validateNormalizedResult(
      v2Result({ item: { brand: { value: '', confidence: null, provenance: 'unknown', evidence: [] } } })
    ).ok,
    false
  );

  // A whitespace-only value is a different case, and is worth stating precisely
  // rather than assuming. The certified normalizer trims and returns null for
  // it, so the certified path cannot emit one; the schema's `nullableString`
  // checks length rather than trimmed length, so it would admit one if it ever
  // arrived. What matters for this mutation is the property downstream, which
  // holds either way: it is never a concrete brand claim.
  const whitespace = normalizedResultValidation.validateNormalizedResult(
    v2Result({ item: { brand: { value: '   ', confidence: null, provenance: 'unknown', evidence: [] } } })
  );
  assert.equal(whitespace.ok, true, 'documenting the boundary as it is, not as assumed');
  assert.equal(scoringProjection.projectV2ForScoring(whitespace.value).brand, '   ');

  for (const value of ['', '   ', null, undefined, []]) {
    const scored = scoreFields.scoreBrand('not_visible', value);
    assert.equal(scored.brandConcretePrediction, false, `${JSON.stringify(value)} is not a brand claim`);
    assert.equal(scored.brandFalsePositive, false);
    // An absent brand against a not_visible label is a correct abstention, and
    // it must never enter the precision denominator as a positive.
    assert.equal(scored.disposition, scoreFields.DISPOSITIONS.CORRECT);
  }

  const agg = scoreFields.aggregateScores([
    scoreFields.scoreCase(LABEL, { brand: '   ', status: 'completed', resolutionLevel: 'category' }),
  ]);
  assert.equal(agg.brandPrecisionSignals.concretePredictions, 0);
  assert.equal(agg.brandPrecisionSignals.correct, 0);
});

test('MUTATION: a scoring denominator change is detected', () => {
  // The scored field list, the contract version and the profile set are the
  // three things a denominator change would move.
  const scored = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(v2Result()));
  assert.deepEqual(
    scored.fields.map((f) => f.field),
    [
      'category', 'clothingType', 'subtype', 'primaryColor', 'secondaryColors',
      'material', 'pattern', 'brand', 'exactProduct', 'expectedResultType',
      'abstention', 'nonFashion',
    ]
  );
  assert.equal(scored.scoringContractVersion, '0.3.0');
  assert.deepEqual(Object.keys(scoreFields.scoreCaseAllProfiles(LABEL, {})).sort(), ['neutral', 'trust_weighted']);

  // Candidate findings, however many there are, add no field and no case.
  const offending = v2Result({ item: { category: 'dress', subtype: 'wide_leg_jeans' } });
  const findings = candidateValidation.findCandidateViolations(offending, { candidateVersion: CANDIDATE });
  assert.ok(findings.findings.length > 0);
  const after = scoreFields.scoreCase(LABEL, scoringProjection.projectV2ForScoring(offending));
  assert.equal(after.fields.length, scored.fields.length);
  assert.equal(scoreFields.aggregateScores([after]).caseCount, 1);
});

test('MUTATION: a request identity omitting candidate versioning is detected', () => {
  const base = {
    model: 'm', serializedRequestPayload: 'p', imageSha256: 'i', systemInstructionSha256: 's',
    promptSha256: 'pr', toolDeclarationsSha256: 't', generationConfigSha256: 'g',
    certifiedSourceSha256: 'c', datasetVersion: '0.3.1', selectionContractSha256: 'sel',
  };
  assert.throws(() => preflightReservation.exactRequestIdentity(base), /candidateVersion is required/);
  assert.throws(
    () => preflightReservation.exactRequestIdentity({ ...base, candidateVersion: '' }),
    /candidateVersion is required/
  );
});

test('MUTATION: a comparison of one execution against itself is detected', () => {
  const record = {
    caseId: LABEL.caseId,
    runId: 'run-a',
    candidateVersion: CONTROL,
    status: 'provider_success',
    scoreability: 'scoreable',
    projection: scoringProjection.projectV2ForScoring(v2Result()),
    profiles: scoreFields.scoreCaseAllProfiles(LABEL, scoringProjection.projectV2ForScoring(v2Result())),
  };
  assert.throws(() => compareCandidates.compareCaseFields(record, record), /same object/);
  assert.throws(() => compareCandidates.compareCaseFields(record, { ...record }), /names the certified control/);
});

// ── Isolation from production surfaces ──────────────────────────────────────

test('nothing in the Phase 2A layer can reach Supabase, commerce, or a production endpoint', () => {
  const libDir = path.join(__dirname, '..', 'lib');
  const phase2aModules = [
    'candidateRegistry.js',
    'candidateInstructions.js',
    'candidateRequest.js',
    'candidateValidation.js',
    'scoringProjection.js',
  ];
  for (const file of phase2aModules) {
    const code = fs.readFileSync(path.join(libDir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [/supabase/i, /https?:\/\//, /\bfetch\s*\(/, /require\(['"]https?['"]\)/, /XMLHttpRequest/]) {
      assert.equal(forbidden.test(code), false, `${file} must not reference ${forbidden}`);
    }
  }
});

// ── Candidate difference proof ──────────────────────────────────────────────

test('the candidate is operationally distinct: instructions reach the model and change the answer', async (t) => {
  if (!fs.existsSync(SNAPSHOT_ROOT)) {
    t.skip('certified snapshot is required for the difference proof');
    return;
  }

  const selected = SELECTION.selections.find((entry) => entry.caseId === LABEL.caseId);
  const sourcePath = governedStorage.resolveImageRef(selected.selectedRef, { storageRoot: STORAGE_ROOT });
  const derivativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2a-diff-derivative-'));
  const roots = {
    [CONTROL]: governedStorage.privateResultsRoot('phase2a-diff-control', STORAGE_ROOT),
    [CANDIDATE]: governedStorage.privateResultsRoot('phase2a-diff-candidate', STORAGE_ROOT),
  };
  for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });

  try {
    const prepared = await imagePreparation.prepareImage({
      sourcePath,
      expectedSourceSha256: selected.selectedHash,
      viewId: 'path-b-selected',
      derivativeRoot,
    });
    const sourceIdentity = liveAdapter.verifyExecutionSource(SNAPSHOT_ROOT);

    function run(candidateVersion) {
      const outputRoot = roots[candidateVersion];
      const fixture = funnelFixture(candidateVersion, path.basename(outputRoot));
      fixture.plans[0].calls[0].preparation = prepared;
      fixture.runIdentityRecord.certifiedCommit = sourceIdentity.certifiedCommit;
      fixture.runIdentityRecord.certifiedBundleHash = sourceIdentity.bundleHash;
      fixture.runIdentityRecord.certifiedSnapshotSha256 = sourceIdentity.closureAggregateSha256;

      build4Funnel.executeGovernedRun({
        ...fixture,
        executeAdapter: () => {
          const out = path.join(outputRoot, 'harness-report.json');
          execFileSync('deno', [
            'run',
            `--allow-read=${SNAPSHOT_ROOT},${path.join(ROOT, 'tools/scanner-evaluation/adapter')},${derivativeRoot}`,
            `--allow-write=${outputRoot}`,
            '--allow-env',
            '--no-lock',
            'tools/scanner-evaluation/adapter/deno/certifiedHarness.ts',
            '--cert-root', SNAPSHOT_ROOT,
            // One scenario for BOTH sides. The mock reads the prompt it was
            // given; the test does not choose an answer per side.
            '--scenario', 'fashion_specificity_probe',
            '--image-file', prepared.derivativePath,
            '--image-width', String(prepared.derivativeWidth),
            '--image-height', String(prepared.derivativeHeight),
            '--case-id', LABEL.caseId,
            '--out', out,
            ...(candidateVersion === CONTROL
              ? ['--candidate-version', CONTROL]
              : ['--candidate-version', CANDIDATE, '--overlay-file', OVERLAY_FILE]),
          ], { cwd: ROOT, stdio: 'pipe' });
          return JSON.parse(fs.readFileSync(out, 'utf8'));
        },
      });
      return runnerState.readCaseResult(outputRoot, LABEL.caseId);
    }

    const control = run(CONTROL);
    const candidate = run(CANDIDATE);

    // The uninstructed answer: a generic object label, no subtype, an inferred
    // material, and a pattern asserted where the label records none.
    assert.equal(control.projection.category, 'clothing');
    assert.equal(control.projection.subtype, null);
    assert.equal(control.projection.material, 'cotton');
    assert.equal(control.projection.pattern, 'solid');

    // The instructed answer: a fashion term, a consistent subtype, the material
    // actually present, and an abstention where it cannot tell.
    assert.equal(candidate.projection.category, 'pants');
    assert.equal(candidate.projection.subtype, 'wide_leg_jeans');
    assert.equal(candidate.projection.material, 'denim');
    assert.equal(candidate.projection.pattern, null);
    assert.deepEqual(candidate.candidateFindings.findings, [], 'the instructed answer trips no discipline guard');

    // Scored by the SAME frozen scorer against the SAME governed label. Neither
    // was touched by this test.
    const artifact = compareCandidates.compareRuns(
      { records: [control] },
      { records: [candidate], candidateVersion: CANDIDATE }
    );
    const byField = Object.fromEntries(artifact.cases[0].fields.map((f) => [f.field, f]));
    assert.equal(byField.category.direction, compareCandidates.DIRECTIONS.IMPROVED);
    assert.equal(byField.subtype.direction, compareCandidates.DIRECTIONS.IMPROVED);
    assert.equal(byField.material.direction, compareCandidates.DIRECTIONS.IMPROVED);
    assert.equal(byField.pattern.direction, compareCandidates.DIRECTIONS.IMPROVED);
    assert.ok(artifact.totals.improved > 0);
    assert.equal(artifact.totals.regressed, 0);
    assert.ok(artifact.candidateTotalPenalty < artifact.controlTotalPenalty);

    // This proves the candidate is operationally distinct. It is NOT accuracy
    // evidence, and the artifact says so itself.
    assert.equal(artifact.measuredAccuracyClaim, 'not_claimed');
  } finally {
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(derivativeRoot, { recursive: true, force: true });
  }
});
