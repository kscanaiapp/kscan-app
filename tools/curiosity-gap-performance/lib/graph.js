'use strict';
/**
 * Dependency graph + critical path.
 *
 * Deliberately small (§17). This is NOT a distributed-systems simulator: there
 * are no worker pools, no schedulers, no event bus. It is a pure evaluator over
 * a DAG of stages, which is exactly enough to answer the two questions this
 * lane exists for:
 *
 *   FIRST-RESULT CRITICAL PATH    — what must complete before the customer has
 *                                   one actionable commerce result
 *   COMPLETE-RESPONSE CRITICAL PATH — what must complete before the whole
 *                                   operation ends
 *
 * These are two independent traversals over the same graph, because in K Scan
 * they are genuinely different paths: under the v127 funnel the scan response
 * does not wait on providers at all, so a stage can be on the completion path
 * and off the first-result path (or vice versa).
 *
 * A stage:
 *   { id, deps: [ids], duration: {evidence_class, ...}, optional, blocks_first_result }
 *
 * Timing semantics:
 *   start(s)  = max(finish(d) for d in deps)   — a stage waits for ALL deps
 *   finish(s) = start(s) + effective_duration(s)
 * Concurrency is therefore implicit: two stages sharing a dep and not depending
 * on each other run in parallel by construction. A serial chain is expressed by
 * making each stage depend on the previous one. A blocking fan-in is a stage
 * that depends on every child.
 */

const { assertEvidenceClass, combineEvidence } = require('./evidence');

class GraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GraphError';
  }
}

function validateStage(stage, index) {
  if (!stage || typeof stage !== 'object') {
    throw new GraphError(`stage[${index}] must be an object`);
  }
  if (typeof stage.id !== 'string' || stage.id.trim() === '') {
    throw new GraphError(`stage[${index}] requires a non-empty string id`);
  }
  if (!Array.isArray(stage.deps)) {
    throw new GraphError(`stage "${stage.id}" requires a deps array (use [] for a root)`);
  }
  assertEvidenceClass(stage.evidence_class, `stage "${stage.id}"`);
  if (typeof stage.blocks_first_result !== 'boolean' && stage.blocks_first_result !== 'UNKNOWN') {
    throw new GraphError(
      `stage "${stage.id}" requires blocks_first_result of true|false|"UNKNOWN" — ` +
        'guessing is not permitted, record UNKNOWN instead',
    );
  }
}

/**
 * Structural validation. Rejects the three failure modes that would otherwise
 * produce a confident-looking wrong critical path: unknown deps, duplicate
 * ids, and cycles ("impossible dependency").
 */
function validateGraph(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new GraphError('graph requires a non-empty stages array');
  }
  const byId = new Map();
  stages.forEach((s, i) => {
    validateStage(s, i);
    if (byId.has(s.id)) throw new GraphError(`duplicate stage id "${s.id}"`);
    byId.set(s.id, s);
  });
  for (const s of stages) {
    for (const dep of s.deps) {
      if (!byId.has(dep)) {
        throw new GraphError(`stage "${s.id}" depends on unknown stage "${dep}"`);
      }
      if (dep === s.id) throw new GraphError(`stage "${s.id}" depends on itself`);
    }
  }
  // Cycle detection (iterative DFS; the graph is small but recursion on a cycle
  // would blow the stack before reporting the useful error).
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(stages.map((s) => [s.id, WHITE]));
  for (const root of stages) {
    if (color.get(root.id) !== WHITE) continue;
    const stack = [{ id: root.id, i: 0 }];
    color.set(root.id, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const deps = byId.get(frame.id).deps;
      if (frame.i >= deps.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const next = deps[frame.i++];
      const c = color.get(next);
      if (c === GREY) {
        throw new GraphError(
          `impossible dependency: cycle detected involving "${frame.id}" -> "${next}"`,
        );
      }
      if (c === WHITE) {
        color.set(next, GREY);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  return byId;
}

/** Kahn topological order; the graph is already proven acyclic by validateGraph. */
function topoOrder(stages, byId) {
  const indegree = new Map(stages.map((s) => [s.id, s.deps.length]));
  const dependents = new Map(stages.map((s) => [s.id, []]));
  for (const s of stages) for (const d of s.deps) dependents.get(d).push(s.id);

  const queue = stages.filter((s) => s.deps.length === 0).map((s) => s.id).sort();
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const dep of dependents.get(id)) {
      indegree.set(dep, indegree.get(dep) - 1);
      if (indegree.get(dep) === 0) queue.push(dep);
    }
    queue.sort();
  }
  if (order.length !== stages.length) throw new GraphError('graph is not a DAG');
  return order.map((id) => byId.get(id));
}

/**
 * Evaluate stage start/finish times.
 *
 * `durationOf(stage)` returns { ms, evidence_class }. It is injected rather
 * than read off the stage so the same graph can be evaluated under different
 * sweep points without mutating it.
 */
function evaluate(stages, durationOf) {
  const byId = validateGraph(stages);
  const ordered = topoOrder(stages, byId);
  const times = new Map();

  for (const stage of ordered) {
    let start = 0;
    let startedBy = null;
    for (const dep of stage.deps) {
      const depFinish = times.get(dep).finish;
      if (depFinish > start || startedBy === null) {
        if (depFinish >= start) {
          start = depFinish;
          startedBy = dep;
        }
      }
    }
    const d = durationOf(stage);
    if (typeof d.ms !== 'number' || !Number.isFinite(d.ms)) {
      throw new GraphError(`stage "${stage.id}" produced a non-finite duration`);
    }
    if (d.ms < 0) {
      throw new GraphError(`stage "${stage.id}" produced a negative duration (${d.ms}ms)`);
    }
    assertEvidenceClass(d.evidence_class, `duration of "${stage.id}"`);
    times.set(stage.id, {
      id: stage.id,
      start,
      duration: d.ms,
      finish: start + d.ms,
      started_by: startedBy,
      evidence_class: d.evidence_class,
    });
  }
  return { byId, ordered, times };
}

/**
 * Walk backwards from a terminal stage through `started_by` to recover the
 * chain of stages that actually determined its finish time. That chain — not
 * the set of all stages — is the critical path.
 */
function criticalPathTo(times, terminalId) {
  if (!times.has(terminalId)) throw new GraphError(`unknown terminal stage "${terminalId}"`);
  const chain = [];
  let cursor = terminalId;
  const guard = new Set();
  while (cursor) {
    if (guard.has(cursor)) throw new GraphError('critical path walk revisited a stage');
    guard.add(cursor);
    const t = times.get(cursor);
    chain.unshift(t);
    cursor = t.started_by;
  }
  return chain;
}

/**
 * The two paths this lane exists to distinguish.
 *
 * `firstResultTerminal` is the stage at which the customer has one actionable
 * commerce result. `completionTerminal` is the stage at which the whole
 * operation ends. They are supplied by the scenario, never inferred, because
 * inferring them is exactly the mistake that collapses TTFAR into total time.
 */
function analyze(stages, durationOf, { firstResultTerminal, completionTerminal }) {
  const { times, ordered } = evaluate(stages, durationOf);
  const firstResultChain = criticalPathTo(times, firstResultTerminal);
  const completionChain = criticalPathTo(times, completionTerminal);

  const chainEvidence = (chain) => combineEvidence(chain.map((t) => t.evidence_class));

  return {
    times,
    ordered: ordered.map((s) => s.id),
    first_result: {
      terminal: firstResultTerminal,
      total_ms: times.get(firstResultTerminal).finish,
      chain: firstResultChain.map((t) => t.id),
      chain_detail: firstResultChain,
      evidence_class: chainEvidence(firstResultChain),
    },
    complete_response: {
      terminal: completionTerminal,
      total_ms: times.get(completionTerminal).finish,
      chain: completionChain.map((t) => t.id),
      chain_detail: completionChain,
      evidence_class: chainEvidence(completionChain),
    },
  };
}

module.exports = { GraphError, validateGraph, topoOrder, evaluate, criticalPathTo, analyze };
