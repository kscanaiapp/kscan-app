'use strict';

/**
 * Pure base-vs-head failure-set arithmetic (Staging Gate V2 spec, Section 4).
 *
 *   NEW_FAILURES       = HEAD - BASE
 *   RESOLVED_FAILURES  = BASE - HEAD
 *   UNCHANGED_FAILURES = BASE ∩ HEAD
 *
 * Policy: NEW_FAILURES.length > 0 -> BLOCK. Otherwise PASS (informationally
 * PASS_PRE_EXISTING_BASE_FAILURE when UNCHANGED_FAILURES is non-empty, so a
 * clean pass can still be told apart from a pass riding on inherited debt).
 */

function computeRegression(baseFailures, headFailures) {
  const base = new Set(baseFailures);
  const head = new Set(headFailures);

  const newFailures = [...head].filter((id) => !base.has(id)).sort();
  const resolvedFailures = [...base].filter((id) => !head.has(id)).sort();
  const unchangedFailures = [...head].filter((id) => base.has(id)).sort();

  const outcome = newFailures.length > 0
    ? 'BLOCK_NEW_REGRESSION'
    : unchangedFailures.length > 0
      ? 'PASS_PRE_EXISTING_BASE_FAILURE'
      : 'PASS';

  return { newFailures, resolvedFailures, unchangedFailures, outcome };
}

module.exports = { computeRegression };
