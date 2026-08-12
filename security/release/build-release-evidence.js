#!/usr/bin/env node
'use strict';

/**
 * Authoritative release-scoped evidence aggregator + STAGING_VERIFIED guard.
 *
 * ONE VERDICT. The existing staging certification stays the environment-level
 * authority and is consumed here as an INPUT; this module normalizes its
 * findings through security/release/staging-release-verification-policy.json
 * and emits the single release-scoped verdict. It does not re-run, re-derive,
 * or second-guess certification — duplicating that would recreate exactly the
 * competing-authority problem DEF-REL-006 removed.
 *
 * Fail-closed throughout: unclassified certification findings block, missing
 * required evidence blocks, and an environment finding may only be tolerated
 * where policy explicitly says so.
 *
 * Node built-ins only. Pure: no network, no deployment, no mutation.
 */

const fs = require('node:fs');
const path = require('node:path');

const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard.js');
const { RESULT: VERIFIER_RESULT } = require('./verify-exact-candidate.js');
const { stagingVerifiedDecision } = require('./verified-baseline.js');

const EVIDENCE_SCHEMA_VERSION = 1;

/** Canonical K Scan result semantics, reused rather than reinvented. */
const STATUS = Object.freeze({
  PASS: 'PASS',
  PASS_WITH_REPORT_ONLY_FINDINGS: 'PASS_WITH_REPORT_ONLY_FINDINGS',
  PENDING: 'PENDING',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  BLOCKED: 'BLOCKED',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
});

const DISPOSITION = Object.freeze({
  OWNER_EXTERNAL_ACTION_REQUIRED: 'OWNER_EXTERNAL_ACTION_REQUIRED',
  REQUIRES_CLASSIFICATION: 'REQUIRES_CLASSIFICATION',
  GOVERNED_BY_EXISTING_POLICY: 'GOVERNED_BY_EXISTING_POLICY',
});

function loadPolicy(repoRoot) {
  return JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'security', 'release', 'staging-release-verification-policy.json'),
    'utf8',
  ));
}

/**
 * Maps raw certification findings onto release-scoped dispositions.
 * Anything absent from the policy inherits the fail-closed default.
 */
function normalizeCertification({ certification, policy }) {
  if (!certification) {
    return {
      available: false,
      rawVerdict: null,
      normalizedFindings: [],
      operationalFailures: [{
        id: 'staging_certification',
        detail: 'certification evidence was not supplied to the aggregator',
      }],
    };
  }

  const normalizedFindings = [];
  const seen = new Set();

  const classify = (id, origin) => {
    if (seen.has(id)) return;
    seen.add(id);
    const known = policy.findings[id];
    const mapped = known || policy.defaultForUnclassifiedFinding;
    normalizedFindings.push({
      id,
      origin,
      scope: mapped.scope,
      disposition: mapped.disposition,
      releaseContentBlocking: mapped.releaseContentBlocking,
      stagingVerifiedBlocking: mapped.stagingVerifiedBlocking,
      productionPromotionBlocking: mapped.productionPromotionBlocking,
      classified: Boolean(known),
      rationale: mapped.rationale || null,
    });
  };

  for (const id of certification.blocking_findings || []) classify(id, 'blocking_findings');
  for (const id of certification.report_only_findings || []) classify(id, 'report_only_findings');

  // Certification operational failures are evidence-production problems, kept
  // distinct from security findings so an outage is never read as a defect.
  const operationalFailures = (certification.operational_failures || []).map((id) => ({
    id,
    detail: 'certification reported an operational failure for this control',
  }));

  return {
    available: true,
    rawVerdict: certification.final_verdict || null,
    normalizedFindings,
    operationalFailures,
  };
}

/** Reduces a control-result map to required-control failures. */
function evaluateRequiredControls({ controls, policy }) {
  const required = policy.requiredReleaseControls || [];
  const blocked = [];
  const operational = [];
  const missing = [];

  for (const id of required) {
    const result = controls[id];
    if (result === undefined || result === null) {
      missing.push({ id, detail: 'required release control produced no result' });
      continue;
    }
    const status = typeof result === 'string' ? result : result.status;
    if (status === STATUS.BLOCKED) {
      blocked.push({ id, detail: (result && result.detail) || 'required control blocked' });
    } else if (status === STATUS.OPERATIONAL_FAILURE) {
      operational.push({ id, detail: (result && result.detail) || 'required control could not produce evidence' });
    } else if (status === STATUS.NOT_APPLICABLE) {
      // A control on the required list cannot be waived by declaring it N/A.
      blocked.push({ id, detail: 'required control reported NOT_APPLICABLE; required controls may not be waived this way' });
    }
  }

  return { blocked, operational, missing };
}

/**
 * Builds the authoritative release evidence object.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object} opts.release            - {releaseId, sourceSha, sourceTreeSha, manifestDigest}
 * @param {object} opts.deployment         - finalized deployment receipt (or summary)
 * @param {object} opts.exactCandidateVerification - verifyExactCandidate() output
 * @param {object} opts.health             - {live, ready, version} statuses
 * @param {object} opts.smoke              - {categoryId: {status, detail}}
 * @param {object|null} opts.certification - raw staging certification report
 * @param {object} [opts.controls]         - explicit control-result overrides
 * @param {object} [opts.productionEligibility] - production-eligibility.js output
 */
function buildReleaseEvidence(opts) {
  const {
    repoRoot,
    release,
    deployment = null,
    exactCandidateVerification = null,
    health = {},
    smoke = {},
    certification = null,
    controls: controlOverrides = {},
    productionEligibility = null,
  } = opts || {};

  const policy = loadPolicy(repoRoot);
  const cert = normalizeCertification({ certification, policy });

  // Assemble the control-result map the required-control check reads.
  const exactStatus = (() => {
    if (!exactCandidateVerification) return { status: STATUS.OPERATIONAL_FAILURE, detail: 'exact-candidate verification did not run' };
    switch (exactCandidateVerification.result) {
      case VERIFIER_RESULT.PASS:
        return { status: STATUS.PASS };
      case VERIFIER_RESULT.BLOCKED:
        return { status: STATUS.BLOCKED, detail: 'exact-candidate verification found an identity mismatch' };
      case VERIFIER_RESULT.FULL_RUNTIME_ATTESTATION_GAP:
        // A disclosed attestation gap is not a pass and not a mismatch. It is
        // an evidence limitation, so it lands as OPERATIONAL_FAILURE and blocks
        // STAGING_VERIFIED until a verified baseline exists to carry forward.
        return { status: STATUS.OPERATIONAL_FAILURE, detail: 'FULL_RUNTIME_ATTESTATION_GAP: no prior verified baseline covers every governed component' };
      default:
        return { status: STATUS.OPERATIONAL_FAILURE, detail: 'exact-candidate verification could not complete' };
    }
  })();

  const controls = {
    freeze_valid: controlOverrides.freeze_valid || { status: STATUS.PENDING },
    candidate_binding: controlOverrides.candidate_binding || { status: STATUS.PENDING },
    deployment_receipt: controlOverrides.deployment_receipt
      || (deployment ? { status: deployment.status === 'PASS' ? STATUS.PASS : STATUS.BLOCKED } : { status: STATUS.OPERATIONAL_FAILURE, detail: 'no deployment receipt' }),
    exact_candidate_verification: controlOverrides.exact_candidate_verification || exactStatus,
    health_live: controlOverrides.health_live || health.live || { status: STATUS.OPERATIONAL_FAILURE, detail: 'liveness not probed' },
    health_ready: controlOverrides.health_ready || health.ready || { status: STATUS.OPERATIONAL_FAILURE, detail: 'readiness not probed' },
    version_identity: controlOverrides.version_identity || health.version || { status: STATUS.OPERATIONAL_FAILURE, detail: 'version identity not probed' },
    ...Object.fromEntries(Object.entries(smoke).map(([id, value]) => [id, value])),
    ...controlOverrides,
  };

  const requiredResult = evaluateRequiredControls({ controls, policy });

  // Split normalized certification findings by their release-scoped effect.
  const releaseContentBlockers = cert.normalizedFindings
    .filter((f) => f.releaseContentBlocking)
    .map((f) => ({ id: f.id, scope: f.scope, disposition: f.disposition, classified: f.classified }));

  const stagingBlockingFindings = cert.normalizedFindings.filter((f) => f.stagingVerifiedBlocking);

  const environmentExternalActions = cert.normalizedFindings
    .filter((f) => f.disposition === DISPOSITION.OWNER_EXTERNAL_ACTION_REQUIRED)
    .map((f) => ({ id: f.id, scope: f.scope, ownerAction: (policy.findings[f.id] || {}).ownerAction || null }));

  const operationalFailures = [
    ...requiredResult.operational,
    ...requiredResult.missing,
    ...cert.operationalFailures,
  ];

  const blockers = [
    ...requiredResult.blocked,
    ...releaseContentBlockers.map((f) => ({ id: f.id, detail: `release-content blocking certification finding (${f.disposition})` })),
    ...stagingBlockingFindings
      .filter((f) => !f.releaseContentBlocking)
      .map((f) => ({ id: f.id, detail: `finding blocks STAGING_VERIFIED per policy (${f.disposition})` })),
  ];

  const reportOnly = cert.normalizedFindings.filter(
    (f) => !f.releaseContentBlocking && !f.stagingVerifiedBlocking,
  );

  let releaseCandidateVerdict;
  if (blockers.length > 0) {
    releaseCandidateVerdict = STATUS.BLOCKED;
  } else if (operationalFailures.length > 0) {
    releaseCandidateVerdict = STATUS.OPERATIONAL_FAILURE;
  } else if (Object.values(controls).some((c) => (typeof c === 'string' ? c : c.status) === STATUS.PENDING)) {
    releaseCandidateVerdict = STATUS.PENDING;
  } else if (reportOnly.length > 0) {
    releaseCandidateVerdict = STATUS.PASS_WITH_REPORT_ONLY_FINDINGS;
  } else {
    releaseCandidateVerdict = STATUS.PASS;
  }

  const stagingVerifiedEligible = releaseCandidateVerdict === STATUS.PASS
    || releaseCandidateVerdict === STATUS.PASS_WITH_REPORT_ONLY_FINDINGS;

  const evidence = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    policyVersion: policy.policyVersion,
    release: {
      releaseId: release ? release.releaseId : null,
      sourceSha: release ? release.sourceSha : null,
      sourceTreeSha: release ? release.sourceTreeSha : null,
      manifestDigest: release ? release.manifestDigest : null,
    },
    deployment: deployment
      ? {
        deploymentRunId: deployment.deploymentRunId,
        deploymentAttempt: deployment.deploymentAttempt,
        status: deployment.status,
        receiptDigest: deployment.receiptDigest || null,
        functionsDeployed: deployment.functionsDeployed || [],
        migrationsApplied: deployment.migrationsApplied || [],
      }
      : null,
    exactCandidateVerification: exactCandidateVerification
      ? {
        result: exactCandidateVerification.result,
        components: exactCandidateVerification.components,
        limitations: exactCandidateVerification.limitations,
      }
      : null,
    health,
    smoke,
    certification: {
      available: cert.available,
      sourceRunId: certification ? (certification.run_id || certification.sourceRunId || null) : null,
      rawVerdict: cert.rawVerdict,
      normalizedFindings: cert.normalizedFindings,
    },
    operationalFailures,
    releaseContentBlockers,
    environmentExternalActions,
    blockers,
    releaseCandidateVerdict,
    stagingVerifiedEligible,
    // Deliberately independent: STAGING_VERIFIED never implies production
    // eligibility. This field mirrors production-eligibility.js and defaults
    // to false when it was not evaluated.
    productionPromotionEligible: productionEligibility ? Boolean(productionEligibility.productionPromotionEligible) : false,
    productionBlockers: productionEligibility ? (productionEligibility.blockers || []).map((b) => b.code) : ['NOT_EVALUATED'],
  };

  assertNoEmbeddedSecret(evidence, 'releaseEvidence');
  return evidence;
}

/**
 * STAGING_VERIFIED legitimacy guard.
 *
 * Pure: it decides whether the STAGING_DEPLOYED -> STAGING_VERIFIED transition
 * is permitted. It never performs the transition, and it never consults
 * production eligibility — the two gates are deliberately separate.
 *
 * The implementation lives in security/release/verified-baseline.js so that
 * baseline minting and this guard cannot drift apart: minting requires this
 * exact decision to have allowed the transition, and two copies of the
 * predicate would eventually disagree (cf. DEF-REL-006).
 */
const canEnterStagingVerified = stagingVerifiedDecision;

module.exports = {
  EVIDENCE_SCHEMA_VERSION,
  STATUS,
  DISPOSITION,
  loadPolicy,
  normalizeCertification,
  evaluateRequiredControls,
  buildReleaseEvidence,
  canEnterStagingVerified,
};
