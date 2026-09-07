'use strict';

/**
 * The holdout seal (mission section 21, design DM-03).
 *
 *   "HOLDOUT EVALUATION IS EXPLICIT-INVOCATION ONLY. Default (development
 *    evaluation, CI, routine sweeps, experiments) must NOT reveal holdout
 *    results. Holdout must be mechanically sealed. Holdout invocation must be
 *    recorded. A routine test run must not leak holdout failures into everyday
 *    engineering knowledge."
 *
 * A deterministic hash split - which is what the inherited FMQL loader does -
 * prevents accidental REASSIGNMENT. It does not prevent accidental READING:
 * any caller holding the returned array can score the holdout partition and
 * learn from it. So the seal here is three independent conditions, all
 * required:
 *
 *   1. PHYSICAL SEPARATION. Holdout cases live in corpus/holdout/. The default
 *      loader reads corpus/cases/ and never touches it.
 *   2. EXPLICIT INVOCATION. openHoldout() throws HOLDOUT_SEALED unless the
 *      caller supplies a reason and an invokedBy AND the environment carries
 *      the unseal token. Nothing in this repository sets that token.
 *   3. RECORDED INVOCATION. The audit record is written BEFORE the cases are
 *      returned. A failed write aborts the unseal - the log is a precondition
 *      of access, not a side effect of it.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { PATHS } = require('./paths');
const { validateCase } = require('./recordSchema');
const { loadCorpusConfig } = require('./corpusStore');

const UNSEAL_ENV_VAR = 'KSCAN_RFC_HOLDOUT_UNSEAL';
const UNSEAL_TOKEN = 'I_UNDERSTAND_THIS_IS_RECORDED';

class HoldoutSealedError extends Error {
  constructor(reasons) {
    super(
      `HOLDOUT_SEALED: the holdout evaluation set is sealed and was not opened.\n` +
        reasons.map((r) => `  - ${r}`).join('\n') +
        `\n\nThis is deliberate (mission section 21). Opening the holdout requires all of:\n` +
        `  1. a non-empty reason describing why holdout evidence is needed\n` +
        `  2. a non-empty invokedBy naming who is asking\n` +
        `  3. ${UNSEAL_ENV_VAR}=${UNSEAL_TOKEN} in the environment\n` +
        `Every successful unseal is recorded in ${path.relative(PATHS.repoRoot, PATHS.holdoutInvocationLog)}.`,
    );
    this.name = 'HoldoutSealedError';
    this.code = 'HOLDOUT_SEALED';
    this.reasons = reasons;
  }
}

/**
 * Deterministic partition assignment, anchored on the GARMENT (design DM-03).
 *
 * Anchoring on the case would let one capture of a product sit in development
 * while another sits in holdout - and the development twin would leak the
 * holdout answer, since both share one ground-truth record. Anchoring on the
 * garment makes that impossible by construction, and also keeps an iOS/Android
 * pair together for free.
 *
 * Stable under corpus growth: adding a garment never reassigns another.
 */
function assignPartition(garmentId, holdoutFraction) {
  const digest = crypto.createHash('sha256').update(String(garmentId)).digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff;
  return bucket < holdoutFraction ? 'holdout' : 'development';
}

function partitionPlan(garmentIds, holdoutFraction) {
  const plan = new Map();
  for (const garmentId of garmentIds) plan.set(garmentId, assignPartition(garmentId, holdoutFraction));
  return plan;
}

/** How many holdout cases exist. A count leaks nothing; contents would. */
function holdoutCaseCount() {
  if (!fs.existsSync(PATHS.holdout)) return 0;
  return fs.readdirSync(PATHS.holdout).filter((name) => name.endsWith('.json')).length;
}

function readInvocationLog(logPath = PATHS.holdoutInvocationLog) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { malformed: line };
      }
    });
}

/**
 * Open the sealed holdout evaluation set.
 *
 * Throws HoldoutSealedError unless every condition is met. On success, writes
 * the audit record FIRST, then returns the cases.
 *
 * Options exist for `env` and `logPath` so the invariant suite can prove the
 * seal without setting a real environment variable or writing to the real log
 * - a test that had to set the unseal token globally would be exactly the
 * "routine test run leaks holdout" failure section 21 forbids.
 */
function openHoldout({ reason, invokedBy, env = process.env, logPath = PATHS.holdoutInvocationLog } = {}) {
  const reasons = [];
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    reasons.push('no reason was given');
  }
  if (typeof invokedBy !== 'string' || invokedBy.trim().length === 0) {
    reasons.push('no invokedBy was given');
  }
  if (env[UNSEAL_ENV_VAR] !== UNSEAL_TOKEN) {
    reasons.push(`${UNSEAL_ENV_VAR} is not set to the unseal token`);
  }
  if (reasons.length > 0) throw new HoldoutSealedError(reasons);

  const cases = [];
  const errors = [];
  if (fs.existsSync(PATHS.holdout)) {
    for (const name of fs.readdirSync(PATHS.holdout).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(PATHS.holdout, name);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = validateCase(record);
      if (!result.valid) {
        for (const message of result.errors) errors.push({ file, caseId: record.caseId, message });
        continue;
      }
      cases.push(record);
    }
  }

  const config = loadCorpusConfig();
  const auditRecord = {
    unsealedAt: new Date().toISOString(),
    reason: reason.trim(),
    invokedBy: invokedBy.trim(),
    caseCount: cases.length,
    corpusVersion: config.corpusVersion,
    unsealEnvVar: UNSEAL_ENV_VAR,
  };

  // The audit record is a PRECONDITION of access, not a side effect. If it
  // cannot be written, the holdout does not open.
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(auditRecord)}\n`, 'utf8');
  } catch (err) {
    throw new Error(
      `HOLDOUT_AUDIT_WRITE_FAILED: the holdout was NOT opened because its invocation could not be recorded ` +
        `at ${logPath}: ${err.message}`,
    );
  }

  return { cases, errors, auditRecord, holdoutStatus: 'UNSEALED_EXPLICIT' };
}

module.exports = {
  UNSEAL_ENV_VAR,
  UNSEAL_TOKEN,
  HoldoutSealedError,
  assignPartition,
  partitionPlan,
  holdoutCaseCount,
  openHoldout,
  readInvocationLog,
};
