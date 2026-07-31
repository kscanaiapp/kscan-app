'use strict';

/**
 * Control-versus-candidate comparison, and the mocked Phase 2A funnel.
 *
 * The end-to-end test runs ONE governed manifest case through the real certified
 * v140 bundle twice — once as the control, once as the Phase 2A candidate — and
 * asserts that the two executions produce separate private results, separate
 * caches, separate run directories, and a comparison artifact derived from both.
 *
 * ONLY the provider transport is mocked. Request construction, the overlay,
 * schema validation, parsing, normalization, the taxonomy, candidate
 * post-validation, scoring, persistence and aggregation are all the real code.
 *
 * The mocked provider returns the same envelope to both sides on purpose. That
 * makes the comparison's expected output known exactly, which is what proves the
 * wiring; it is emphatically NOT accuracy evidence, and the artifact says so
 * itself via `measuredAccuracyClaim`.
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
const compareCandidates = require('../lib/compareCandidates');
const governedStorage = require('../lib/governedStorage');
const imagePreparation = require('../lib/imagePreparation');
const liveAdapter = require('../lib/liveAdapter');
const runnerState = require('../lib/runnerState');
const scoreFields = require('../lib/scoreFields');
const scoringProjection = require('../lib/scoringProjection');
const { compareRunDirectories } = require('../compare-candidates');

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

// ── Synthetic records, for the comparison semantics themselves ──────────────

function scoredRecord({ caseId = 'c1', candidateVersion, runId, projection, label }) {
  const profiles = scoreFields.scoreCaseAllProfiles(label, projection);
  return {
    caseId,
    runId,
    candidateVersion,
    status: 'provider_success',
    scoreability: 'scoreable',
    projection,
    profiles,
    candidateFindings: { applicable: candidateVersion !== CONTROL, findings: [] },
  };
}

const LABEL = Object.freeze({
  caseId: 'c1',
  datasetVersion: '0.3.1',
  category: 'footwear',
  clothingType: 'sneaker',
  subtype: 'low_top_sneaker',
  primaryColor: 'red',
  secondaryColors: ['white'],
  material: 'canvas',
  pattern: 'solid',
  brand: 'not_visible',
  exactProduct: 'unknown',
  expectedResultType: 'identified_style',
  expectedAbstention: false,
  nonFashion: false,
});

function projection(overrides = {}) {
  return {
    category: 'footwear',
    subtype: 'low_top_sneaker',
    primaryColor: 'red',
    secondaryColors: ['white'],
    material: 'canvas',
    pattern: 'solid',
    brand: null,
    exactProduct: null,
    status: 'completed',
    resolutionLevel: 'subtype',
    schemaParseFailure: false,
    fallbackInvoked: false,
    ...overrides,
  };
}

// ── Comparison semantics ────────────────────────────────────────────────────

test('an identical control and candidate compare as unchanged on every field', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const candidate = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection(), label: LABEL });

  const compared = compareCandidates.compareCaseFields(control, candidate);
  assert.equal(compared.comparability, 'comparable');
  assert.equal(compared.penaltyDelta, 0);
  for (const field of compared.fields) {
    assert.equal(field.direction, compareCandidates.DIRECTIONS.UNCHANGED, `${field.field} must be unchanged`);
  }
});

test('a better candidate answer reads improved, a worse one reads regressed', () => {
  const control = scoredRecord({
    candidateVersion: CONTROL,
    runId: 'run-control',
    projection: projection({ subtype: null }),
    label: LABEL,
  });
  const better = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection(), label: LABEL });
  const improved = compareCandidates.compareCaseFields(control, better);
  const improvedSubtype = improved.fields.find((f) => f.field === 'subtype');
  assert.equal(improvedSubtype.direction, compareCandidates.DIRECTIONS.IMPROVED);
  assert.equal(improvedSubtype.controlAnswer, compareCandidates.ANSWER_STATES.ABSTAINED);
  assert.equal(improvedSubtype.candidateAnswer, compareCandidates.ANSWER_STATES.ANSWERED);
  assert.ok(improved.penaltyDelta < 0);

  const worse = scoredRecord({
    candidateVersion: CANDIDATE,
    runId: 'run-candidate',
    projection: projection({ subtype: 'chelsea_boot' }),
    label: LABEL,
  });
  const regressed = compareCandidates.compareCaseFields(control, worse);
  assert.equal(regressed.fields.find((f) => f.field === 'subtype').direction, compareCandidates.DIRECTIONS.REGRESSED);
  assert.ok(regressed.penaltyDelta > 0);
});

test('abstention is reported alongside the direction, never instead of it', () => {
  // The candidate abstains where the control answered wrongly. The penalty falls,
  // so the direction is "improved" — but the abstention must still be visible,
  // because "stopped answering" and "answered better" are different behaviours.
  const control = scoredRecord({
    candidateVersion: CONTROL,
    runId: 'run-control',
    projection: projection({ material: 'leather' }),
    label: { ...LABEL, material: 'not_visible' },
  });
  const candidate = scoredRecord({
    candidateVersion: CANDIDATE,
    runId: 'run-candidate',
    projection: projection({ material: null }),
    label: { ...LABEL, material: 'not_visible' },
  });
  const compared = compareCandidates.compareCaseFields(control, candidate);
  const material = compared.fields.find((f) => f.field === 'material');
  assert.equal(material.direction, compareCandidates.DIRECTIONS.IMPROVED);
  assert.equal(material.controlAnswer, compareCandidates.ANSWER_STATES.ANSWERED);
  assert.equal(material.candidateAnswer, compareCandidates.ANSWER_STATES.ABSTAINED);
});

test('not_measured is reported as its own answer state on both sides', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const candidate = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection(), label: LABEL });
  const compared = compareCandidates.compareCaseFields(control, candidate);
  const exactProduct = compared.fields.find((f) => f.field === 'exactProduct');
  assert.equal(exactProduct.controlAnswer, compareCandidates.ANSWER_STATES.NOT_MEASURED);
  assert.equal(exactProduct.candidateAnswer, compareCandidates.ANSWER_STATES.NOT_MEASURED);
  assert.equal(exactProduct.direction, compareCandidates.DIRECTIONS.UNCHANGED);
});

test('an unscoreable side makes the case invalid rather than inventing a diff', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const broken = {
    caseId: 'c1',
    runId: 'run-candidate',
    candidateVersion: CANDIDATE,
    status: 'provider_output_invalid',
    scoreability: 'not_scoreable',
    profiles: null,
  };
  const compared = compareCandidates.compareCaseFields(control, broken);
  assert.equal(compared.comparability, compareCandidates.COMPARABILITY.INVALID_CANDIDATE);
  assert.deepEqual(compared.fields, []);
});

test('the comparison refuses a pair that could not be a control and a candidate', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const candidate = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection(), label: LABEL });

  assert.throws(() => compareCandidates.compareCaseFields(control, control), /same object/);
  assert.throws(
    () => compareCandidates.compareCaseFields(candidate, candidate.caseId === 'c1' ? { ...control, candidateVersion: CANDIDATE } : control),
    /must name the certified control/
  );
  assert.throws(
    () => compareCandidates.compareCaseFields(control, { ...control, runId: 'other' }),
    /names the certified control/
  );
  assert.throws(
    () => compareCandidates.compareCaseFields(control, { ...candidate, caseId: 'c2' }),
    /requires one governed case/
  );
  // Same run id on two different executions means one overwrote the other.
  assert.throws(
    () => compareCandidates.compareCaseFields(control, { ...candidate, runId: 'run-control' }),
    candidateRegistry.ResultIdentityCollision
  );
});

test('comparing does not mutate either record', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const candidate = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection({ subtype: null }), label: LABEL });
  const controlBefore = JSON.stringify(control);
  const candidateBefore = JSON.stringify(candidate);

  compareCandidates.compareCaseFields(control, candidate);
  compareCandidates.compareRuns(
    { records: [control] },
    { records: [candidate], candidateVersion: CANDIDATE }
  );

  assert.equal(JSON.stringify(control), controlBefore, 'candidate output must not modify certified output');
  assert.equal(JSON.stringify(candidate), candidateBefore);
});

test('a run comparison requires one identical governed case set', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const candidate = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection(), label: LABEL });
  assert.throws(
    () => compareCandidates.compareRuns({ records: [control] }, { records: [] }),
    /identical governed case set/
  );
  assert.throws(
    () => compareCandidates.compareRuns({ records: [] }, { records: [candidate] }),
    /identical governed case set/
  );
});

test('a comparison artifact may not carry an absolute private path', () => {
  assert.throws(
    () => compareCandidates.assertNoAbsolutePaths({ outputRoot: 'C:\\Users\\someone\\KScan-eval-storage-private' }),
    /absolute path/
  );
  assert.throws(
    () => compareCandidates.assertNoAbsolutePaths({ note: 'wrote to /Users/someone/private/results' }),
    /absolute path/
  );
  assert.equal(compareCandidates.assertNoAbsolutePaths({ caseId: 'set-501xx-jeans', totals: {} }), true);
});

test('the artifact states that mocked transport is not accuracy evidence', () => {
  const control = scoredRecord({ candidateVersion: CONTROL, runId: 'run-control', projection: projection(), label: LABEL });
  const candidate = scoredRecord({ candidateVersion: CANDIDATE, runId: 'run-candidate', projection: projection(), label: LABEL });
  const artifact = compareCandidates.compareRuns(
    { records: [control] },
    { records: [candidate], candidateVersion: CANDIDATE }
  );
  assert.equal(artifact.measuredAccuracyClaim, 'not_claimed');
  assert.equal(artifact.scoringContractVersion, '0.3.0');
  assert.equal(artifact.caseComparisonVersion, compareCandidates.CASE_COMPARISON_VERSION);
  assert.equal(artifact.candidateCandidateVersion, CANDIDATE);
  assert.equal(artifact.comparableCaseCount, 1);
  for (const key of ['improved', 'regressed', 'changed', 'unchanged', 'abstained', 'not_measured', 'invalid']) {
    assert.equal(typeof artifact.totals[key], 'number', `${key} must be reported`);
  }
});

// ── Mocked end-to-end: one governed case, both executions ───────────────────

test('governed case reaches certified v140 as control and as Phase 2A candidate, with isolated results', async (t) => {
  if (!fs.existsSync(SNAPSHOT_ROOT)) {
    t.skip('certified snapshot is required for the funnel test');
    return;
  }

  const selected = SELECTION.selections.find((entry) => entry.caseId === 'set-501xx-jeans');
  const caseRecord = MANIFEST.cases.find((entry) => entry.caseId === selected.caseId);
  const sourcePath = governedStorage.resolveImageRef(selected.selectedRef, { storageRoot: STORAGE_ROOT });
  const derivativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2a-e2e-derivative-'));

  const roots = {
    [CONTROL]: governedStorage.privateResultsRoot('phase2a-e2e-control', STORAGE_ROOT),
    [CANDIDATE]: governedStorage.privateResultsRoot('phase2a-e2e-candidate', STORAGE_ROOT),
  };
  for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });

  try {
    const prepared = await imagePreparation.prepareImage({
      sourcePath,
      expectedSourceSha256: selected.selectedHash,
      viewId: 'path-b-selected',
      derivativeRoot,
    });
    const plan = {
      caseId: caseRecord.caseId,
      imageCount: caseRecord.imageCount,
      multiImageSet: true,
      consolidatedCallEmitted: false,
      plannedCallCount: 1,
      nonExecutedProvenanceImageCount: selected.nonExecutedRefs.length,
      calls: [{
        caseId: caseRecord.caseId,
        imageRef: selected.selectedRef,
        imageHash: selected.selectedHash,
        preparation: prepared,
      }],
    };
    const sourceIdentity = liveAdapter.verifyExecutionSource(SNAPSHOT_ROOT);

    const harnessReports = {};
    function runOne(candidateVersion) {
      const outputRoot = roots[candidateVersion];
      const identity = {
        runId: candidateVersion === CONTROL ? 'phase2a-e2e-control' : 'phase2a-e2e-candidate',
        datasetVersion: MANIFEST.datasetVersion,
        datasetManifestSha256: MANIFEST_SHA256,
        holdoutSealSha256: null,
        sourceCommit: 'phase2a-selftest',
        certifiedCommit: sourceIdentity.certifiedCommit,
        certifiedBundleHash: sourceIdentity.bundleHash,
        certifiedSnapshotSha256: sourceIdentity.closureAggregateSha256,
        selectionContractSha256: SELECTION.selectionContractSha256,
        // The SAME certified model topology on both sides. This is what makes
        // candidateVersion the only thing separating the two identities.
        modelConfigurationId: 'certified-v140',
        candidateVersion,
      };
      const countTokens = ({ model, call }) => ({
        inputTokens: model === build4Funnel.PRIMARY_MODEL ? 1234 : 1201,
        serializedRequestPayload: JSON.stringify({ model, imageSha256: call.imageHash, evidenceCount: 1 }),
        systemInstructionSha256: 'system-v140',
        promptSha256: 'prompt-v140',
        toolDeclarationsSha256: 'none',
        generationConfigSha256: 'generation-v140',
      });
      const executeAdapter = () => {
        const out = path.join(outputRoot, 'harness-report.json');
        const candidateArgs = candidateVersion === CONTROL
          ? ['--candidate-version', CONTROL]
          : ['--candidate-version', CANDIDATE, '--overlay-file', OVERLAY_FILE];
        execFileSync('deno', [
          'run',
          `--allow-read=${SNAPSHOT_ROOT},${path.join(ROOT, 'tools/scanner-evaluation/adapter')},${derivativeRoot}`,
          `--allow-write=${outputRoot}`,
          '--allow-env',
          '--no-lock',
          'tools/scanner-evaluation/adapter/deno/certifiedHarness.ts',
          '--cert-root', SNAPSHOT_ROOT,
          '--scenario', 'completed',
          '--image-file', prepared.derivativePath,
          '--image-width', String(prepared.derivativeWidth),
          '--image-height', String(prepared.derivativeHeight),
          '--case-id', caseRecord.caseId,
          '--out', out,
          ...candidateArgs,
        ], { cwd: ROOT, stdio: 'pipe' });
        const report = JSON.parse(fs.readFileSync(out, 'utf8'));
        harnessReports[candidateVersion] = report;
        return report;
      };

      const runReport = build4Funnel.executeGovernedRun({
        manifest: MANIFEST,
        manifestSha256: MANIFEST_SHA256,
        selectionArtifact: SELECTION,
        cases: [caseRecord],
        plans: [plan],
        outputRoot,
        storageRoot: STORAGE_ROOT,
        runIdentityRecord: identity,
        pricing: PRICING,
        spendCeilingUsd: 10,
        attemptCeiling: 2,
        countTokens,
        executeAdapter,
      });
      return { runReport, outputRoot, record: runnerState.readCaseResult(outputRoot, caseRecord.caseId) };
    }

    const control = runOne(CONTROL);
    const candidate = runOne(CANDIDATE);

    // ── The overlay actually reached the certified request ──────────────────
    assert.equal(harnessReports[CONTROL].candidateVersion, CONTROL);
    assert.equal(harnessReports[CONTROL].overlayId, null);
    assert.equal(harnessReports[CONTROL].overlayApplications.promptsExtended, 0);

    assert.equal(harnessReports[CANDIDATE].candidateVersion, CANDIDATE);
    assert.equal(harnessReports[CANDIDATE].overlayId, 'phase2a-fashion-specificity-v1');
    assert.equal(
      harnessReports[CANDIDATE].overlayApplications.promptsExtended,
      1,
      'the candidate must have extended exactly the one certified prompt it sent'
    );
    assert.equal(harnessReports[CANDIDATE].overlaySha256.length, 64);
    // Same certified topology on both sides.
    assert.deepEqual(harnessReports[CANDIDATE].modelsUsed, harnessReports[CONTROL].modelsUsed);
    assert.equal(harnessReports[CANDIDATE].counters.unexpectedNetworkAttempts, 0);
    assert.equal(harnessReports[CANDIDATE].counters.supabaseHostAttempts, 0);
    assert.equal(harnessReports[CANDIDATE].counters.commerceHostAttempts, 0);

    // ── Both reached a terminal, scoreable private result ───────────────────
    for (const [version, side] of [[CONTROL, control], [CANDIDATE, candidate]]) {
      assert.equal(side.record.status, 'provider_success', `${version} must reach a provider success`);
      assert.equal(side.record.parseStatus, 'parsed');
      assert.equal(side.record.validation.ok, true);
      assert.equal(side.record.scoreability, 'scoreable');
      assert.equal(side.record.candidateVersion, version);
      assert.equal(side.record.observed.contractVersion, 'fashion-identification-v2');
      assert.equal(side.record.projection.projectionVersion, scoringProjection.SCORING_PROJECTION_VERSION);
      assert.equal(side.runReport.completedCaseCount, 1);
      assert.equal(side.runReport.scoredCaseCount, 1);

      const serialized = JSON.stringify(side.record);
      assert.equal(serialized.includes('rawPayload'), false, 'no raw provider response may be persisted');
      assert.equal(/[A-Za-z]:\\/.test(serialized), false, 'no absolute path may be persisted');
    }

    // ── Result, cache and directory isolation ──────────────────────────────
    assert.notEqual(control.outputRoot, candidate.outputRoot);
    assert.notEqual(control.record.runId, candidate.record.runId);
    assert.notEqual(
      control.record.countTokens.primaryRequestIdentity,
      candidate.record.countTokens.primaryRequestIdentity,
      'the candidate may not inherit the control cached count'
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(control.outputRoot, 'preflight', `${caseRecord.caseId}.json`), 'utf8')).candidateVersion,
      CONTROL
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(candidate.outputRoot, 'preflight', `${caseRecord.caseId}.json`), 'utf8')).candidateVersion,
      CANDIDATE
    );

    // ── Candidate post-validation ran on the candidate only ────────────────
    assert.equal(control.record.candidateFindings.applicable, false);
    assert.equal(control.record.candidateFindings.policy, 'certified_only');
    assert.equal(candidate.record.candidateFindings.applicable, true);
    assert.equal(candidate.record.candidateFindings.policy, 'phase2a_evidence_discipline');

    // ── The comparison ─────────────────────────────────────────────────────
    const artifact = compareCandidates.compareRuns(
      { records: [control.record], runId: control.record.runId },
      { records: [candidate.record], runId: candidate.record.runId, candidateVersion: CANDIDATE }
    );
    assert.equal(artifact.caseCount, 1);
    assert.equal(artifact.comparableCaseCount, 1);
    assert.equal(artifact.cases[0].comparability, 'comparable');
    assert.ok(artifact.cases[0].fields.length > 0, 'a comparable case must produce a field diff');
    assert.equal(artifact.measuredAccuracyClaim, 'not_claimed');
    // The mock returns one envelope to both sides, so the SCORES must match
    // exactly. Any difference here would mean the candidate path changed
    // something other than the instructions.
    assert.equal(artifact.candidateTotalPenalty, artifact.controlTotalPenalty);
    assert.equal(artifact.totals.regressed, 0);
    assert.equal(artifact.totals.improved, 0);
    compareCandidates.assertNoAbsolutePaths(artifact);

    // ── The certified result was not touched by the candidate run ──────────
    const controlAfter = runnerState.readCaseResult(control.outputRoot, caseRecord.caseId);
    assert.deepEqual(controlAfter, control.record, 'the candidate run must not have modified the certified result');

    // ── The same comparison is reachable from the two run directories ──────
    const fromDirectories = compareRunDirectories(control.outputRoot, candidate.outputRoot);
    assert.equal(fromDirectories.caseCount, artifact.caseCount);
    assert.equal(fromDirectories.candidateCandidateVersion, CANDIDATE);
    assert.equal(fromDirectories.controlTotalPenalty, artifact.controlTotalPenalty);
    assert.equal(fromDirectories.candidateTotalPenalty, artifact.candidateTotalPenalty);
    // The run manifests record which execution each directory holds.
    assert.equal(runnerState.readRunManifest(control.outputRoot).candidateVersion, CONTROL);
    assert.equal(runnerState.readRunManifest(candidate.outputRoot).candidateVersion, CANDIDATE);
  } finally {
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(derivativeRoot, { recursive: true, force: true });
  }
});
