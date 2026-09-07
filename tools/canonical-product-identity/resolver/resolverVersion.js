'use strict';

const RESOLVER_VERSION = 'cpil-resolver-v1';
const NORMALIZATION_VERSION = 'cpil-normalization-v1';

/**
 * Default operating parameters (spec section 26: "the agent does not choose
 * a production threshold"). `tier2AutoMergeThreshold: Infinity` means Tier 2
 * NEVER auto-merges by default - the only default-eligible auto-merge path
 * is Tier 1 (validated strong identifiers). The operating-curve sweep
 * (evaluator/operatingCurve.js) is the only place this threshold is varied.
 */
const DEFAULT_OPERATING_PARAMETERS = Object.freeze({
  tier2AutoMergeThreshold: Infinity,
});

module.exports = { RESOLVER_VERSION, NORMALIZATION_VERSION, DEFAULT_OPERATING_PARAMETERS };
