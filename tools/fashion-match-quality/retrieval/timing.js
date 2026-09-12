'use strict';

/**
 * Timing instrumentation (spec section 16).
 *
 * These are R&D SANDBOX timings only - CPU-only, single-process, running
 * the harness stub embedder unless a real FashionCLIP is available (see
 * buildIndex.js) - and must never be presented as mobile production
 * Curiosity Gap timing (tools/curiosity-gap-performance/), which measures a
 * materially different thing under a materially different execution
 * environment. `recordEnvironment()` exists specifically so every timing
 * artifact self-documents that distinction rather than relying on a reader
 * to remember it.
 */

const os = require('node:os');

function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAscending.length) - 1;
  return sortedAscending[Math.max(0, Math.min(sortedAscending.length - 1, rank))];
}

/** @param {number[]} samplesMs @returns {{n:number, p50:number|null, p95:number|null, max:number|null}} */
function summarize(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

function recordEnvironment() {
  const cpus = os.cpus() || [];
  return {
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    note:
      'R&D sandbox timing, CPU-only, single process. Not mobile production timing and not comparable to ' +
      'tools/curiosity-gap-performance/ reports without saying so explicitly (spec section 16).',
  };
}

module.exports = { summarize, recordEnvironment, percentile };
