'use strict';

/**
 * Runner state, resumability and call accounting (Phase 0B section 4.11).
 *
 * DESIGN RULE: a completed case is durable the moment it completes. One result
 * file is written per case, immediately, before the next case starts. A run that
 * is cancelled, crashes, or hits the ceiling therefore loses at most the case in
 * flight — never the ones already paid for.
 *
 * RESUME RULE: resume reads the output directory, not a separate ledger that
 * could disagree with it. The files that exist ARE the record of what was paid
 * for. A case whose result file exists is never called again.
 */

const fs = require('fs');
const path = require('path');

const CASES_DIR = 'cases';
const RUN_MANIFEST = 'run-manifest.json';
const FAILURES_DIR = 'failures';

class CallCeilingExceeded extends Error {
  constructor(ceiling) {
    super(`hard call ceiling reached: ${ceiling}`);
    this.name = 'CallCeilingExceeded';
    this.ceiling = ceiling;
  }
}

class DuplicateOutput extends Error {
  constructor(caseId) {
    super(`result already exists for case ${caseId}; refusing to overwrite without --resume`);
    this.name = 'DuplicateOutput';
    this.caseId = caseId;
  }
}

/**
 * Counts model calls and enforces a hard ceiling.
 * In dry-run the executor is never invoked, so `executed` stays at 0 and the
 * dry-run test can assert that directly.
 */
class CallBudget {
  constructor(maxCalls) {
    this.maxCalls = Number.isFinite(maxCalls) && maxCalls >= 0 ? maxCalls : Infinity;
    this.planned = 0;
    this.executed = 0;
  }

  plan(count = 1) {
    this.planned += count;
    return this.planned;
  }

  /** Reserve a real call. Throws rather than silently exceeding the ceiling. */
  consume(count = 1) {
    if (this.executed + count > this.maxCalls) {
      throw new CallCeilingExceeded(this.maxCalls);
    }
    this.executed += count;
    return this.executed;
  }

  remaining() {
    return this.maxCalls === Infinity ? Infinity : Math.max(0, this.maxCalls - this.executed);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function caseResultPath(outputDir, caseId) {
  return path.join(outputDir, CASES_DIR, `${caseId}.json`);
}

function failurePath(outputDir, caseId) {
  return path.join(outputDir, FAILURES_DIR, `${caseId}.json`);
}

/** Case ids that already have a durable result in this output directory. */
function completedCaseIds(outputDir) {
  const dir = path.join(outputDir, CASES_DIR);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
  );
}

/** Failures are preserved, never deleted, and do NOT count as completed. */
function failedCaseIds(outputDir) {
  const dir = path.join(outputDir, FAILURES_DIR);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
  );
}

/**
 * Decide which cases this invocation should process.
 *
 * @param {Array<object>} cases ordered governed cases
 * @param {{ outputDir: string, resume: boolean, startCase?: string, caseId?: string }} options
 */
function selectCases(cases, options) {
  const { outputDir, resume } = options;
  let selected = cases.slice();

  if (options.caseId) {
    selected = selected.filter((c) => c.caseId === options.caseId);
    if (selected.length === 0) {
      throw new Error(`--case-id ${options.caseId} matched no governed case`);
    }
  }

  if (options.startCase) {
    const index = selected.findIndex((c) => c.caseId === options.startCase);
    if (index === -1) {
      throw new Error(`--start-case ${options.startCase} matched no governed case`);
    }
    selected = selected.slice(index);
  }

  const completed = completedCaseIds(outputDir);
  const skipped = [];

  if (resume) {
    const remaining = [];
    for (const c of selected) {
      if (completed.has(c.caseId)) skipped.push(c.caseId);
      else remaining.push(c);
    }
    return { toProcess: remaining, skipped, completedBefore: [...completed] };
  }

  // Not resuming: an existing result is a duplicate-output condition.
  for (const c of selected) {
    if (completed.has(c.caseId)) throw new DuplicateOutput(c.caseId);
  }
  return { toProcess: selected, skipped, completedBefore: [...completed] };
}

/** Write one case result durably, immediately after the case completes. */
function writeCaseResult(outputDir, caseId, payload, { allowOverwrite = false } = {}) {
  const target = caseResultPath(outputDir, caseId);
  if (!allowOverwrite && fs.existsSync(target)) throw new DuplicateOutput(caseId);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

/** Failures are preserved so a resume can distinguish "not tried" from "tried and failed". */
function writeFailure(outputDir, caseId, payload) {
  const target = failurePath(outputDir, caseId);
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

function readCaseResult(outputDir, caseId) {
  const target = caseResultPath(outputDir, caseId);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * Load every durable case result. Refuses to mix dataset versions, so a report
 * can never silently combine results from two datasets.
 */
function loadAllResults(outputDir, expectedDatasetVersion) {
  const ids = [...completedCaseIds(outputDir)].sort();
  const results = [];
  const versionMismatches = [];
  for (const id of ids) {
    const record = readCaseResult(outputDir, id);
    if (!record) continue;
    if (expectedDatasetVersion && record.datasetVersion !== expectedDatasetVersion) {
      versionMismatches.push({ caseId: id, found: record.datasetVersion, expected: expectedDatasetVersion });
      continue;
    }
    results.push(record);
  }
  if (versionMismatches.length) {
    const detail = versionMismatches.map((m) => `${m.caseId}:${m.found}`).join(', ');
    throw new Error(
      `output directory mixes dataset versions (expected ${expectedDatasetVersion}): ${detail}`
    );
  }
  return results;
}

function writeRunManifest(outputDir, manifest) {
  ensureDir(outputDir);
  const target = path.join(outputDir, RUN_MANIFEST);
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return target;
}

function readRunManifest(outputDir) {
  const target = path.join(outputDir, RUN_MANIFEST);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * Install a cancellation handler. Returns a token whose `cancelled` flag the
 * run loop checks between cases, so a Ctrl-C stops at a case boundary with
 * every completed case already durable.
 */
function installCancellation(signals = ['SIGINT', 'SIGTERM']) {
  const token = { cancelled: false, signal: null, dispose: () => {} };
  const handlers = [];
  for (const signal of signals) {
    const handler = () => {
      token.cancelled = true;
      token.signal = signal;
    };
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }
  token.dispose = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
  return token;
}

module.exports = {
  CASES_DIR,
  FAILURES_DIR,
  RUN_MANIFEST,
  CallBudget,
  CallCeilingExceeded,
  DuplicateOutput,
  ensureDir,
  caseResultPath,
  failurePath,
  completedCaseIds,
  failedCaseIds,
  selectCases,
  writeCaseResult,
  writeFailure,
  readCaseResult,
  loadAllResults,
  writeRunManifest,
  readRunManifest,
  installCancellation,
};
