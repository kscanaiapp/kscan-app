'use strict';

/**
 * Structural validator for the visual re-ranking experiment report.
 *
 * Same posture as ../reportSchema.js: returns `{valid, errors}`, never throws,
 * and checks the SHAPE a report must have rather than whether its numbers are
 * right. It exists to make one specific class of dishonest report
 * STRUCTURALLY IMPOSSIBLE rather than merely discouraged.
 *
 * The invariants it enforces:
 *
 *  1. A conclusion that is a CLAIM ABOUT THE MODEL - `PROMISING_CONTINUE_R&D`
 *     or `NO_USEFUL_SIGNAL` - requires `REAL_FASHIONCLIP_EXECUTED === true`.
 *     Both sentences mean "we ran FashionCLIP and observed X". A run that
 *     never loaded the weights cannot honestly reach either, no matter how
 *     good its harness numbers look. Recorded in HYPOTHESIS.md before any
 *     result existed, enforced here so it cannot be quietly relaxed later.
 *
 *  2. `REAL_FASHIONCLIP_EXECUTED` may only be true when all five of its
 *     component observations are (spec section 6's "do not reduce real
 *     execution to one boolean").
 *
 *  3. The control and challenger universe hashes must match, and the report
 *     must say they were compared. A paired experiment over two different
 *     candidate sets is invalid (spec section 8).
 *
 *  4. Metrics attributed to a non-model provider must be labelled
 *     `MECHANISM_CHECK` and never `RETRIEVAL_QUALITY_EVIDENCE` (spec
 *     sections 4 and 13).
 */

const REQUIRED_TOP_LEVEL_FIELDS = [
  'reportVersion',
  'generatedAt',
  'conclusion',
  'executionIdentity',
  'candidateUniverse',
  'corpusCensus',
  'evaluatorStatus',
  'evidenceClass',
  'limitations',
];

const VALID_CONCLUSIONS = ['PROMISING_CONTINUE_R&D', 'NO_USEFUL_SIGNAL', 'INSUFFICIENT_EVIDENCE', 'ENVIRONMENT_BLOCKED'];

/** Conclusions that assert something about FashionCLIP itself. */
const MODEL_CLAIMING_CONCLUSIONS = ['PROMISING_CONTINUE_R&D', 'NO_USEFUL_SIGNAL'];

const VALID_EVIDENCE_CLASSES = ['RETRIEVAL_QUALITY_EVIDENCE', 'MECHANISM_CHECK', 'ENGINEERING_SIGNAL_NOT_DECISION_GRADE'];

const EXECUTION_IDENTITY_FLAGS = [
  'MODEL_WEIGHTS_LOADED',
  'MODEL_EMBEDDINGS_PRODUCED',
  'EMBEDDINGS_USED_IN_RERANK',
  'CACHE_REVISION_VALIDATED',
];

function validateRerankReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') {
    return { valid: false, errors: ['report must be a non-null object'] };
  }

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (report[field] === undefined) errors.push(`missing required field: ${field}`);
  }

  if (report.conclusion !== undefined && !VALID_CONCLUSIONS.includes(report.conclusion)) {
    errors.push(`conclusion must be one of ${VALID_CONCLUSIONS.join(', ')}, got ${JSON.stringify(report.conclusion)}`);
  }
  if (report.evidenceClass !== undefined && !VALID_EVIDENCE_CLASSES.includes(report.evidenceClass)) {
    errors.push(`evidenceClass must be one of ${VALID_EVIDENCE_CLASSES.join(', ')}, got ${JSON.stringify(report.evidenceClass)}`);
  }

  const identity = report.executionIdentity;
  if (identity && typeof identity === 'object') {
    // Invariant 2: the derived boolean must agree with its components.
    if (identity.REAL_FASHIONCLIP_EXECUTED === true) {
      for (const flag of EXECUTION_IDENTITY_FLAGS) {
        if (identity[flag] !== true) {
          errors.push(`REAL_FASHIONCLIP_EXECUTED is true but ${flag} is ${JSON.stringify(identity[flag])}`);
        }
      }
      if (!identity.RUN_ARTIFACT_MODEL_REVISION || !/^[0-9a-f]{40}$/.test(identity.RUN_ARTIFACT_MODEL_REVISION)) {
        errors.push(
          'REAL_FASHIONCLIP_EXECUTED is true but RUN_ARTIFACT_MODEL_REVISION is not an immutable 40-hex commit SHA: ' +
            JSON.stringify(identity.RUN_ARTIFACT_MODEL_REVISION),
        );
      }
    }

    // Invariant 1: no model claim without a model run.
    if (MODEL_CLAIMING_CONCLUSIONS.includes(report.conclusion) && identity.REAL_FASHIONCLIP_EXECUTED !== true) {
      errors.push(
        `conclusion '${report.conclusion}' is a claim about FashionCLIP, but REAL_FASHIONCLIP_EXECUTED is ` +
          `${JSON.stringify(identity.REAL_FASHIONCLIP_EXECUTED)}. Only INSUFFICIENT_EVIDENCE or ENVIRONMENT_BLOCKED are available without a real model run.`,
      );
    }

    // Invariant 4: a non-model provider cannot carry quality evidence.
    if (identity.REAL_FASHIONCLIP_EXECUTED !== true && report.evidenceClass === 'RETRIEVAL_QUALITY_EVIDENCE') {
      errors.push(
        'evidenceClass is RETRIEVAL_QUALITY_EVIDENCE but no real FashionCLIP execution is recorded - ' +
          'harness output may not be presented as retrieval-quality evidence.',
      );
    }
  }

  // Invariant 3: identical candidate universe.
  const universe = report.candidateUniverse;
  if (universe && typeof universe === 'object') {
    if (universe.CONTROL_UNIVERSE_HASH === undefined || universe.CHALLENGER_UNIVERSE_HASH === undefined) {
      errors.push('candidateUniverse must record both CONTROL_UNIVERSE_HASH and CHALLENGER_UNIVERSE_HASH');
    } else if (universe.CONTROL_UNIVERSE_HASH !== universe.CHALLENGER_UNIVERSE_HASH && universe.identical !== false) {
      errors.push('candidateUniverse hashes differ but `identical` does not record the mismatch - the comparison is invalid until repaired');
    }
  }

  if (Array.isArray(report.limitations) && report.limitations.length === 0) {
    errors.push('limitations must not be an empty list - every run in this lane has known limitations');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateRerankReport,
  REQUIRED_TOP_LEVEL_FIELDS,
  VALID_CONCLUSIONS,
  MODEL_CLAIMING_CONCLUSIONS,
  VALID_EVIDENCE_CLASSES,
  EXECUTION_IDENTITY_FLAGS,
};
