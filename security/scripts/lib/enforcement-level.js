'use strict';

/**
 * Determines which of the three staging-gate enforcement levels (Staging
 * Gate V2 spec, Section 3) a given CI trigger context falls under, and
 * which of the existing required-check names are actually applicable for a
 * NORMAL_PR-level run given classify-changed-surfaces.js's classification
 * output.
 *
 * This module never adds, removes, or renames a required-check name
 * (Section 13) — deriveRequiredChecks only tags each existing name REQUIRED
 * or NOT_APPLICABLE. It mirrors, rather than replaces, the workflow YAML
 * `if:` conditions that actually decide whether a job runs; a NOT_APPLICABLE
 * check must still exist as a `skipped` check-run, exactly as
 * DEPLOYMENT_REQUIRED_CHECKS already documents in evaluate-promotion-gate.js.
 */

const STAGING_BRANCH = 'staging/production-parity';
// The repo's own existing branch-naming convention (confirmed by 20+ live
// integration/* branches) — used instead of a hardcoded Build-34-only list
// so this doesn't need editing every integration cycle.
const INTEGRATION_BRANCH_PATTERN = /^integration\//;

class EnforcementLevelError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EnforcementLevelError';
    this.code = code;
  }
}

function normalizeBranchRef(ref) {
  if (typeof ref !== 'string') return null;
  const trimmed = ref.trim();
  return trimmed ? trimmed.replace(/^refs\/heads\//, '') : null;
}

function isDocsOnly(classification) {
  const tags = (classification && classification.classifications) || [];
  return tags.length === 1 && tags[0] === 'DOCUMENTATION ONLY';
}

/**
 * Checks whose NOT_APPLICABLE-ness is already (or, per this change's
 * security-staging-gate.yml edit, will be) reflected by a real `if:`
 * condition in the workflows themselves. Deliberately narrow: 'Project
 * checks' / 'Gitleaks' / 'Semgrep Community Edition' / 'OSV-Scanner' /
 * 'Trivy filesystem' / 'npm audit' are NEVER downgraded by classification —
 * a docs-only diff can still leak a secret or break a shared test helper,
 * and Section 3's hard-stop list ("new secret exposure") applies at every
 * level regardless of changed surface.
 */
const CLASSIFICATION_GATED_CHECKS = {
  'Migration validation': (c) => c.migrationValidationRequired === true,
  'Contract tests': (c) => !isDocsOnly(c),
  'Staging health checks': (c) => c.backendDeploymentRequired === true,
  'Synthetic auth tests': (c) => c.backendDeploymentRequired === true,
  'ZAP Baseline (staging)': (c) => c.backendDeploymentRequired === true,
  'ZAP API staging': (c) => c.backendDeploymentRequired === true,
};

/**
 * @param {{eventName: string, ref?: string, baseRef?: string, isDispatch?: boolean, candidateSha?: string}} context
 * @returns {'NORMAL_PR'|'INTEGRATION'|'RELEASE_PROMOTION'}
 */
function determineEnforcementLevel({ eventName, ref, baseRef, isDispatch, candidateSha } = {}) {
  if (typeof eventName !== 'string' || !eventName) {
    throw new EnforcementLevelError('missing event name', 'MISSING_EVENT_NAME');
  }

  const normalizedRef = normalizeBranchRef(ref);
  const normalizedBaseRef = normalizeBranchRef(baseRef);

  // A push that lands directly on staging/production-parity, or an explicit
  // manual dispatch naming a candidate SHA to certify, IS the promotion
  // event itself.
  if (eventName === 'push' && normalizedRef === STAGING_BRANCH) {
    return 'RELEASE_PROMOTION';
  }
  if ((eventName === 'workflow_dispatch' || isDispatch === true) && candidateSha) {
    return 'RELEASE_PROMOTION';
  }

  // Anything targeting an integration/* branch, or staging/production-parity
  // itself pre-merge (a PR into it), must already be absolute-green before
  // it lands there — downgrading that to base-relative would just move the
  // "ordinary PR blocked by inherited failure" problem one branch over.
  const targetRef = eventName === 'pull_request' ? normalizedBaseRef : normalizedRef;
  if (targetRef && (INTEGRATION_BRANCH_PATTERN.test(targetRef) || targetRef === STAGING_BRANCH)) {
    return 'INTEGRATION';
  }

  return 'NORMAL_PR';
}

/**
 * @param {string[]} checkNames the full ground-truth list, e.g.
 *   [...ALWAYS_REQUIRED_CHECKS, ...DEPLOYMENT_REQUIRED_CHECKS]
 * @param {object} classification classify-changed-surfaces.js's output
 * @param {'NORMAL_PR'|'INTEGRATION'|'RELEASE_PROMOTION'} enforcementLevel
 * @returns {{name: string, applicability: 'REQUIRED'|'NOT_APPLICABLE'}[]}
 */
function deriveRequiredChecks({ checkNames, classification, enforcementLevel }) {
  if (!Array.isArray(checkNames)) {
    throw new EnforcementLevelError('checkNames must be an array', 'MISSING_CHECK_NAMES');
  }

  return checkNames.map((name) => {
    if (enforcementLevel !== 'NORMAL_PR') {
      return { name, applicability: 'REQUIRED' };
    }
    const gate = CLASSIFICATION_GATED_CHECKS[name];
    const applicable = gate ? gate(classification || {}) : true;
    return { name, applicability: applicable ? 'REQUIRED' : 'NOT_APPLICABLE' };
  });
}

module.exports = {
  STAGING_BRANCH,
  INTEGRATION_BRANCH_PATTERN,
  EnforcementLevelError,
  determineEnforcementLevel,
  deriveRequiredChecks,
  isDocsOnly,
};
