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
 *   node tools/scanner-evaluation/run-baseline.js --execute --resume --output-dir <dir> --max-calls 90
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { validateManifest } = require('./lib/datasetValidate');
const { scoreCaseAllProfiles, aggregateScores, SCORING_CONTRACT_VERSION } = require('./lib/scoreFields');
const { validateExperimentRecord } = require('./lib/experimentMeta');
const ontology = require('./lib/ontology');
const resultState = require('./lib/resultState');
const fallbackTracking = require('./lib/fallbackTracking');
const runnerState = require('./lib/runnerState');

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
      case '--max-calls': args.maxCalls = Number(next()); break;
      case '--manifest': args.manifest = next(); break;
      case '--help': args.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

// ── Pre-flight validation ────────────────────────────────────────────────────

function sha256OfFile(absolutePath) {
  const bytes = fs.readFileSync(absolutePath);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

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
function resolveImageRef(refValue) {
  if (!/^[a-z0-9+.-]+:\/\//i.test(refValue)) {
    return path.join(ROOT, refValue);
  }
  const root = process.env.KSCAN_EVAL_STORAGE_ROOT;
  if (!root) {
    throw new Error(
      `governed storage ref ${refValue} cannot be resolved: set KSCAN_EVAL_STORAGE_ROOT to the governed storage root`
    );
  }
  // storage://<bucket>/tier-a/<caseId>/<viewId>  ->  <root>/<caseId>/<viewId>.jpg
  const withoutScheme = refValue.replace(/^[a-z0-9+.-]+:\/\//i, '');
  const parts = withoutScheme.split('/').filter(Boolean);
  const tierIdx = parts.findIndex((p) => p === 'tier-a');
  const tail = tierIdx >= 0 ? parts.slice(tierIdx + 1) : parts.slice(1);
  const candidate = path.join(root, ...tail);
  // The manifest records the logical view name with no extension.
  if (fs.existsSync(candidate)) return candidate;
  for (const ext of ['.jpg', '.jpeg', '.png']) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  return candidate;
}

/**
 * Validate one governed case without calling anything.
 * Every check here is a gate: a case that fails is never executed.
 */
function preflightCase(caseRecord) {
  const findings = [];
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
    const actual = sha256OfFile(absolute);
    if (actual !== expected) {
      findings.push({
        severity: 'blocking',
        check: 'image_hash',
        message: `hash mismatch for ${ref.refValue}: manifest ${expected}, file ${actual}`,
      });
      return;
    }
    resolvedImages.push({ refValue: ref.refValue, refType: ref.refType, hash: actual, byteLength: fs.statSync(absolute).size });
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
  };
}

/**
 * Build the planned call graph. One production call per image, because the
 * deployed identification path accepts a single V2 evidence item.
 */
function planCase(caseRecord, preflight) {
  const calls = preflight.resolvedImages.map((image, index) => ({
    callIndex: index,
    caseId: caseRecord.caseId,
    evidenceSequenceIndex: index,
    imageRef: image.refValue,
    imageHash: image.hash,
    byteLength: image.byteLength,
    contractVersion: 'fashion-identification-v2',
    // Only intents, modes and privacy fields verified present in the source
    // contract are used. Nothing is invented.
    intent: 'identify_for_style',
    mode: 'identify_selected_item',
    privacy: { localFaceMaskApplied: false, localPlateMaskApplied: false, rawExifTransmitted: false },
    commerceExpected: false,
  }));

  return {
    caseId: caseRecord.caseId,
    imageCount: preflight.resolvedImages.length,
    multiImageSet: preflight.resolvedImages.length > 1,
    consolidatedCallEmitted: false,
    calls,
    plannedCallCount: calls.length,
    totalInputBytes: preflight.resolvedImages.reduce((sum, i) => sum + i.byteLength, 0),
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

function main(argv = process.argv.slice(2), { executor = unauthorizedExecutor, now = null } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('see file header for usage');
    return { ok: true, help: true };
  }

  const datasetVersion = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/dataset-version.json'), 'utf8')
  );
  const manifestPath = path.join(ROOT, args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validated = validateManifest(manifest, { expectedDatasetVersion: manifest.datasetVersion });
  if (!validated.ok) {
    console.error(JSON.stringify({ ok: false, stage: 'manifest', errors: validated.errors }, null, 2));
    process.exitCode = 1;
    return { ok: false, errors: validated.errors };
  }

  const outputDir = args.outputDir ? path.resolve(args.outputDir) : null;
  if (args.execute && !outputDir) throw new Error('--execute requires --output-dir');

  const selection = runnerState.selectCases(validated.cases, {
    outputDir: outputDir || path.join(ROOT, '.eval-noop'),
    resume: args.resume,
    startCase: args.startCase,
    caseId: args.caseId,
  });

  const budget = new runnerState.CallBudget(args.maxCalls == null ? Infinity : args.maxCalls);
  const preflights = [];
  const plans = [];
  const blocked = [];

  for (const caseRecord of selection.toProcess) {
    const preflight = preflightCase(caseRecord);
    preflights.push(preflight);
    if (!preflight.ok) {
      blocked.push({ caseId: caseRecord.caseId, findings: preflight.findings.filter((f) => f.severity === 'blocking') });
      continue;
    }
    const plan = planCase(caseRecord, preflight);
    budget.plan(plan.plannedCallCount);
    plans.push(plan);
  }

  const plannedCallCount = plans.reduce((sum, p) => sum + p.plannedCallCount, 0);
  const stamp = now || new Date().toISOString();

  const planDocument = {
    generatedAt: stamp,
    mode: args.dryRun ? 'dry_run' : 'execute',
    sourceSha: git(['rev-parse', 'HEAD']),
    datasetVersion: manifest.datasetVersion,
    datasetVersionFileVersion: datasetVersion.datasetVersion,
    manifest: args.manifest,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    ontologyVersions: ontology.ONTOLOGY_VERSIONS,
    resultStateMappingVersion: resultState.MAPPING_VERSION,
    caseCount: validated.cases.length,
    selectedCaseCount: selection.toProcess.length,
    skippedAlreadyComplete: selection.skipped,
    blockedCases: blocked,
    plannedCallCount,
    hardCallCeiling: budget.maxCalls === Infinity ? null : budget.maxCalls,
    totalInputBytes: plans.reduce((sum, p) => sum + p.totalInputBytes, 0),
    multiImageSetCount: plans.filter((p) => p.multiImageSet).length,
    plans,
    guarantees: {
      modelCallsExecuted: 0,
      networkCallsExecuted: 0,
      persistenceWritesExecuted: 0,
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
      caseCount: validated.cases.length,
      selectedCaseCount: selection.toProcess.length,
      plannedCallCount,
      executedCallCount: budget.executed,
      blockedCaseCount: blocked.length,
      blocked,
      planPath,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (blocked.length > 0) process.exitCode = 1;
    return { ...summary, planDocument, budget };
  }

  // ── Execution path ─────────────────────────────────────────────────────────
  const cancellation = runnerState.installCancellation();
  const events = [];
  const scored = [];
  let cancelledAt = null;
  let ceilingHit = false;

  try {
    runnerState.writeRunManifest(outputDir, {
      startedAt: stamp,
      datasetVersion: manifest.datasetVersion,
      scoringContractVersion: SCORING_CONTRACT_VERSION,
      ontologyVersions: ontology.ONTOLOGY_VERSIONS,
      hardCallCeiling: planDocument.hardCallCeiling,
      plannedCallCount,
      resume: args.resume,
    });

    for (const plan of plans) {
      if (cancellation.cancelled) {
        cancelledAt = plan.caseId;
        break;
      }
      const caseRecord = validated.cases.find((c) => c.caseId === plan.caseId);

      let perImageResults;
      try {
        budget.consume(plan.plannedCallCount);
        perImageResults = executor(plan, caseRecord);
      } catch (error) {
        if (error instanceof runnerState.CallCeilingExceeded) {
          ceilingHit = true;
          break;
        }
        runnerState.writeFailure(outputDir, plan.caseId, {
          caseId: plan.caseId,
          datasetVersion: manifest.datasetVersion,
          failedAt: stamp,
          error: String(error && error.message ? error.message : error),
        });
        continue;
      }

      for (const observation of perImageResults.observations || []) {
        events.push(fallbackTracking.recordFallbackEvent({ ...observation, caseId: plan.caseId }));
      }

      const profiles = scoreCaseAllProfiles(caseRecord, perImageResults.consolidated || {});
      const record = {
        caseId: plan.caseId,
        datasetVersion: manifest.datasetVersion,
        scoringContractVersion: SCORING_CONTRACT_VERSION,
        completedAt: stamp,
        callCount: plan.plannedCallCount,
        profiles,
        raw: perImageResults.raw || null,
      };
      runnerState.writeCaseResult(outputDir, plan.caseId, record);
      scored.push(profiles);
    }
  } finally {
    cancellation.dispose();
  }

  const durable = runnerState.loadAllResults(outputDir, manifest.datasetVersion);
  const neutral = durable.map((r) => r.profiles.neutral);
  const trust = durable.map((r) => r.profiles.trust_weighted);

  const report = {
    ok: true,
    mode: 'execute',
    datasetVersion: manifest.datasetVersion,
    completedCaseCount: durable.length,
    executedCallCount: budget.executed,
    hardCallCeiling: planDocument.hardCallCeiling,
    ceilingHit,
    cancelledAt,
    profiles: {
      neutral: fallbackTracking.buildDualPathReport(neutral, events, aggregateScores),
      trust_weighted: fallbackTracking.buildDualPathReport(trust, events, aggregateScores),
    },
  };
  const reportPath = path.join(outputDir, 'baseline-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, reportPath, completedCaseCount: durable.length, executedCallCount: budget.executed }, null, 2));
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

module.exports = { main, parseArgs, preflightCase, planCase, unauthorizedExecutor, validateExperimentRecord };
