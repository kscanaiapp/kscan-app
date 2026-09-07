'use strict';
/**
 * Curiosity Gap Performance Lab — graph and critical-path contract.
 *
 * These tests exist to stop the lab producing a confident wrong answer. The
 * failure modes they guard are the ones that would look like a working model:
 * a cycle silently resolving, a negative duration, a critical path that names
 * the wrong chain, or the two paths collapsing into one.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LAB = path.join(__dirname, '..', '..', 'tools', 'curiosity-gap-performance');
const { validateGraph, analyze, GraphError } = require(path.join(LAB, 'lib', 'graph'));
const { combineEvidence, fact, assertNotPresentedAsMeasurement } = require(path.join(LAB, 'lib', 'evidence'));
const { sumBackoff, resolveDuration, ModelError } = require(path.join(LAB, 'lib', 'model'));

const proven = (id, deps, blocks = true) => ({ id, deps, evidence_class: 'PROVEN', blocks_first_result: blocks });
const ms = (n) => () => ({ ms: n, evidence_class: 'PROVEN' });

test('a valid graph is accepted', () => {
  assert.ok(validateGraph([proven('a', []), proven('b', ['a'])]));
});

test('an impossible dependency (cycle) is rejected', () => {
  assert.throws(
    () => validateGraph([proven('a', ['b']), proven('b', ['a'])]),
    (err) => err instanceof GraphError && /impossible dependency|cycle/i.test(err.message),
  );
});

test('a self-dependency is rejected', () => {
  assert.throws(() => validateGraph([proven('a', ['a'])]), GraphError);
});

test('an unknown dependency is rejected', () => {
  assert.throws(() => validateGraph([proven('a', ['ghost'])]), /unknown stage "ghost"/);
});

test('a duplicate stage id is rejected', () => {
  assert.throws(() => validateGraph([proven('a', []), proven('a', [])]), /duplicate stage id/);
});

test('a stage that guesses blocks_first_result is rejected', () => {
  assert.throws(
    () => validateGraph([{ id: 'a', deps: [], evidence_class: 'PROVEN', blocks_first_result: 'maybe' }]),
    /blocks_first_result/,
  );
});

test('a negative duration is rejected rather than silently clamped', () => {
  const stages = [proven('a', [])];
  assert.throws(
    () => analyze(stages, () => ({ ms: -5, evidence_class: 'PROVEN' }), { firstResultTerminal: 'a', completionTerminal: 'a' }),
    /negative duration/,
  );
});

test('a non-finite duration is rejected', () => {
  assert.throws(
    () => analyze([proven('a', [])], () => ({ ms: Infinity, evidence_class: 'PROVEN' }), { firstResultTerminal: 'a', completionTerminal: 'a' }),
    /non-finite/,
  );
});

test('a serial chain sums, and its critical path names every link', () => {
  const stages = [proven('a', []), proven('b', ['a']), proven('c', ['b'])];
  const r = analyze(stages, ms(100), { firstResultTerminal: 'c', completionTerminal: 'c' });
  assert.strictEqual(r.first_result.total_ms, 300);
  assert.deepStrictEqual(r.first_result.chain, ['a', 'b', 'c']);
});

test('parallel siblings do not sum — the graph models concurrency by construction', () => {
  const stages = [proven('root', []), proven('p1', ['root']), proven('p2', ['root']), proven('join', ['p1', 'p2'])];
  const durations = { root: 10, p1: 100, p2: 250, join: 5 };
  const r = analyze(stages, (s) => ({ ms: durations[s.id], evidence_class: 'PROVEN' }),
    { firstResultTerminal: 'join', completionTerminal: 'join' });
  // 10 + max(100,250) + 5 — not 10+100+250+5
  assert.strictEqual(r.first_result.total_ms, 265);
});

test('a blocking fan-in is gated by its slowest child, and the path names that child', () => {
  const stages = [proven('root', []), proven('fast', ['root']), proven('slow', ['root']), proven('join', ['fast', 'slow'])];
  const durations = { root: 0, fast: 50, slow: 900, join: 0 };
  const r = analyze(stages, (s) => ({ ms: durations[s.id], evidence_class: 'PROVEN' }),
    { firstResultTerminal: 'join', completionTerminal: 'join' });
  assert.strictEqual(r.first_result.total_ms, 900);
  assert.ok(r.first_result.chain.includes('slow'), 'the slowest child must appear on the critical path');
  assert.ok(!r.first_result.chain.includes('fast'), 'the fast child must not');
});

test('the first-result and complete-response paths are computed independently', () => {
  // first result at `early`; completion continues through `late`.
  const stages = [proven('root', []), proven('early', ['root']), proven('late', ['early'], false)];
  const durations = { root: 100, early: 200, late: 5000 };
  const r = analyze(stages, (s) => ({ ms: durations[s.id], evidence_class: 'PROVEN' }),
    { firstResultTerminal: 'early', completionTerminal: 'late' });
  assert.strictEqual(r.first_result.total_ms, 300);
  assert.strictEqual(r.complete_response.total_ms, 5300);
  assert.notDeepStrictEqual(r.first_result.chain, r.complete_response.chain);
});

test('an unknown terminal is rejected', () => {
  assert.throws(
    () => analyze([proven('a', [])], ms(1), { firstResultTerminal: 'nope', completionTerminal: 'a' }),
    /unknown terminal stage/,
  );
});

// ── Evidence discipline ─────────────────────────────────────────────────────

test('PROVEN and MODELED cannot be silently merged — the weakest input wins', () => {
  assert.strictEqual(combineEvidence(['PROVEN', 'PROVEN']), 'PROVEN');
  assert.strictEqual(combineEvidence(['PROVEN', 'OBSERVED']), 'OBSERVED');
  assert.strictEqual(combineEvidence(['PROVEN', 'MODELED']), 'MODELED');
  assert.strictEqual(combineEvidence(['OBSERVED', 'MODELED']), 'MODELED');
});

test('a critical path containing one MODELED stage is reported as MODELED overall', () => {
  const stages = [
    { id: 'a', deps: [], evidence_class: 'PROVEN', blocks_first_result: true },
    { id: 'b', deps: ['a'], evidence_class: 'MODELED', blocks_first_result: true },
  ];
  const r = analyze(stages, (s) => ({ ms: 10, evidence_class: s.id === 'b' ? 'MODELED' : 'PROVEN' }),
    { firstResultTerminal: 'b', completionTerminal: 'b' });
  assert.strictEqual(r.first_result.evidence_class, 'MODELED');
});

test('an invalid evidence class is rejected', () => {
  assert.throws(() => combineEvidence(['GUESSED']), /evidence class must be one of/);
  assert.throws(() => combineEvidence([]), /non-empty array/);
});

test('OBSERVED and MODELED facts require provenance; a bare assertion is refused', () => {
  assert.throws(() => fact(900, 'MODELED'), /require a non-empty provenance/);
  assert.throws(() => fact(900, 'OBSERVED', '  '), /require a non-empty provenance/);
  assert.ok(fact(1900, 'PROVEN', 'commerceFunnelConfig.ts:45'));
});

test('a MODELED value may not be presented as a measurement', () => {
  assert.throws(() => assertNotPresentedAsMeasurement('MODELED', 'TTFAR'), /refusing to present a MODELED value/);
  assert.ok(assertNotPresentedAsMeasurement('OBSERVED', 'gemini elapsed'));
});

// ── Timeout and retry modelling ─────────────────────────────────────────────

test('a timeout clamps the stage and marks the outcome, rather than reporting the raw time', () => {
  const stage = { id: 's', deps: [], evidence_class: 'MODELED', blocks_first_result: true,
    timeout_ms: 1900, duration: { kind: 'param', param: 'p' } };
  const d = resolveDuration(stage, { p: { value: 6000, evidence_class: 'MODELED' } }, {});
  assert.strictEqual(d.ms, 1900);
  assert.strictEqual(d.raw_ms, 6000);
  assert.strictEqual(d.outcome, 'timeout');
});

test('a stage inside its timeout is untouched', () => {
  const stage = { id: 's', deps: [], evidence_class: 'MODELED', blocks_first_result: true,
    timeout_ms: 1900, duration: { kind: 'param', param: 'p' } };
  const d = resolveDuration(stage, { p: { value: 1200, evidence_class: 'MODELED' } }, {});
  assert.strictEqual(d.ms, 1200);
  assert.strictEqual(d.outcome, 'ok');
});

test('retry cost is added before the timeout clamp, matching the shared AbortController', () => {
  // index.ts:2770 arms ONE AbortController for the whole attempt loop, so a
  // retry consumes the same budget rather than extending it.
  const stage = { id: 'gemini', deps: [], evidence_class: 'OBSERVED', blocks_first_result: true,
    timeout_ms: 14000, duration: { kind: 'param', param: 'gemini_ms' },
    retry: { max_attempts: 2, base_delay_ms: 250, max_delay_ms: 2000, failed_attempt_param: 'failed_ms' } };
  const params = {
    gemini_ms: { value: 6000, evidence_class: 'OBSERVED' },
    failed_ms: { value: 4000, evidence_class: 'MODELED' },
    retry_attempts_extra: 1,
  };
  const d = resolveDuration(stage, params, {});
  assert.strictEqual(d.raw_ms, 6000);
  assert.strictEqual(d.ms, 6000 + 4000 + 250, 'one failed attempt plus one backoff');
  assert.strictEqual(d.retry.extra_attempts, 1);
  assert.strictEqual(d.evidence_class, 'MODELED', 'a retried OBSERVED stage becomes MODELED');
});

test('retries can never push a stage past its timeout', () => {
  const stage = { id: 'gemini', deps: [], evidence_class: 'OBSERVED', blocks_first_result: true,
    timeout_ms: 14000, duration: { kind: 'param', param: 'g' },
    retry: { max_attempts: 2, base_delay_ms: 250, max_delay_ms: 2000, failed_attempt_param: 'f' } };
  const d = resolveDuration(stage, { g: { value: 12000 }, f: { value: 9000 }, retry_attempts_extra: 1 }, {});
  assert.strictEqual(d.ms, 14000);
  assert.strictEqual(d.outcome, 'timeout');
});

test('the retry ceiling is respected — a scanner request cannot have two extra attempts', () => {
  const stage = { id: 'g', deps: [], evidence_class: 'OBSERVED', blocks_first_result: true,
    duration: { kind: 'param', param: 'g' },
    retry: { max_attempts: 2, base_delay_ms: 250, max_delay_ms: 2000, failed_attempt_param: 'f' } };
  const d = resolveDuration(stage, { g: { value: 100 }, f: { value: 100 }, retry_attempts_extra: 5 }, {});
  assert.strictEqual(d.retry.extra_attempts, 1, 'SCANNER_MAX_ATTEMPTS=2 means at most one extra');
});

test('backoff is exponential and capped', () => {
  assert.strictEqual(sumBackoff(1, 250, 2000), 250);
  assert.strictEqual(sumBackoff(2, 250, 2000), 750);
  assert.strictEqual(sumBackoff(5, 250, 2000), 250 + 500 + 1000 + 2000 + 2000);
});

test('a missing parameter throws instead of defaulting to a guess', () => {
  const stage = { id: 's', deps: [], evidence_class: 'MODELED', blocks_first_result: true,
    duration: { kind: 'param', param: 'never_declared' } };
  assert.throws(() => resolveDuration(stage, {}, {}), ModelError);
  assert.throws(() => resolveDuration(stage, {}, {}), /assumptions register|does not supply/);
});

test('a proven no-op costs zero and stays PROVEN', () => {
  const stage = { id: 'sanitize', deps: [], evidence_class: 'PROVEN', blocks_first_result: true, duration: { kind: 'zero' } };
  const d = resolveDuration(stage, {}, {});
  assert.strictEqual(d.ms, 0);
  assert.strictEqual(d.evidence_class, 'PROVEN');
});

test('an early-exit fan-in closes on the Nth fastest child, not the slowest', () => {
  const stage = { id: 'discovery', deps: [], evidence_class: 'MODELED', blocks_first_result: true,
    duration: { kind: 'fanin', children: ['a', 'b'], sufficient_after_children: 1 } };
  const d = resolveDuration(stage, { a: { value: 900 }, b: { value: 13900 } }, {});
  assert.strictEqual(d.ms, 900, 'a 13.9s straggler cannot gate a group that already has enough');
});

test('a blocking fan-in is gated by the slowest child', () => {
  const stage = { id: 'discovery', deps: [], evidence_class: 'MODELED', blocks_first_result: true,
    duration: { kind: 'fanin', children: ['a', 'b'] } };
  const d = resolveDuration(stage, { a: { value: 900 }, b: { value: 2400 } }, {});
  assert.strictEqual(d.ms, 2400);
});

test('a serial fan-out sums its children rather than taking the max', () => {
  const stage = { id: 'legacy', deps: [], evidence_class: 'MODELED', blocks_first_result: true,
    duration: { kind: 'fanin', concurrent: false, children: ['a', 'b', 'c'] } };
  const d = resolveDuration(stage, { a: { value: 100 }, b: { value: 200 }, c: { value: 300 } }, {});
  assert.strictEqual(d.ms, 600);
});

test('an unknown duration kind is rejected', () => {
  const stage = { id: 's', deps: [], evidence_class: 'PROVEN', blocks_first_result: true, duration: { kind: 'vibes' } };
  assert.throws(() => resolveDuration(stage, {}, {}), /unknown duration kind/);
});
