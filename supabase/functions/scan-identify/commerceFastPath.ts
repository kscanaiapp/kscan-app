/**
 * Bounded fast-commerce collection (v127).
 *
 * Phase 3 ran discovery as `Promise.all` against one 4.5s deadline, which means
 * the fan-out always cost the slowest provider. That is correct for
 * completeness and wrong for first paint: the user is looking at a finished
 * scan result with an empty shelf while a straggler decides.
 *
 * This module supplies the two behaviors first paint needs — return as soon as
 * the answer is good enough, and never lose a fast provider's work to a slow
 * one — without changing what any provider returns or how results are ranked.
 */

import {
  FAST_COMMERCE_POLL_INTERVAL_MS,
} from './commerceFunnelConfig.ts';

export type BoundedTask<T> = {
  /** Stable identifier used for per-provider telemetry. */
  key: string;
  promise: Promise<T>;
  /** Value recorded when this task misses the deadline. Never an error path. */
  onTimeout: T;
};

export type BoundedOutcome<T> = {
  /** Every task's value: real when it settled in time, `onTimeout` otherwise. */
  values: Map<string, T>;
  /** Tasks that settled inside the budget, in settle order. */
  settledKeys: string[];
  /** Tasks that did not settle in time — dropped, not awaited. */
  timedOutKeys: string[];
  /** Per-task duration for tasks that settled. */
  durationsMs: Map<string, number>;
  /** True when the collector returned on sufficiency rather than the deadline. */
  earlyExit: boolean;
  elapsedMs: number;
};

/**
 * Run tasks concurrently and stop waiting at the first of:
 *   1. every task settled,
 *   2. `isSufficient` accepts what has settled so far, or
 *   3. the deadline elapses.
 *
 * Unsettled tasks are recorded as their `onTimeout` value. Their promises are
 * left to settle on their own — this returns early, it does not cancel — so a
 * straggler can never erase a fast provider's already-collected result.
 *
 * A rejected task is treated exactly like a timeout: commerce degrades to
 * "no result from that provider", never to a failed scan.
 */
export async function collectBounded<T>(
  tasks: BoundedTask<T>[],
  opts: {
    deadlineMs: number;
    /** Given the values that have settled so far, is the shelf good enough? */
    isSufficient?: (settled: T[]) => boolean;
    /** Injectable clock for deterministic tests. */
    now?: () => number;
  },
): Promise<BoundedOutcome<T>> {
  const now = opts.now ?? (() => Date.now());
  const started = now();

  const values = new Map<string, T>();
  const settledKeys: string[] = [];
  const durationsMs = new Map<string, number>();
  let earlyExit = false;

  if (tasks.length === 0) {
    return {
      values,
      settledKeys,
      timedOutKeys: [],
      durationsMs,
      earlyExit: false,
      elapsedMs: 0,
    };
  }

  let resolveGate: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    resolveGate();
  };

  const settledValues: T[] = [];
  const record = (task: BoundedTask<T>, value: T) => {
    if (values.has(task.key)) return;
    values.set(task.key, value);
    settledKeys.push(task.key);
    durationsMs.set(task.key, Math.max(0, now() - started));
    settledValues.push(value);

    if (settledKeys.length === tasks.length) {
      close();
      return;
    }
    if (opts.isSufficient && opts.isSufficient(settledValues)) {
      earlyExit = true;
      close();
    }
  };

  for (const task of tasks) {
    task.promise.then(
      (value) => record(task, value),
      // A provider that throws is a provider that returned nothing. It must not
      // propagate: commerce failure is never scan failure.
      () => record(task, task.onTimeout),
    );
  }

  const deadlineMs = Math.max(0, opts.deadlineMs);
  // Deliberately NOT unref'd. This timer is the only thing guaranteed to close
  // the gate when every provider hangs, so unref'ing it lets the runtime decide
  // the event loop is idle while we are still waiting on the deadline.
  const timer = setTimeout(close, deadlineMs);

  // Yield so that already-resolved promises can record before the first check,
  // which keeps a fully-cached fan-out from paying a poll interval.
  await Promise.resolve();
  await gate;
  clearTimeout(timer);

  const timedOutKeys: string[] = [];
  for (const task of tasks) {
    if (values.has(task.key)) continue;
    values.set(task.key, task.onTimeout);
    timedOutKeys.push(task.key);
  }

  return {
    values,
    settledKeys,
    timedOutKeys,
    durationsMs,
    earlyExit,
    elapsedMs: Math.max(0, now() - started),
  };
}

/** Exported for tests that assert the poll constant is actually wired. */
export const FAST_PATH_POLL_INTERVAL_MS = FAST_COMMERCE_POLL_INTERVAL_MS;
