#!/usr/bin/env node
'use strict';

/**
 * Scanner accuracy baseline runner.
 *
 * SAFETY POSTURE
 *   - There is NO built-in model executor. `--execute` requires an adapter to be
 *     injected explicitly. Running this file with no adapter cannot make a paid
 *     call, cannot open a socket, and cannot write to any database.
 *   - `--dry-run` is the default. You must opt IN to execution, never out.
 *   - Every completed case is written to its own file the moment it completes,
 *     so a cancelled or crashed run never loses work already paid for.
 *
 * Usage
 *   node tools/scanner-evaluation/run-baseline.js --dry-run --output-dir <dir>
 *   node tools/scanner-evaluation/run-baseline.js --dry-run --case-id qa-footwear-001
 *   node tools/scanner-evaluation/run-baseline.js --execute --resume --output-dir <dir> --max-calls 80
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { validateManifest } = require('./lib/datasetValidate');
const { SCORING_CONTRACT_VERSION } = require('./lib/scoreFields');
const { validateExperimentRecord } = require('./lib/experimentMeta');
const ontology = require('./lib/ontology');
const resultState = require('./lib/resultState');
const runnerState = require('./lib/runnerState');
const { verifyFrozenDataset } = require('./lib/frozenDataset');
const governedStorage = require('./lib/governedStorage');
const capturePreparation = require('./lib/capturePreparation');
const costLedger = require('./lib/costLedger');
const runIdentity = require('./lib/runIdentity');
const providerAccounting = require('./lib/providerAccounting');
const imagePreparation = require('./lib/imagePreparation');
const baselineInputSelection = require('./lib/baselineInputSelection');
const liveAdapter = require('./lib/liveAdapter');
const build4Funnel = require('./lib/build4Funnel');
const prepareDerivatives = require('./prepare-derivatives');
const candidateRegistry = require('./lib/candidateRegistry');

// PHASE 3 LIVE-EVALUATION PATCH (evaluation/scanner-phase2a-v1-live, applied to
// this copy only — the governed Phase 2B source at 4368067 is unmodified).
//
// build4Funnel.candidateVersionOf() already resolves `identity.candidateVersion`
// through the existing candidateRegistry (control when absent/null, a registered
// candidate when named, fail-closed on anything unknown). This runner never set
// that field, so every prior invocation of this CLI was silently control-only —
// there was no way to dispatch the phase2a-v1.0.0 overlay through this script.
// This patch adds exactly one CLI flag and threads it into the existing identity
// object; it changes no default behaviour (omitting the flag reproduces today's
// control-only run byte-for-byte, since `identity.candidateVersion` stays
// undefined, same as before this patch existed).

const ROOT = path.resolve(__dirname, '..', '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    execute: false,
    outputDir: null,
    resume: false,
    startCase: null,
    caseId: null,
    maxCalls: null,
    manifest: 'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json',
    split: null,
    maxUsd: null,
    pricingRecord: null,
    holdoutSeal: null,
    capturePreparation: null,
    preparationManifest: null,
    adapterId: null,
    certifiedBundleSha256: null,
    selectionArtifact: 'evals/scanner-accuracy/execution/baseline-input-selection.v1.json',
    certifiedSnapshot: null,
    candidateVersion: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--dry-run': args.dryRun = true; args.execute = false; break;
      case '--execute': args.execute = true; args.dryRun = false; break;
      case '--output-dir': args.outputDir = next(); break;
      case '--resume': args.resume = true; break;
      case '--start-case': args.startCase = next(); break;
      case '--case-id': args.caseId = next(); break;
      case '--max-calls': {
        const raw = next();
        args.maxCalls = Number(raw);
        if (!Number.isSafeInteger(args.maxCalls) || args.maxCalls < 0) {
          throw new Error(`--max-calls must be a non-negative integer, received ${raw}`);
        }
        break;
      }
      case '--manifest': args.manifest = next(); break;
      case '--split': {
        const value = next();
        if (!runIdentity.SPLITS.includes(value)) {
          throw new Error(`--split must be one of ${runIdentity.SPLITS.join(', ')}, received ${value}`);
        }
        args.split = value;
        break;
      }
      case '--max-usd': {
        const raw = next();
        args.maxUsd = Number(raw);
        if (!Number.isFinite(args.maxUsd) || args.maxUsd < 0) {
          throw new Error(`--max-usd must be a non-negative number, received ${raw}`);
        }
        break;
      }
      case '--pricing-record': args.pricingRecord = next(); break;
      case '--holdout-seal': args.holdoutSeal = next(); break;
      case '--capture-preparation': {
        // Validated here so an unknown mode fails at argument parse time rather
        // than after preflight has already resolved images.
        args.capturePreparation = capturePreparation.resolveMode(next());
        break;
      }
      case '--preparation-manifest': args.preparationManifest = next(); break;
      case '--adapter-id': args.adapterId = next(); break;
      case '--certified-bundle-sha256': args.certifiedBundleSha256 = next(); break;
      case '--selection-artifact': args.selectionArtifact = next(); break;
      case '--certified-snapshot': args.certifiedSnapshot = next(); break;
      case '--candidate-version': {
        const value = next();
        if (!candidateRegistry.isKnown(value)) {
          throw new Error(`--candidate-version must be one of ${candidateRegistry.versions().join(', ')}, received ${value}`);
        }
        args.candidateVersion = value;
        break;
      }
      case '--help': args.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

// ── Pre-flight validation ────────────────────────────────────────────────────

/**
 * Resolve an image reference to an absolute path.
 *
 * Tier A images live in governed storage OUTSIDE every Git worktree and are
 * addressed by a logical `storage://bucket/path` URI. Joining such a URI onto the
 * repo root can never resolve, which previously made every governed case fail
 * preflight with a misleading "missing governed image".
 *
 * Fails CLOSED: if the storage root is not configured, that is reported as a
 * configuration error, never silently reinterpreted as a repo-relative path — the
 * latter would let a same-named file inside the repo masquerade as governed data.
 */
/**
 * Delegates to the single shared resolver.
 *
 * This function previously carried its OWN copy of the resolution rules. That
 * duplicate is exactly how the storage contract drifted: the copy here and the
 * one in lib/governedStorage.js could disagree, and both disagreed with the
 * acquirer, which has always written to <root>/tier-a. One implementation now
 * owns the rule.
 */
function resolveImageRef(refValue) {
  return governedStorage.resolveImageRef(refValue);
}

/**
 * Validate one governed case without calling anything.
 * Every check here is a gate: a case that fails is never executed.
 */
function preflightCase(caseRecord, options = {}) {
  const findings = [];
  const preparationMode = capturePreparation.resolveMode(options.capturePreparation);
  const refs = Array.isArray(caseRecord.imageReferences) ? caseRecord.imageReferences : [];
  const hashes = Array.isArray(caseRecord.imageHashes) ? caseRecord.imageHashes : [];

  if (refs.length !== hashes.length) {
    findings.push({ severity: 'blocking', check: 'hash_count', message: `${refs.length} references vs ${hashes.length} hashes` });
  }
  if (refs.length !== caseRecord.imageCount) {
    findings.push({ severity: 'blocking', check: 'image_count', message: `imageCount ${caseRecord.imageCount} != ${refs.length} references` });
  }

  const resolvedImages = [];
  refs.forEach((ref, index) => {
    let absolute;
    try {
      absolute = resolveImageRef(ref.refValue);
    } catch (err) {
      findings.push({ severity: 'blocking', check: 'storage_root', message: err.message });
      return;
    }
    const expected = hashes[index];
    if (!fs.existsSync(absolute)) {
      findings.push({ severity: 'blocking', check: 'image_present', message: `missing governed image: ${ref.refValue}` });
      return;
    }
    const actual = governedStorage.sha256OfFile(absolute);
    if (actual !== expected) {
      findings.push({
        severity: 'blocking',
        check: 'image_hash',
        message: `hash mismatch for ${ref.refValue}: manifest ${expected}, file ${actual}`,
      });
      return;
    }
    const byteLength = fs.statSync(absolute).size;

    // The certified path rejects an oversized base64 payload BEFORE calling the
    // provider, and the production client never posts an original. Both are
    // checked here so neither can quietly become a "Scanner failure". When a
    // preparation stage is declared, the ceiling is checked against the PREPARED
    // derivative, because that is what will actually be sent.
    const preparation = options.preparations ? options.preparations.get(ref.refValue) : null;
    const payload = capturePreparation.evaluateImage(
      { byteLength, refValue: ref.refValue, hash: actual },
      { mode: preparationMode, preparation }
    );
    for (const finding of payload.findings) findings.push(finding);

    resolvedImages.push({
      refValue: ref.refValue,
      refType: ref.refType,
      hash: actual,
      byteLength,
      base64Length: payload.base64Length,
      preparation: preparation
        ? {
          viewId: preparation.viewId,
          derivativeSha256: preparation.derivativeSha256,
          derivativePath: preparation.derivativePath,
          derivativeWidth: preparation.derivativeWidth,
          derivativeHeight: preparation.derivativeHeight,
          derivativeByteLength: preparation.derivativeByteLength,
          derivativeBase64Length: preparation.derivativeBase64Length,
          withinCertifiedCeiling: preparation.withinCertifiedCeiling,
          policy: preparation.policy,
          transform: preparation.transform,
          codec: preparation.codec,
          upscaled: preparation.upscaled,
        }
        : null,
    });
  });

  const approved = new Set(['approved_internal_eval', 'approved_qa_fixture']);
  if (!approved.has(caseRecord.authorizationStatus)) {
    findings.push({ severity: 'blocking', check: 'authorization', message: `authorizationStatus ${caseRecord.authorizationStatus} is not approved for execution` });
  }

  const allowedPrivacy = new Set(['hash_and_label_only', 'governed_fixture_reference', 'synthetic_text_only', 'masked_derivative_approved']);
  if (!allowedPrivacy.has(caseRecord.privacyDisposition)) {
    findings.push({ severity: 'blocking', check: 'privacy', message: `privacyDisposition ${caseRecord.privacyDisposition} blocks execution` });
  }
  if (caseRecord.reviewStatus !== 'approved') {
    findings.push({ severity: 'blocking', check: 'review_status', message: `reviewStatus ${caseRecord.reviewStatus} is not approved` });
  }
  if (!caseRecord.exifRemoved && caseRecord.exifRemoved !== undefined) {
    findings.push({ severity: 'blocking', check: 'exif', message: 'exifRemoved is false' });
  }

  const validStates = new Set(Object.values(resultState.RESULT_STATES));
  if (!validStates.has(caseRecord.expectedResultType)) {
    findings.push({ severity: 'blocking', check: 'expected_result_state', message: `invalid expectedResultType ${caseRecord.expectedResultType}` });
  }
  if (caseRecord.expectedResultType === resultState.RESULT_STATES.LIKELY_EXACT_MATCH) {
    findings.push({
      severity: 'advisory',
      check: 'measurement_ceiling_mc1',
      message:
        'expected likely_exact_match is UNREACHABLE on deployed v140 (exactProduct hardcoded null). This case will score under_identification by contract, not by model quality.',
    });
  }

  return {
    caseId: caseRecord.caseId,
    ok: findings.every((f) => f.severity !== 'blocking'),
    findings,
    resolvedImages,
    capturePreparationMode: preparationMode,
  };
}

/**
 * Build the planned call graph. Path B freezes one production input per case,
 * because the deployed identification path accepts a single V2 evidence item.
 */
function planCase(caseRecord, preflight, frozenSelection) {
  if (!frozenSelection || frozenSelection.caseId !== caseRecord.caseId) {
    throw new Error(`case ${caseRecord.caseId} has no verified frozen input selection`);
  }
  const selected = preflight.resolvedImages.find(
    (image) => image.refValue === frozenSelection.selectedRef && image.hash === frozenSelection.selectedHash
  );
  if (!selected) {
    throw new Error(`case ${caseRecord.caseId} frozen selected input did not pass governed preflight`);
  }
  const calls = [{
    callIndex: 0,
    caseId: caseRecord.caseId,
    evidenceSequenceIndex: 0,
    imageRef: selected.refValue,
    imageHash: selected.hash,
    byteLength: selected.byteLength,
    // The prepared derivative is what the adapter must actually send. Carrying it
    // on the call means the executor cannot accidentally read the original.
    preparation: selected.preparation || null,
    payloadBase64Length: selected.base64Length,
    contractVersion: 'fashion-identification-v2',
    // Only intents, modes and privacy fields verified present in the source
    // contract are used. Nothing is invented.
    intent: 'identify_for_style',
    mode: 'identify_selected_item',
    privacy: { localFaceMaskApplied: false, localPlateMaskApplied: false, rawExifTransmitted: false },
    commerceExpected: false,
  }];

  return {
    caseId: caseRecord.caseId,
    imageCount: preflight.resolvedImages.length,
    multiImageSet: preflight.resolvedImages.length > 1,
    consolidatedCallEmitted: false,
    calls,
    plannedCallCount: calls.length,
    selectedInputContractVersion: baselineInputSelection.SELECTION_CONTRACT_VERSION,
    selectedIndex: frozenSelection.selectedIndex,
    nonExecutedProvenanceImageCount: frozenSelection.nonExecutedRefs.length,
    totalInputBytes: selected.byteLength,
  };
}

/** Fail-closed executor. Replaced only by an explicitly injected adapter. */
function unauthorizedExecutor() {
  throw new Error(
    'No execution adapter is installed. The paid baseline is not authorized and this runner ' +
      'contains no model client, no network transport and no persistence writer. ' +
      'Install an owner-approved adapter before using --execute.'
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2), { executor = unauthorizedExecutor, countTokens = null, now = null } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('see file header for usage');
    return { ok: true, help: true };
  }

  const datasetVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/dataset-version.json'), 'utf8')
  );
  const manifestPath = path.resolve(ROOT, args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validated = validateManifest(manifest, { expectedDatasetVersion: manifest.datasetVersion });
  if (!validated.ok) {
    console.error(JSON.stringify({ ok: false, stage: 'manifest', errors: validated.errors }, null, 2));
    process.exitCode = 1;
    return { ok: false, errors: validated.errors };
  }

  if (manifest.datasetVersion !== datasetVersion.datasetVersion) {
    const errors = [{
      check: 'dataset_version',
      message: `manifest dataset version ${manifest.datasetVersion} does not match active governed version ${datasetVersion.datasetVersion}`,
    }];
    console.error(JSON.stringify({ ok: false, stage: 'dataset_version', errors }, null, 2));
    process.exitCode = 1;
    return { ok: false, stage: 'dataset_version', errors };
  }

  let frozenDataset = null;
  if (datasetVersion.activeFreeze) {
    const expectedManifest = datasetVersion.activeFreeze.manifest;
    const selectedManifest = path.relative(ROOT, manifestPath).replace(/\\/g, '/');
    if (selectedManifest !== expectedManifest) {
      const errors = [{
        check: 'canonical_manifest',
        message: `active dataset version ${datasetVersion.datasetVersion} must use ${expectedManifest}`,
      }];
      console.error(JSON.stringify({ ok: false, stage: 'frozen_dataset', errors }, null, 2));
      process.exitCode = 1;
      return { ok: false, stage: 'frozen_dataset', errors };
    }
    const frozen = verifyFrozenDataset(
      manifestPath,
      path.join(ROOT, datasetVersion.activeFreeze.freezeRecord)
    );
    if (!frozen.ok) {
      console.error(JSON.stringify({ ok: false, stage: 'frozen_dataset', errors: frozen.errors }, null, 2));
      process.exitCode = 1;
      return { ok: false, stage: 'frozen_dataset', errors: frozen.errors, frozen };
    }
    frozenDataset = frozen;
  }

  const manifestSha256 = baselineInputSelection.sha256Hex(fs.readFileSync(manifestPath));
  const selectionPath = path.resolve(ROOT, args.selectionArtifact);
  const selectionArtifact = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  const selectionCheck = baselineInputSelection.verifyArtifact(
    selectionArtifact,
    manifest,
    { manifestSha256 }
  );
  if (!selectionCheck.ok) {
    console.error(JSON.stringify({ ok: false, stage: 'input_selection', errors: selectionCheck.errors }, null, 2));
    process.exitCode = 1;
    return { ok: false, stage: 'input_selection', errors: selectionCheck.errors };
  }
  const frozenSelectionByCase = new Map(selectionArtifact.selections.map((entry) => [entry.caseId, entry]));

  const outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
  if (args.execute && !outputDir) throw new Error('--execute requires --output-dir');
  if (args.execute && args.maxCalls == null) throw new Error('--execute requires an explicit --max-calls ceiling');
  // Adapter absence stays the FIRST refusal after the call ceiling. It is the
  // strongest safety property in the file — no adapter means no transport exists
  // at all — so it must not be shadowed by an economic gate that only matters for
  // a run that could otherwise actually spend money.
  if (args.execute && executor === unauthorizedExecutor) unauthorizedExecutor();
  // A call ceiling does not bound money: cost per attempt varies by model and by
  // token count, so spend needs its own explicit ceiling.
  if (args.execute && args.maxUsd == null) throw new Error('--execute requires an explicit --max-usd spend ceiling');
  if (args.execute && !args.pricingRecord) {
    throw new Error(
      '--execute requires --pricing-record naming a verified pricing file. There is no built-in price table, '
        + 'because stale pricing is how a spend ceiling gets silently exceeded.'
    );
  }
  if (args.execute && !args.split) {
    throw new Error(
      '--execute requires --split development|holdout. A single run may never span both: the holdout is the only '
        + 'check between a tuned harness and a self-confirming result, and observing it alongside development destroys it.'
    );
  }

  // ── Split isolation ────────────────────────────────────────────────────────
  const partition = runIdentity.partitionBySplit(validated.cases, manifest.split);
  if (partition.unassigned.length > 0) {
    const errors = [{
      check: 'split_membership',
      message: `cases assigned to neither split: ${partition.unassigned.join(', ')}`,
    }];
    console.error(JSON.stringify({ ok: false, stage: 'split', errors }, null, 2));
    process.exitCode = 1;
    return { ok: false, stage: 'split', errors };
  }

  const splitCases = args.split === runIdentity.SPLIT_HOLDOUT
    ? partition.holdout
    : args.split === runIdentity.SPLIT_DEVELOPMENT
      ? partition.development
      : validated.cases;

  // ── Holdout seal ───────────────────────────────────────────────────────────
  let holdoutSeal = null;
  if (args.split === runIdentity.SPLIT_HOLDOUT) {
    const sealRecord = args.holdoutSeal
      ? JSON.parse(fs.readFileSync(path.resolve(ROOT, args.holdoutSeal), 'utf8'))
      : null;
    const sealCheck = runIdentity.verifyHoldoutSeal(sealRecord, partition.holdout, {
      datasetAggregateSha256: frozenDataset ? frozenDataset.aggregateSha256 : undefined,
    });
    if (!sealCheck.ok) {
      console.error(JSON.stringify({ ok: false, stage: 'holdout_seal', errors: sealCheck.errors }, null, 2));
      process.exitCode = 1;
      return { ok: false, stage: 'holdout_seal', errors: sealCheck.errors };
    }
    holdoutSeal = { ...sealRecord, verifiedLockedLabelSha256: sealCheck.observedLockedLabelSha256 };
  }

  // ── Capture preparation ────────────────────────────────────────────────────
  // A declared preparation stage must be backed by a real manifest of real
  // derivatives. Declaring the mode without the artifact is refused, so the gate
  // cannot be satisfied by an assertion.
  const preparationMode = capturePreparation.resolveMode(args.capturePreparation);
  let preparationManifest = null;
  const preparations = new Map();
  if (args.preparationManifest) {
    preparationManifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.preparationManifest), 'utf8'));
    const errors = [];
    if (preparationManifest.datasetVersion !== manifest.datasetVersion) {
      errors.push({
        check: 'preparation_dataset_version',
        message: `preparation manifest is for dataset ${preparationManifest.datasetVersion}, run is ${manifest.datasetVersion}`,
      });
    }
    if (frozenDataset
      && preparationManifest.datasetAggregateSha256
      && preparationManifest.datasetAggregateSha256 !== frozenDataset.aggregateSha256) {
      errors.push({
        check: 'preparation_dataset_aggregate',
        message:
          `preparation manifest was produced against aggregate ${preparationManifest.datasetAggregateSha256}, `
          + `current is ${frozenDataset.aggregateSha256}`,
      });
    }
    // The recorded hash must still describe the manifest's contents, so an edited
    // preparation record cannot pass itself off as the one that was produced.
    const recomputed = prepareDerivatives.preparationManifestHash(preparationManifest);
    if (recomputed !== preparationManifest.preparationManifestSha256) {
      errors.push({
        check: 'preparation_manifest_hash',
        message:
          `preparation manifest hash does not reproduce: recorded ${preparationManifest.preparationManifestSha256}, `
          + `recomputed ${recomputed}`,
      });
    }
    if (errors.length > 0) {
      console.error(JSON.stringify({ ok: false, stage: 'capture_preparation', errors }, null, 2));
      process.exitCode = 1;
      return { ok: false, stage: 'capture_preparation', errors };
    }
    for (const image of preparationManifest.images || []) preparations.set(image.refValue, image);
  }

  if (args.execute) {
    if (!capturePreparation.isProductionEquivalent(preparationMode)) {
      throw new Error(
        `--execute requires a production-equivalent --capture-preparation mode, received "${preparationMode}". `
          + 'The certified client resizes and re-encodes before upload; measuring anything else does not '
          + 'produce a production Scanner baseline.'
      );
    }
    if (!preparationManifest) {
      throw new Error(
        '--execute with a production-equivalent capture preparation requires --preparation-manifest. '
          + 'Run prepare-derivatives.js first; a declared preparation stage may not be notional.'
      );
    }
    if (!countTokens) {
      throw new Error('--execute requires an injected countTokens transport; no implementation ships in the runner');
    }
    if (!args.certifiedSnapshot) {
      throw new Error('--execute requires --certified-snapshot naming the immutable certified v140 source package');
    }
  }

  // ── Verified pricing and the spend ledger ──────────────────────────────────
  let pricing = null;
  if (args.pricingRecord) {
    pricing = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.pricingRecord), 'utf8'));
    const validatedPricing = costLedger.validatePricing(pricing);
    if (!validatedPricing.ok) {
      console.error(JSON.stringify({ ok: false, stage: 'pricing', errors: validatedPricing.errors }, null, 2));
      process.exitCode = 1;
      return { ok: false, stage: 'pricing', errors: validatedPricing.errors };
    }
  }

  if (outputDir && !args.resume) {
    const collisionNames = args.dryRun
      ? ['dry-run-plan.json']
      : [runnerState.RUN_MANIFEST, 'baseline-report.json'];
    const collisions = collisionNames.filter((name) => fs.existsSync(path.join(outputDir, name)));
    if (collisions.length > 0) {
      throw new Error(`output path collision: ${collisions.join(', ')} already exists; use a new output directory`);
    }
  }
  // ── Run identity ───────────────────────────────────────────────────────────
  const researchSha = git(['rev-parse', 'HEAD']);
  const stamp = now || new Date().toISOString();
  const adapterId = args.adapterId || 'v140';
  const certifiedExecution = args.certifiedSnapshot
    ? liveAdapter.verifyExecutionSource(path.resolve(ROOT, args.certifiedSnapshot))
    : null;
  // Resolved once here so buildRunId's directory-segment and identity.candidateVersion
  // (read by build4Funnel.candidateVersionOf) always agree on the same version.
  const resolvedCandidateVersion = args.candidateVersion || candidateRegistry.CONTROL_VERSION;
  const identity = {
    runId: runIdentity.buildRunId({
      datasetVersion: manifest.datasetVersion,
      adapterId,
      timestamp: stamp,
      mode: args.dryRun ? 'dry_run' : 'execute',
      researchSha,
      split: args.split || runIdentity.SPLIT_DEVELOPMENT,
      candidateVersion: candidateRegistry.runIdSegment(resolvedCandidateVersion),
    }),
    datasetVersion: manifest.datasetVersion,
    datasetAggregateSha256: frozenDataset ? frozenDataset.aggregateSha256 : null,
    datasetManifestSha256: manifestSha256,
    holdoutSealSha256: args.holdoutSeal
      ? baselineInputSelection.sha256Hex(fs.readFileSync(path.resolve(ROOT, args.holdoutSeal)))
      : null,
    adapterId,
    // Absent/null resolves to candidateRegistry.CONTROL_VERSION inside
    // build4Funnel.candidateVersionOf(); an unrecognised value can never reach
    // here because it was already rejected at arg-parse time above.
    candidateVersion: args.candidateVersion || null,
    certifiedBundleSha256: certifiedExecution
      ? certifiedExecution.bundleHash
      : args.certifiedBundleSha256 || null,
    certifiedCommit: certifiedExecution ? certifiedExecution.certifiedCommit : null,
    certifiedBundleHash: certifiedExecution ? certifiedExecution.bundleHash : null,
    certifiedSnapshotSha256: certifiedExecution ? certifiedExecution.closureAggregateSha256 : null,
    selectionContractSha256: selectionArtifact.selectionContractSha256,
    modelConfigurationId: 'certified-v140',
    sourceCommit: researchSha,
    split: args.split || null,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    capturePreparationMode: preparationMode,
    preparationManifestSha256: preparationManifest ? preparationManifest.preparationManifestSha256 : null,
    preparationPolicy: preparationManifest ? preparationManifest.policy : null,
    // Codec identity and the transform parameters are named in the identity, not
    // just folded into the manifest hash: this stage is production-EQUIVALENT, so
    // exactly which encoder and which parameters produced the payload is part of
    // what makes two runs comparable.
    preparationCodec: preparationManifest && preparationManifest.codec
      ? `sharp@${preparationManifest.codec.sharp}+libvips@${preparationManifest.codec.libvips}`
      : null,
    preparationTransformSignature: preparationManifest
      ? [
        `w${preparationManifest.certifiedContract.scannerImageMaxWidth}`,
        `q${preparationManifest.certifiedContract.jpegQuality}`,
        `cap${preparationManifest.certifiedContract.maxImageBase64Bytes}`,
      ].join('/')
      : null,
    hardCallCeiling: args.maxCalls == null ? null : args.maxCalls,
    spendCeilingUsd: args.maxUsd == null ? null : args.maxUsd,
  };

  if (outputDir && args.resume) {
    const priorRun = runnerState.readRunManifest(outputDir);
    // Resume previously compared only the dataset version — the one field least
    // likely to differ. Every field that changes what a result MEANS is compared.
    //
    // runId embeds a timestamp, so a resume legitimately carries a different one.
    // The prior run's id is ADOPTED (the run continues under one identity) while
    // every other identity field must still match exactly.
    if (priorRun && priorRun.runId) identity.runId = priorRun.runId;
    runIdentity.assertResumable(priorRun, identity);
  }

  const selection = runnerState.selectCases(splitCases, {
    outputDir: outputDir || path.join(ROOT, '.eval-noop'),
    resume: args.resume,
    startCase: args.startCase,
    caseId: args.caseId,
  });

  const budget = new runnerState.CallBudget(args.maxCalls == null ? Infinity : args.maxCalls);
  // The ceiling that actually bounds provider billing is on ATTEMPTS, not on
  // logical calls: the certified route permits SCANNER_MAX_ATTEMPTS per call.
  const account = new providerAccounting.ProviderAccount({
    maxAttempts: args.maxCalls == null ? Number.MAX_SAFE_INTEGER : args.maxCalls,
  });
  const preflights = [];
  const plans = [];
  const blocked = [];

  for (const caseRecord of selection.toProcess) {
    const preflight = preflightCase(caseRecord, { capturePreparation: args.capturePreparation, preparations });
    preflights.push(preflight);
    if (!preflight.ok) {
      blocked.push({ caseId: caseRecord.caseId, findings: preflight.findings.filter((f) => f.severity === 'blocking') });
      continue;
    }
    const plan = planCase(caseRecord, preflight, frozenSelectionByCase.get(caseRecord.caseId));
    budget.plan(plan.plannedCallCount);
    plans.push(plan);
  }

  const plannedCallCount = plans.reduce((sum, p) => sum + p.plannedCallCount, 0);
  const maxAttemptsPerCall = 2; // certified SCANNER_MAX_ATTEMPTS

  /**
   * Worst-case token usage for one provider attempt, read from the verified
   * pricing record rather than assumed here. Output is projected at the certified
   * hard cap so the ceiling holds even when a response runs long.
   */
  const perAttemptUsage = pricing
    ? {
      inputTokens:
        pricing.imageTokenModel.appliedToCertifiedClientPayload.imageTokensPerAttempt
        + pricing.certifiedRouteParameters.assumedTextInputTokensPerAttempt,
      maxOutputTokens: pricing.certifiedRouteParameters.maxOutputTokens,
    }
    : null;

  const costProjection = pricing
    ? costLedger.projectRun({
      callCount: plannedCallCount,
      attemptsPerCall: maxAttemptsPerCall,
      primaryModel: 'gemini-3.6-flash',
      fallbackModel: 'gemini-3.5-flash-lite',
      perCall: perAttemptUsage,
      fallbackPerCall: perAttemptUsage,
      pricing,
      ceilingUsd: args.maxUsd,
    })
    : null;

  const planDocument = {
    runId: identity.runId,
    runIdentity: identity,
    generatedAt: stamp,
    mode: args.dryRun ? 'dry_run' : 'execute',
    sourceSha: researchSha,
    split: args.split,
    splitCounts: {
      development: partition.development.length,
      holdout: partition.holdout.length,
    },
    capturePreparation: {
      mode: preparationMode,
      productionEquivalent: capturePreparation.isProductionEquivalent(preparationMode),
      // Provenance for the bytes that will actually be sent: source hash,
      // derivative hash, dimensions and transform parameters, per image.
      manifestSha256: preparationManifest ? preparationManifest.preparationManifestSha256 : null,
      policy: preparationManifest ? preparationManifest.policy : null,
      codec: preparationManifest ? preparationManifest.codec : null,
      derivativeRoot: preparationManifest ? preparationManifest.derivativeRoot : null,
      derivativesInGit: preparationManifest ? preparationManifest.derivativesInGit : null,
      fidelityLimitations: preparationManifest ? preparationManifest.fidelityLimitations : null,
      preparedPayloads: preparationManifest
        ? imagePreparation.summarizePreparations(
          plans.flatMap((p) => p.calls.map((c) => c.preparation).filter(Boolean))
        )
        : null,
      governedOriginals: capturePreparation.summarize(
        plans.flatMap((p) => p.calls.map((c) => ({ byteLength: c.byteLength }))),
        { mode: capturePreparation.MODE_CERTIFIED_CLIENT_EQUIVALENT }
      ),
    },
    certifiedPayloadContract: capturePreparation.CERTIFIED_CONTRACT,
    holdoutSeal: holdoutSeal
      ? { sealedAt: holdoutSeal.sealedAt, lockedLabelSha256: holdoutSeal.lockedLabelSha256 }
      : null,
    costProjection,
    datasetVersion: manifest.datasetVersion,
    datasetVersionFileVersion: datasetVersion.datasetVersion,
    manifest: args.manifest,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    ontologyVersions: ontology.ONTOLOGY_VERSIONS,
    resultStateMappingVersion: resultState.MAPPING_VERSION,
    measurementLimits: {
      benchmarkClassification: frozenDataset ? frozenDataset.frozenAs : null,
      notARealWorldSmartGlassesBenchmark: frozenDataset
        ? frozenDataset.notARealWorldSmartGlassesBenchmark
        : null,
      notAComprehensiveBrandAccuracyCorpus: frozenDataset
        ? frozenDataset.notAComprehensiveBrandAccuracyCorpus
        : null,
      positiveBrandSupport: frozenDataset ? frozenDataset.positiveBrandSupport : null,
      exactProductPrecision: 'not_measured',
      incorrectExactMatchRate: 'not_measured',
      exactProductMeasurementCeiling: 'MC-1',
    },
    caseCount: validated.cases.length,
    selectedCaseCount: selection.toProcess.length,
    skippedAlreadyComplete: selection.skipped,
    blockedCases: blocked,
    plannedCallCount,
    hardCallCeiling: budget.maxCalls === Infinity ? null : budget.maxCalls,
    totalInputBytes: plans.reduce((sum, p) => sum + p.totalInputBytes, 0),
    multiImageSetCount: plans.filter((p) => p.multiImageSet).length,
    plans,
    inputSelection: {
      version: selectionArtifact.selectionContractVersion,
      contractSha256: selectionArtifact.selectionContractSha256,
      selectedInputCount: selectionArtifact.selectedInputCount,
      multiImageCaseCount: selectionArtifact.multiImageCaseCount,
      nonExecutedProvenanceImageCount: selectionArtifact.nonExecutedProvenanceImageCount,
      evaluationOnlyReconciliation: selectionArtifact.evaluationOnlyReconciliation,
    },
    guarantees: {
      modelCallsExecuted: 0,
      networkCallsExecuted: 0,
      persistenceWritesExecuted: 0,
      adapterInvoked: false,
      costUsd: '0.00',
      commerceEnabled: false,
      productionEndpointContacted: false,
    },
  };

  if (args.dryRun) {
    // A dry run writes NO case results. If an output directory was supplied it
    // receives the plan document only; cases/ is never created or touched.
    let planPath = null;
    if (outputDir) {
      runnerState.ensureDir(outputDir);
      planPath = path.join(outputDir, 'dry-run-plan.json');
      fs.writeFileSync(planPath, `${JSON.stringify(planDocument, null, 2)}\n`, 'utf8');
    }
    const summary = {
      ok: blocked.length === 0,
      mode: 'dry_run',
      runId: identity.runId,
      split: args.split,
      caseCount: validated.cases.length,
      selectedCaseCount: selection.toProcess.length,
      plannedCallCount,
      executedCallCount: budget.executed,
      // Counted, not asserted: in dry run the executor is never reached, so these
      // read zero because nothing happened rather than because a comment says so.
      actualProviderCallCount: account.counters.providerAttempts,
      fallbackAttemptCount: account.counters.fallbackAttempts,
      retryCount: account.counters.retries,
      unexpectedNetworkAttemptCount: account.counters.unexpectedNetworkAttempts,
      adapterInvoked: false,
      costUsd: '0.00',
      costProjection,
      capturePreparation: planDocument.capturePreparation,
      blockedCaseCount: blocked.length,
      blocked,
      planPath,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (blocked.length > 0) process.exitCode = 1;
    return { ...summary, planDocument, budget, account };
  }

  if (blocked.length > 0) {
    const summary = {
      ok: false,
      mode: 'execute',
      stage: 'preflight',
      selectedCaseCount: selection.toProcess.length,
      blockedCaseCount: blocked.length,
      blocked,
      plannedCallCount,
      executedCallCount: 0,
      message: 'execution refused because one or more governed cases failed preflight',
    };
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return summary;
  }

  // ── Execution path ─────────────────────────────────────────────────────────
  const report = build4Funnel.executeGovernedRun({
    manifest,
    manifestSha256,
    selectionArtifact,
    cases: selection.toProcess,
    plans,
    outputRoot: outputDir,
    storageRoot: process.env.KSCAN_EVAL_STORAGE_ROOT,
    runIdentityRecord: identity,
    pricing,
    spendCeilingUsd: args.maxUsd,
    attemptCeiling: args.maxCalls,
    countTokens,
    executeAdapter: ({ caseRecord, call, runIdentityRecord }) => {
      const plan = plans.find((candidate) => candidate.caseId === caseRecord.caseId);
      return executor({ ...plan, calls: [call] }, caseRecord, { runIdentityRecord });
    },
    resume: args.resume,
  });

  report.ok = report.refusedCaseIds.length === 0 && report.completedCaseCount === plans.length;
  report.mode = 'execute';
  report.runIdentity = identity;
  report.split = args.split;
  report.caseDenominator = plans.length;
  report.skippedAlreadyComplete = selection.skipped;
  report.costProjection = costProjection;
  report.capturePreparation = planDocument.capturePreparation;
  report.holdoutSeal = planDocument.holdoutSeal;
  report.measurementLimits = planDocument.measurementLimits;
  console.log(JSON.stringify({
    ok: report.ok,
    runId: report.runId,
    completedCaseCount: report.completedCaseCount,
    generationAttempts: report.reservation.totalGenerateAttempts,
    totalAccountedUsd: report.reservation.totalAccountedUsd,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
  preflightCase,
  planCase,
  unauthorizedExecutor,
  validateExperimentRecord,
  capturePreparation,
  costLedger,
  runIdentity,
  providerAccounting,
};
