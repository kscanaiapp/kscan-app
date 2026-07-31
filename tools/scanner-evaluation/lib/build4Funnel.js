'use strict';

/**
 * Canonical Build 4 execution funnel.
 *
 * This module connects the governed Path B selection, countTokens preflight,
 * reservation ledger, certified adapter report, taxonomy, schema validation,
 * scoring, durable private persistence, aggregation and resume semantics. The
 * provider transport and countTokens transport are injected; this file contains
 * no network client and cannot call a production endpoint or Supabase.
 */

const fs = require('fs');
const path = require('path');

const baselineInputSelection = require('./baselineInputSelection');
const candidateRegistry = require('./candidateRegistry');
const candidateValidation = require('./candidateValidation');
const liveAdapter = require('./liveAdapter');
const normalizedResultValidation = require('./normalizedResultValidation');
const preflightReservation = require('./preflightReservation');
const runnerState = require('./runnerState');
const scoringProjection = require('./scoringProjection');
const runIdentity = require('./runIdentity');
const taxonomy = require('./errorTaxonomy');
const { scoreCaseAllProfiles, aggregateScores } = require('./scoreFields');

const PRIMARY_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const PREFLIGHT_DIR = 'preflight';
const DISPATCH_DIR = 'dispatch';

function assertFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`${name} transport is required`);
}

function verifyPlan(plan, selected) {
  if (!plan || !Array.isArray(plan.calls) || plan.calls.length !== 1) {
    throw new Error(`case ${selected.caseId} must have exactly one planned scanner input`);
  }
  const call = plan.calls[0];
  if (call.imageRef !== selected.selectedRef || call.imageHash !== selected.selectedHash) {
    throw new Error(`case ${selected.caseId} plan differs from the frozen Path B selection`);
  }
  if (plan.consolidatedCallEmitted === true) {
    throw new Error(`case ${selected.caseId} may not use evaluation-only reconciliation`);
  }
  return call;
}

function normalizeTokenCount(result, model) {
  const normalized = Number.isInteger(result) ? { inputTokens: result } : result;
  if (!normalized || !Number.isInteger(normalized.inputTokens) || normalized.inputTokens < 0) {
    throw new Error(`countTokens did not return a non-negative integer for ${model}`);
  }
  return normalized;
}

/**
 * The candidate under execution.
 *
 * A run identity that names no candidate is the certified control. This is the
 * ONE place that default is applied, and it is applied to a RUN, never to a
 * request field — a caller still cannot select the candidate implicitly, because
 * naming a candidate requires putting it in the run identity, which is compared
 * on resume and embedded in the run id.
 */
function candidateVersionOf(identity) {
  const named = identity && identity.candidateVersion;
  if (named == null) return candidateRegistry.CONTROL_VERSION;
  // A named candidate must be a real one. An unrecognised string fails closed
  // rather than silently running the control under a candidate's name.
  return candidateRegistry.resolveCandidate(named).candidateVersion;
}

function countForModel({ countTokens, caseRecord, call, model, identity }) {
  const measured = normalizeTokenCount(countTokens({ caseRecord, call, model }), model);
  const requestIdentity = preflightReservation.exactRequestIdentity({
    model,
    serializedRequestPayload: measured.serializedRequestPayload,
    imageSha256: call.imageHash,
    systemInstructionSha256: measured.systemInstructionSha256,
    promptSha256: measured.promptSha256,
    toolDeclarationsSha256: measured.toolDeclarationsSha256,
    generationConfigSha256: measured.generationConfigSha256,
    certifiedSourceSha256: identity.certifiedSnapshotSha256,
    datasetVersion: identity.datasetVersion,
    selectionContractSha256: identity.selectionContractSha256,
    candidateVersion: candidateVersionOf(identity),
  });
  return { ...measured, requestIdentity };
}

function statePath(outputRoot, directory, caseId) {
  return path.join(outputRoot, directory, `${caseId}.json`);
}

function writeState(outputRoot, directory, caseId, value) {
  const target = statePath(outputRoot, directory, caseId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

function readState(outputRoot, directory, caseId) {
  const target = statePath(outputRoot, directory, caseId);
  return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
}

function restoreCompletedReservations({ outputRoot, completedRecords, identity, ledger }) {
  for (const record of completedRecords) {
    if (record.runId !== identity.runId) {
      throw new Error(`resume result identity differs for ${record.caseId}`);
    }
    const cached = readState(outputRoot, PREFLIGHT_DIR, record.caseId);
    if (!cached || cached.runId !== identity.runId) {
      throw new Error(`resume is missing the pinned countTokens state for ${record.caseId}`);
    }
    const reservation = ledger.reserveCase({
      caseId: record.caseId,
      primaryModel: PRIMARY_MODEL,
      fallbackModel: FALLBACK_MODEL,
      primaryInputTokens: cached.primary && cached.primary.inputTokens,
      fallbackInputTokens: cached.fallback && cached.fallback.inputTokens,
    });
    if (!reservation.authorized) {
      throw new Error(`resume reservation state is not admissible for ${record.caseId}: ${reservation.reason}`);
    }
    reconcileReservations(ledger, record.caseId, record.providerAttempts || []);
    ledger.countTokens.cacheHits += 2;
  }
}

function tokenCountsForCase({ outputRoot, countTokens, caseRecord, call, identity, ledger }) {
  const candidateVersion = candidateVersionOf(identity);
  const cached = readState(outputRoot, PREFLIGHT_DIR, caseRecord.caseId);
  if (cached) {
    if (
      cached.runId !== identity.runId
      || cached.imageSha256 !== call.imageHash
      || cached.selectionContractSha256 !== identity.selectionContractSha256
      || cached.datasetManifestSha256 !== identity.datasetManifestSha256
      || cached.certifiedSnapshotSha256 !== identity.certifiedSnapshotSha256
      || cached.modelConfigurationId !== identity.modelConfigurationId
      // Control and candidate share modelConfigurationId by design, so this is
      // the comparison that stops a candidate reading the control's cache.
      // A pre-Phase-2A cache file carries no candidateVersion and is normalised
      // to the control, which is what it was.
      || (cached.candidateVersion || candidateRegistry.CONTROL_VERSION) !== candidateVersion
    ) {
      throw new Error(`countTokens cache identity differs for ${caseRecord.caseId}`);
    }
    ledger.countTokens.cacheHits += 2;
    return { primary: cached.primary, fallback: cached.fallback };
  }

  ledger.countTokens.cacheMisses += 2;
  const primary = countForModel({ countTokens, caseRecord, call, model: PRIMARY_MODEL, identity });
  const fallback = countForModel({ countTokens, caseRecord, call, model: FALLBACK_MODEL, identity });
  ledger.countTokens.requests += (primary.requests || 1) + (fallback.requests || 1);
  ledger.countTokens.successes += 2;
  writeState(outputRoot, PREFLIGHT_DIR, caseRecord.caseId, {
    schemaVersion: '1.0.0',
    caseId: caseRecord.caseId,
    runId: identity.runId,
    imageSha256: call.imageHash,
    selectionContractSha256: identity.selectionContractSha256,
    datasetManifestSha256: identity.datasetManifestSha256,
    certifiedSnapshotSha256: identity.certifiedSnapshotSha256,
    modelConfigurationId: identity.modelConfigurationId,
    candidateVersion,
    primary: {
      inputTokens: primary.inputTokens,
      requestIdentity: primary.requestIdentity,
      requests: primary.requests || 1,
    },
    fallback: {
      inputTokens: fallback.inputTokens,
      requestIdentity: fallback.requestIdentity,
      requests: fallback.requests || 1,
    },
  });
  return { primary, fallback };
}

function reconcileReservations(ledger, caseId, attempts) {
  const roles = ['primary', 'fallback'];
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const attempt = attempts[index];
    if (!attempt) {
      ledger.release({ caseId, role });
      continue;
    }
    if (Number.isInteger(attempt.promptTokenCount) && Number.isInteger(attempt.candidatesTokenCount)) {
      ledger.confirmAttempt({
        caseId,
        role,
        promptTokenCount: attempt.promptTokenCount,
        candidatesTokenCount: attempt.candidatesTokenCount,
      });
    } else {
      ledger.retainUnknown({ caseId, role });
    }
  }
}

function terminalRecord({ caseRecord, report, runIdentityRecord, ledger, tokenCounts }) {
  let outcome = liveAdapter.classifyOutcome(report);
  let validation = null;
  let profiles = null;
  let projection = null;
  let candidateFindings = null;

  const candidateVersion = candidateVersionOf(runIdentityRecord);

  if (outcome.status === 'provider_success') {
    // The single schema boundary. Nothing reaches projection, candidate
    // post-validation or scoring until this has passed.
    validation = normalizedResultValidation.validateNormalizedResult(report.observed);
    if (!validation.ok) {
      outcome = { status: 'provider_output_invalid', retryable: false, stage: 'validation' };
    } else {
      // Report-only. Runs after the schema boundary, never mutates the observed
      // result, and never feeds the scorer — see lib/candidateValidation.js.
      candidateFindings = candidateValidation.findCandidateViolations(validation.value, { candidateVersion });
      projection = scoringProjection.projectV2ForScoring(validation.value, {
        schemaParseFailure: false,
        fallbackInvoked: Array.isArray(report.providerAttempts) && report.providerAttempts.length > 1,
      });
      profiles = scoreCaseAllProfiles(caseRecord, projection);
    }
  }

  const record = liveAdapter.buildCaseRecord({
    caseId: caseRecord.caseId,
    report,
    runIdentityRecord,
    outcome,
    attemptsUsed: Array.isArray(report.providerAttempts) ? report.providerAttempts.length : 0,
    costUsd: ledger.caseAccountedUsd(caseRecord.caseId),
  });
  return {
    ...record,
    scoreability: profiles ? 'scoreable' : 'not_scoreable',
    validation,
    // The projection the scorer actually consumed. Recorded so a comparison can
    // diff normalized fields without re-deriving them, and so a disputed score
    // can be traced to the exact input that produced it.
    projection,
    candidateFindings,
    profiles,
    countTokens: {
      primaryRequestIdentity: tokenCounts.primary.requestIdentity,
      fallbackRequestIdentity: tokenCounts.fallback.requestIdentity,
      primaryInputTokens: tokenCounts.primary.inputTokens,
      fallbackInputTokens: tokenCounts.fallback.inputTokens,
    },
  };
}

/**
 * Execute a governed case set synchronously through injected transports.
 *
 * Both injected transports may be deterministic mocks. Production execution is
 * impossible unless a caller explicitly supplies implementations.
 */
function executeGovernedRun({
  manifest,
  manifestSha256,
  selectionArtifact,
  cases,
  plans,
  outputRoot,
  storageRoot,
  runIdentityRecord,
  pricing,
  spendCeilingUsd,
  attemptCeiling,
  countTokens,
  executeAdapter,
  resume = false,
}) {
  assertFunction(countTokens, 'countTokens');
  assertFunction(executeAdapter, 'certified adapter');

  // Resolve the candidate ONCE, before anything is written. An unknown candidate
  // version must stop the run at the gate rather than after the first paid call.
  // Every record this run writes then quotes the resolved version, so a case
  // file, a token cache entry and the run manifest can never disagree about
  // which execution produced them.
  const candidateVersion = candidateVersionOf(runIdentityRecord);
  const resolvedIdentity = { ...runIdentityRecord, candidateVersion };

  const selectionCheck = baselineInputSelection.verifyArtifact(
    selectionArtifact,
    manifest,
    { manifestSha256 }
  );
  if (!selectionCheck.ok) {
    throw new Error(`selection artifact verification failed: ${selectionCheck.errors.map((e) => e.check).join(', ')}`);
  }
  if (resolvedIdentity.selectionContractSha256 !== selectionArtifact.selectionContractSha256) {
    throw new Error('run identity does not pin the verified selection contract');
  }

  const priorRunManifest = runnerState.readRunManifest(outputRoot);
  if (resume) runIdentity.assertResumable(priorRunManifest, resolvedIdentity);

  liveAdapter.verifyPrivateOutputRoot(outputRoot, { storageRoot });
  const selectedByCase = new Map(selectionArtifact.selections.map((entry) => [entry.caseId, entry]));
  const planByCase = new Map(plans.map((plan) => [plan.caseId, plan]));
  const selectedCases = runnerState.selectCases(cases, { outputDir: outputRoot, resume });
  const ledger = new preflightReservation.ReservationLedger({
    pricing,
    spendCeilingUsd,
    attemptCeiling,
  });

  const completedBefore = runnerState.loadAllResults(outputRoot, manifest.datasetVersion);
  const governedCaseIds = new Set(manifest.cases.map((caseRecord) => caseRecord.caseId));
  const foreignCompleted = completedBefore.find((record) => !governedCaseIds.has(record.caseId));
  if (foreignCompleted) {
    throw new Error(`private result is outside the governed manifest: ${foreignCompleted.caseId}`);
  }
  if (completedBefore.length > 0 && !resume) {
    throw new runnerState.DuplicateOutput(completedBefore[0].caseId);
  }
  if (resume) {
    restoreCompletedReservations({
      outputRoot,
      completedRecords: completedBefore,
      identity: resolvedIdentity,
      ledger,
    });
  }

  runnerState.writeRunManifest(outputRoot, {
    ...resolvedIdentity,
    selectionContractSha256: selectionArtifact.selectionContractSha256,
    startedAt: new Date().toISOString(),
    resume,
  });

  const refused = [];
  for (const caseRecord of selectedCases.toProcess) {
    const selected = selectedByCase.get(caseRecord.caseId);
    if (!selected) throw new Error(`no frozen input selection for ${caseRecord.caseId}`);
    const call = verifyPlan(planByCase.get(caseRecord.caseId), selected);
    const priorDispatch = readState(outputRoot, DISPATCH_DIR, caseRecord.caseId);
    if (priorDispatch && priorDispatch.terminal !== true) {
      runnerState.writeFailure(outputRoot, caseRecord.caseId, {
        schemaVersion: '1.0.0',
        caseId: caseRecord.caseId,
        runId: resolvedIdentity.runId,
        status: 'adapter_internal_error',
        failureStage: 'resume',
        retryable: false,
        providerRequests: 'unknown',
        message: 'prior dispatch has no terminal record; automatic redispatch refused to prevent duplicate paid work',
      });
      refused.push(caseRecord.caseId);
      break;
    }

    let tokenCounts;
    try {
      tokenCounts = tokenCountsForCase({
        outputRoot,
        countTokens,
        caseRecord,
        call,
        identity: resolvedIdentity,
        ledger,
      });
    } catch (error) {
      ledger.countTokens.failures += 1;
      runnerState.writeFailure(outputRoot, caseRecord.caseId, {
        schemaVersion: '1.0.0',
        caseId: caseRecord.caseId,
        runId: resolvedIdentity.runId,
        status: 'adapter_internal_error',
        failureStage: 'count_tokens_preflight',
        retryable: false,
        providerRequests: 0,
        message: 'countTokens preflight failed; transport details intentionally omitted',
      });
      refused.push(caseRecord.caseId);
      break;
    }
    const { primary, fallback } = tokenCounts;

    const reservation = ledger.reserveCase({
      caseId: caseRecord.caseId,
      primaryModel: PRIMARY_MODEL,
      fallbackModel: FALLBACK_MODEL,
      primaryInputTokens: primary.inputTokens,
      fallbackInputTokens: fallback.inputTokens,
    });
    if (!reservation.authorized) {
      const status = reservation.reason === 'attempt_ceiling'
        ? 'attempt_ceiling'
        : reservation.reason === 'cost_ceiling'
          ? 'cost_ceiling'
          : 'adapter_internal_error';
      if (!taxonomy.isKnown(status)) throw new Error(`unknown refusal category ${status}`);
      runnerState.writeFailure(outputRoot, caseRecord.caseId, {
        schemaVersion: '1.0.0',
        caseId: caseRecord.caseId,
        runId: resolvedIdentity.runId,
        status,
        failureStage: 'preflight',
        retryable: false,
        providerRequests: 0,
      });
      refused.push(caseRecord.caseId);
      break;
    }

    let report;
    writeState(outputRoot, DISPATCH_DIR, caseRecord.caseId, {
      schemaVersion: '1.0.0',
      caseId: caseRecord.caseId,
      runId: resolvedIdentity.runId,
      terminal: false,
      note: 'Generation dispatch began. If no terminal record follows, automatic redispatch is forbidden.',
    });
    try {
      // The property name is part of the adapter contract and does not change.
      // Its VALUE now always carries a resolved candidateVersion, so an adapter
      // can route on it without re-deriving the default.
      report = executeAdapter({ caseRecord, call, runIdentityRecord: resolvedIdentity });
    } catch (error) {
      ledger.retainUnknown({ caseId: caseRecord.caseId, role: 'primary' });
      ledger.retainUnknown({ caseId: caseRecord.caseId, role: 'fallback' });
      report = {
        handlerError: error instanceof Error ? error.message : String(error),
        v2Present: false,
        observed: null,
        providerAttempts: [],
        counters: { unexpectedNetworkAttempts: 0 },
      };
    }
    if (!report || !Array.isArray(report.providerAttempts)) {
      throw new Error(`certified adapter returned an invalid report for ${caseRecord.caseId}`);
    }
    reconcileReservations(ledger, caseRecord.caseId, report.providerAttempts);
    const record = terminalRecord({
      caseRecord,
      report,
      runIdentityRecord: resolvedIdentity,
      ledger,
      tokenCounts: { primary, fallback },
    });
    runnerState.writeCaseResult(outputRoot, caseRecord.caseId, record);
    writeState(outputRoot, DISPATCH_DIR, caseRecord.caseId, {
      schemaVersion: '1.0.0',
      caseId: caseRecord.caseId,
      runId: resolvedIdentity.runId,
      terminal: true,
      status: record.status,
    });
  }

  const durable = runnerState.loadAllResults(outputRoot, manifest.datasetVersion);
  const scoreable = durable.filter((record) => record.scoreability === 'scoreable' && record.profiles);
  const report = {
    schemaVersion: '1.0.0',
    runId: resolvedIdentity.runId,
    datasetVersion: manifest.datasetVersion,
    selectionContractSha256: selectionArtifact.selectionContractSha256,
    completedCaseCount: durable.length,
    scoredCaseCount: scoreable.length,
    refusedCaseIds: refused,
    skippedAlreadyComplete: selectedCases.skipped,
    taxonomyVersion: taxonomy.TAXONOMY_VERSION,
    taxonomyHash: taxonomy.taxonomyHash(),
    reservation: ledger.totals(),
    profiles: {
      neutral: aggregateScores(scoreable.map((record) => record.profiles.neutral)),
      trust_weighted: aggregateScores(scoreable.map((record) => record.profiles.trust_weighted)),
    },
  };
  fs.writeFileSync(path.join(outputRoot, 'baseline-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

module.exports = {
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  candidateVersionOf,
  terminalRecord,
  verifyPlan,
  reconcileReservations,
  restoreCompletedReservations,
  tokenCountsForCase,
  executeGovernedRun,
};
