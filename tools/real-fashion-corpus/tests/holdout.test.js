'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  openHoldout,
  assignPartition,
  partitionPlan,
  readInvocationLog,
  HoldoutSealedError,
  UNSEAL_ENV_VAR,
  UNSEAL_TOKEN,
} = require('../lib/holdout');
const { loadCorpus } = require('../lib/corpusStore');
const { PATHS } = require('../lib/paths');

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-holdout-'));
  return path.join(dir, 'HOLDOUT_INVOCATION_LOG.jsonl');
}

const UNSEALED_ENV = { [UNSEAL_ENV_VAR]: UNSEAL_TOKEN };

/* ------------------------------------------------------------------ *
 * Invariant 42.5 - holdout is excluded by default
 * ------------------------------------------------------------------ */

test('HOLDOUT: the default corpus load never returns a holdout case', () => {
  // The development loader reads corpus/cases/ and the holdout lives in
  // corpus/holdout/. There is no code path in which an ordinary load reaches it.
  const corpus = loadCorpus();
  assert.ok(Array.isArray(corpus.cases));
  for (const record of corpus.cases) {
    assert.notEqual(record.partition, 'holdout', `${record.caseId} leaked into the default load`);
  }
  // It still reports HOW MANY holdout cases exist. A count leaks nothing;
  // contents would.
  assert.equal(typeof corpus.holdoutCaseCount, 'number');
});

test('HOLDOUT: the development and holdout directories are physically separate', () => {
  assert.notEqual(PATHS.cases, PATHS.holdout);
  assert.ok(!PATHS.holdout.startsWith(PATHS.cases + path.sep));
});

/* ------------------------------------------------------------------ *
 * Invariant 42.6 - holdout requires explicit invocation
 * ------------------------------------------------------------------ */

test('HOLDOUT: opening with no arguments at all is refused', () => {
  assert.throws(() => openHoldout(), (err) => err.code === 'HOLDOUT_SEALED');
});

test('HOLDOUT: a reason and invokedBy without the environment token are NOT enough', () => {
  // This is the case that matters: a developer who read the code and passed
  // the obvious arguments still does not get the holdout by accident.
  assert.throws(
    () => openHoldout({ reason: 'curious', invokedBy: 'dev', env: {} }),
    (err) => {
      assert.ok(err instanceof HoldoutSealedError);
      assert.ok(err.reasons.some((r) => r.includes(UNSEAL_ENV_VAR)));
      return true;
    },
  );
});

test('HOLDOUT: the environment token alone, with no reason or invoker, is NOT enough', () => {
  assert.throws(
    () => openHoldout({ env: UNSEALED_ENV }),
    (err) => {
      assert.ok(err.reasons.some((r) => r.includes('no reason')));
      assert.ok(err.reasons.some((r) => r.includes('no invokedBy')));
      return true;
    },
  );
});

test('HOLDOUT: a blank-string reason does not satisfy the reason requirement', () => {
  assert.throws(
    () => openHoldout({ reason: '   ', invokedBy: 'dev', env: UNSEALED_ENV }),
    (err) => err.reasons.some((r) => r.includes('no reason')),
  );
});

test('HOLDOUT: a wrong token value is refused', () => {
  assert.throws(
    () => openHoldout({ reason: 'r', invokedBy: 'd', env: { [UNSEAL_ENV_VAR]: 'true' } }),
    (err) => err.code === 'HOLDOUT_SEALED',
  );
});

test('HOLDOUT: the refusal message tells the operator exactly what is required', () => {
  try {
    openHoldout({ env: {} });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /HOLDOUT_SEALED/);
    assert.match(err.message, /a non-empty reason/);
    assert.match(err.message, /a non-empty invokedBy/);
    assert.match(err.message, new RegExp(`${UNSEAL_ENV_VAR}=${UNSEAL_TOKEN}`));
    assert.match(err.message, /recorded in/);
  }
});

test('HOLDOUT: this repository sets the unseal token nowhere - the real environment is sealed', () => {
  // If this fails, a routine test run really could leak holdout results, which
  // is precisely what mission section 21 forbids.
  assert.notEqual(process.env[UNSEAL_ENV_VAR], UNSEAL_TOKEN);
  assert.throws(() => openHoldout({ reason: 'r', invokedBy: 'd' }), (err) => err.code === 'HOLDOUT_SEALED');
});

/* ------------------------------------------------------------------ *
 * Invocation is recorded
 * ------------------------------------------------------------------ */

test('HOLDOUT: a successful unseal writes an audit record before returning cases', () => {
  const logPath = tempLog();
  const result = openHoldout({
    reason: 'verifying the seal records its own use',
    invokedBy: 'invariant-suite',
    env: UNSEALED_ENV,
    logPath,
  });

  assert.equal(result.holdoutStatus, 'UNSEALED_EXPLICIT');
  const log = readInvocationLog(logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'verifying the seal records its own use');
  assert.equal(log[0].invokedBy, 'invariant-suite');
  assert.equal(log[0].caseCount, result.cases.length);
  assert.ok(log[0].unsealedAt, 'the audit record must carry a timestamp');
  assert.ok(log[0].corpusVersion, 'the audit record must bind the corpus version');
});

test('HOLDOUT: the audit log is append-only across invocations', () => {
  const logPath = tempLog();
  openHoldout({ reason: 'first', invokedBy: 'a', env: UNSEALED_ENV, logPath });
  openHoldout({ reason: 'second', invokedBy: 'b', env: UNSEALED_ENV, logPath });
  const log = readInvocationLog(logPath);
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((entry) => entry.reason), ['first', 'second']);
});

test('HOLDOUT: a refused open writes NO audit record', () => {
  const logPath = tempLog();
  assert.throws(() => openHoldout({ reason: 'x', invokedBy: 'y', env: {}, logPath }));
  assert.equal(fs.existsSync(logPath), false, 'a refused open must not leave an audit trace');
});

test('HOLDOUT: if the audit record cannot be written, the holdout does NOT open', () => {
  // The log is a precondition of access, not a side effect of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-holdout-blocked-'));
  const collidingPath = path.join(dir, 'log.jsonl');
  // Make the log path a DIRECTORY, so appendFileSync cannot write to it.
  fs.mkdirSync(collidingPath);

  assert.throws(
    () => openHoldout({ reason: 'r', invokedBy: 'd', env: UNSEALED_ENV, logPath: collidingPath }),
    (err) => {
      assert.match(err.message, /HOLDOUT_AUDIT_WRITE_FAILED/);
      assert.match(err.message, /was NOT opened/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Deterministic, garment-anchored partitioning
 * ------------------------------------------------------------------ */

test('PARTITION: assignment is deterministic for a given garment id', () => {
  const first = assignPartition('G042', 0.25);
  for (let i = 0; i < 10; i += 1) assert.equal(assignPartition('G042', 0.25), first);
});

test('PARTITION: every case of one garment lands in the same partition', () => {
  // Anchoring on the case would let a development capture leak the answer for
  // its holdout twin, since both share one ground-truth record.
  const cases = [
    { caseId: 'C0001', garmentId: 'G010' },
    { caseId: 'C0002', garmentId: 'G010' },
    { caseId: 'C0003', garmentId: 'G010' },
  ];
  const partitions = new Set(cases.map((c) => assignPartition(c.garmentId, 0.25)));
  assert.equal(partitions.size, 1);
});

test('PARTITION: adding a garment never reassigns an existing one', () => {
  const before = partitionPlan(['G001', 'G002', 'G003'], 0.25);
  const after = partitionPlan(['G001', 'G002', 'G003', 'G004', 'G005'], 0.25);
  for (const [id, partition] of before) assert.equal(after.get(id), partition, `${id} was reassigned`);
});

test('PARTITION: the split lands near the configured fraction over a realistic corpus size', () => {
  // Not a claim about any particular corpus - just that the hash bucket is not
  // degenerate, which a constant-returning implementation would be.
  const ids = Array.from({ length: 400 }, (_, i) => `G${String(i + 1).padStart(3, '0')}`);
  const plan = partitionPlan(ids, 0.25);
  const holdout = [...plan.values()].filter((p) => p === 'holdout').length;
  const fraction = holdout / ids.length;
  assert.ok(fraction > 0.18 && fraction < 0.32, `holdout fraction ${fraction} is implausible for a 0.25 target`);
});

test('PARTITION: a zero fraction puts nothing in holdout and a one fraction puts everything there', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `G${i}`);
  assert.equal([...partitionPlan(ids, 0).values()].every((p) => p === 'development'), true);
  assert.equal([...partitionPlan(ids, 1).values()].every((p) => p === 'holdout'), true);
});
