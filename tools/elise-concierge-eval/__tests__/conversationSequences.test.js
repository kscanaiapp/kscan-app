'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateConversationSequences,
  loadSequences,
  DIMENSION_OF,
  SUBJECTIVE_DIMENSIONS,
} = require('../conversation/conversationEvaluator');

test('conversation sequences: every deterministic contract passes against the real frame', async () => {
  const report = await evaluateConversationSequences();
  const failures = report.results
    .filter((r) => !r.deterministic.pass)
    .map((r) => `${r.id}: ${JSON.stringify(r.deterministic.checks.filter((c) => !c.pass))}`);
  assert.deepEqual(failures, []);
  assert.equal(report.sequenceCount, loadSequences().sequences.length);
  assert.equal(report.liveModelCalls, 0);
  assert.equal(report.networkCalls, 0);
});

test('conversation sequences: all twenty journeys are represented', () => {
  const journeys = new Set(loadSequences().sequences.map((s) => s.journey));
  for (let j = 1; j <= 20; j += 1) assert.ok(journeys.has(j), `journey ${j}`);
});

test('conversation sequences: subjective quality is never scored as pass/fail', async () => {
  const report = await evaluateConversationSequences();
  for (const result of report.results) {
    for (const dimension of SUBJECTIVE_DIMENSIONS) {
      assert.equal(result.subjective[dimension], 'HUMAN_REVIEW', `${result.id}.${dimension}`);
    }
    for (const check of result.deterministic.checks) {
      assert.equal(SUBJECTIVE_DIMENSIONS.includes(check.dimension), false, check.key);
    }
  }
  // Every expectation key maps to a DETERMINISTIC dimension.
  for (const sequence of loadSequences().sequences) {
    for (const key of Object.keys(sequence.expect)) assert.ok(key in DIMENSION_OF, key);
  }
});

test('conversation sequences: NEGATIVE CONTROL — a wrong expectation is reported as a failure', async () => {
  const fixturePath = path.join(__dirname, '..', 'conversation', 'conversationSequences.json');
  const original = fs.readFileSync(fixturePath, 'utf8');
  const mutated = JSON.parse(original);
  // Claim the "No heels" reply is clean. The evaluator must refuse that.
  const target = mutated.sequences.find((s) => s.id === 'cq_16_contradiction_prevention');
  target.expect.violations = [];
  const { evaluateConversationSequences: evaluate } = require('../conversation/conversationEvaluator');
  // Evaluate the mutated set through the same code path, without touching disk.
  const originalRead = fs.readFileSync;
  fs.readFileSync = function patched(file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(fixturePath)) return JSON.stringify(mutated);
    return originalRead.call(fs, file, ...rest);
  };
  try {
    const report = await evaluate();
    const result = report.results.find((r) => r.id === 'cq_16_contradiction_prevention');
    assert.equal(result.deterministic.pass, false, 'the evaluator must be able to fail');
    assert.equal(report.deterministicFail, 1);
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(fs.readFileSync(fixturePath, 'utf8'), original, 'the committed fixture was never modified');
});

test('conversation sequences: fixtures are sanitized synthetic text', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'conversation', 'conversationSequences.json'), 'utf8');
  assert.equal(/@|https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw), false, 'no emails, URLs or identifiers');
});
