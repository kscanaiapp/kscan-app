#!/usr/bin/env node
'use strict';

/**
 * Verified baseline — the staging trust root (DEF-REL-009).
 *
 * A verified baseline is what lets a LATER release say "this governed
 * component is unchanged, so it is CARRIED_FORWARD_FROM_PREVIOUS_VERIFIED_STATE
 * instead of UNATTESTED". It is therefore a trust root, and minting one is the
 * single most security-sensitive operation in the release control plane.
 *
 * ─── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
 *
 * Phase 2B shipped a constructor equivalent to
 * `buildVerifiedState({ releaseId, manifest })`, which turned manifest-DECLARED
 * source hashes into a "previous verified state" with no proof the release had
 * ever been verified at all. That permitted provenance laundering:
 *
 *     run 1 -> FULL_RUNTIME_ATTESTATION_GAP, STAGING_VERIFIED = NO
 *           -> buildVerifiedState(manifest)                    <-- laundering
 *     run 2 -> unchanged components read as CARRIED_FORWARD
 *              from a release that was never verified
 *
 * A failed, blocked, pending, operational-failure or attestation-gap release
 * may NEVER become a trust root. Minting requires the complete evidence chain.
 *
 * ─── WHAT baselineDigest DOES AND DOES NOT PROVE (DEF-REL-010) ──────────────
 *
 * `baselineDigest` is an UNKEYED SHA-256 over the baseline's own content. It
 * proves the object is internally consistent — that nobody edited a field
 * without recomputing the checksum. It does NOT prove the object was ever
 * produced by `mintVerifiedBaseline`, and it does NOT prove it came from a
 * STAGING_VERIFIED release. Anyone can build a baseline-shaped object with
 * plausible identity and 64-hex component hashes and then compute a fresh,
 * perfectly valid digest over their fabrication.
 *
 *     baselineDigest  = INTEGRITY / CONSISTENCY
 *     NOT               AUTHENTICITY / PROVENANCE
 *
 * Provenance therefore comes from CORROBORATION, not from the checksum: a
 * baseline authorizes carry-forward only alongside the authoritative release
 * evidence it was minted from, and the two must agree on the evidence digest,
 * release id, source SHA, source tree, manifest digest, receipt digest and
 * component hashes. A standalone baseline JSON — however well-formed, however
 * correctly checksummed — authorizes nothing.
 *
 * Phase 2B deliberately introduces no HMAC key, signing key or PKI. That means
 * there is no cryptographic authenticity here, and this module does not claim
 * any. The operational provenance source remains the immutable CI release
 * evidence artifact.
 *
 * ─── DEPENDENCY POSITION ────────────────────────────────────────────────────
 *
 * This is a LEAF module (crypto + secret-shape-guard only). It deliberately
 * owns `stagingVerifiedDecision`, which build-release-evidence.js re-exports as
 * `canEnterStagingVerified`, so the STAGING_VERIFIED predicate has exactly one
 * implementation and verify-exact-candidate.js can validate a baseline without
 * a circular import.
 *
 * Node built-ins only. Pure: no network, no deployment, no mutation.
 */

const crypto = require('node:crypto');

const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard.js');

const BASELINE_SCHEMA_VERSION = 1;

/** Component classes that may never appear in a verified baseline. */
const NON_BASELINE_CLASSES = Object.freeze(['QUARANTINED', 'HERITAGE_UNMANAGED', 'EXCLUDED_WITH_REASON', 'UNKNOWN', 'UNCLASSIFIED']);

const REQUIRED_BASELINE_FIELDS = Object.freeze([
  'schemaVersion',
  'releaseId',
  'sourceSha',
  'sourceTreeSha',
  'manifestDigest',
  'receiptDigest',
  // Binds the baseline to the authoritative release evidence it was minted
  // from. Without this a baseline is an unanchored assertion (DEF-REL-010).
  'releaseEvidenceDigest',
  'componentSourceHashes',
  'componentAttestations',
  'baselineDigest',
]);

/** Release verdicts from which a baseline may legitimately have been minted. */
const ELIGIBLE_PRIOR_VERDICTS = Object.freeze(['PASS', 'PASS_WITH_REPORT_ONLY_FINDINGS']);

class VerifiedBaselineError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'VerifiedBaselineError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function computeBaselineDigest(baselineWithoutDigest) {
  return crypto.createHash('sha256').update(canonicalize(baselineWithoutDigest), 'utf8').digest('hex');
}

/**
 * The single STAGING_VERIFIED predicate. build-release-evidence.js re-exports
 * this as `canEnterStagingVerified` so there is exactly one implementation —
 * duplicating it is how two authorities drift apart (cf. DEF-REL-006).
 */
function stagingVerifiedDecision(evidence) {
  const reasons = [];
  if (!evidence) return { allowed: false, reasons: ['no release evidence supplied'] };

  if (!evidence.stagingVerifiedEligible) {
    reasons.push(`release candidate verdict is ${evidence.releaseCandidateVerdict}`);
  }
  for (const blocker of evidence.blockers || []) reasons.push(`blocker: ${blocker.id}`);
  for (const failure of evidence.operationalFailures || []) reasons.push(`operational failure: ${failure.id}`);

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Mints a verified baseline. Refuses unless the FULL evidence chain proves the
 * release actually reached STAGING_VERIFIED.
 *
 * Returns a frozen baseline, or throws VerifiedBaselineError with
 * code VERIFIED_BASELINE_NOT_ELIGIBLE listing every failed requirement. There
 * is deliberately no partial baseline and no warning-level downgrade.
 */
function mintVerifiedBaseline({ manifest, frozen, receipt, exactCandidateVerification, releaseEvidence, verifiedAt } = {}) {
  const failures = [];
  const need = (ok, code, detail) => { if (!ok) failures.push({ code, detail }); };

  need(Boolean(manifest), 'MANIFEST_MISSING', 'a release manifest is required');
  need(Boolean(frozen), 'FROZEN_RELEASE_MISSING', 'a freeze record is required');
  need(Boolean(receipt), 'RECEIPT_MISSING', 'a finalized deployment receipt is required');
  need(Boolean(exactCandidateVerification), 'EXACT_VERIFICATION_MISSING', 'exact candidate verification is required');
  need(Boolean(releaseEvidence), 'RELEASE_EVIDENCE_MISSING', 'authoritative release evidence is required');

  if (failures.length > 0) {
    throw new VerifiedBaselineError(
      `refusing to mint a verified baseline: ${failures.map((f) => f.code).join(', ')}`,
      'VERIFIED_BASELINE_NOT_ELIGIBLE',
      failures,
    );
  }

  // Receipt must be finalized and self-consistent.
  need(Boolean(receipt.receiptDigest), 'RECEIPT_NOT_FINALIZED', 'receipt carries no receiptDigest');
  if (receipt.receiptDigest) {
    const { receiptDigest, ...content } = receipt;
    const recomputed = crypto.createHash('sha256').update(canonicalize(content), 'utf8').digest('hex');
    need(recomputed === receiptDigest, 'RECEIPT_INTEGRITY_FAILED', 'receipt content does not match its digest');
  }

  // Identity must agree across every artifact.
  need(frozen.releaseId === receipt.releaseId, 'RELEASE_ID_MISMATCH', `freeze ${frozen.releaseId} vs receipt ${receipt.releaseId}`);
  need(frozen.sourceSha === receipt.candidateSha, 'SOURCE_SHA_MISMATCH', `freeze ${frozen.sourceSha} vs receipt ${receipt.candidateSha}`);
  need(frozen.sourceTreeSha === receipt.candidateTreeSha, 'SOURCE_TREE_MISMATCH', `freeze ${frozen.sourceTreeSha} vs receipt ${receipt.candidateTreeSha}`);
  need(frozen.identityDigest === manifest.identityDigest, 'MANIFEST_DIGEST_MISMATCH', 'freeze and manifest digests differ');
  need(frozen.identityDigest === receipt.manifestDigest, 'RECEIPT_MANIFEST_DIGEST_MISMATCH', 'freeze and receipt manifest digests differ');

  // Exact verification must be an unqualified PASS.
  need(
    exactCandidateVerification.result === 'PASS',
    'EXACT_VERIFICATION_NOT_PASS',
    `exact candidate verification returned ${exactCandidateVerification.result}`,
  );

  // Every governed component must be attested. One UNATTESTED component means
  // there is something in the release nobody can vouch for.
  const components = exactCandidateVerification.components || [];
  const unattested = components.filter((c) => c.attestation === 'UNATTESTED');
  need(components.length > 0, 'NO_COMPONENTS_ATTESTED', 'verification recorded no components');
  need(unattested.length === 0, 'UNATTESTED_COMPONENT_PRESENT', `unattested: ${unattested.map((c) => c.name).join(', ')}`);

  // The release must actually have been eligible for STAGING_VERIFIED.
  need(releaseEvidence.stagingVerifiedEligible === true, 'STAGING_VERIFIED_NOT_ELIGIBLE',
    `releaseCandidateVerdict ${releaseEvidence.releaseCandidateVerdict}`);
  const decision = stagingVerifiedDecision(releaseEvidence);
  need(decision.allowed, 'STAGING_VERIFIED_REFUSED', decision.reasons.join('; '));

  if (failures.length > 0) {
    throw new VerifiedBaselineError(
      `refusing to mint a verified baseline: ${failures.map((f) => f.code).join(', ')}`,
      'VERIFIED_BASELINE_NOT_ELIGIBLE',
      failures,
    );
  }

  const componentSourceHashes = {};
  const componentAttestations = {};
  for (const component of components) {
    componentSourceHashes[component.name] = component.sourceHash;
    componentAttestations[component.name] = component.attestation;
  }

  const body = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    releaseId: frozen.releaseId,
    sourceSha: frozen.sourceSha,
    sourceTreeSha: frozen.sourceTreeSha,
    manifestDigest: frozen.identityDigest,
    receiptDigest: receipt.receiptDigest,
    // The anchor: consumption re-fetches this evidence and cross-checks it.
    releaseEvidenceDigest: releaseEvidence.evidenceDigest,
    // Recorded when available so an operator can find the originating run.
    // Never fabricated — null is honest, an invented id is not.
    releaseEvidenceSourceRunId:
      (releaseEvidence.certification && releaseEvidence.certification.sourceRunId)
      || (releaseEvidence.deployment && releaseEvidence.deployment.deploymentRunId)
      || null,
    componentSourceHashes,
    componentAttestations,
    verifiedAt: verifiedAt || new Date().toISOString(),
  };

  const baseline = { ...body, baselineDigest: computeBaselineDigest(body) };
  assertNoEmbeddedSecret(baseline, 'verifiedBaseline');
  return Object.freeze(baseline);
}

/**
 * Validates a baseline at CONSUMPTION time.
 *
 * Two levels, deliberately distinct (DEF-REL-010):
 *
 *   structural  — required fields, checksum consistency, hash shape,
 *                 governance sanity. This is what `baselineDigest` can
 *                 support, and it is NOT sufficient to trust anything.
 *
 *   corroborated — the above PLUS agreement with the authoritative release
 *                 evidence the baseline claims to come from. Only this
 *                 authorizes carry-forward.
 *
 * Omitting `priorReleaseEvidence` therefore yields `valid: false` with
 * PRIOR_RELEASE_EVIDENCE_MISSING: there is no "trust me, the checksum is
 * fine" path, because recomputing a checksum over a fabrication is trivial.
 *
 * @param {object} baseline
 * @param {object} [opts]
 * @param {object|null} [opts.manifest]
 * @param {object|null} [opts.priorReleaseEvidence] - evidence the baseline was minted from
 * @returns {{valid: boolean, errors: string[], structurallyValid: boolean}}
 */
function validateVerifiedBaseline(baseline, { manifest = null, priorReleaseEvidence = null } = {}) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object') {
    return { valid: false, structurallyValid: false, errors: ['baseline must be an object'] };
  }

  for (const field of REQUIRED_BASELINE_FIELDS) {
    const value = baseline[field];
    if (value === undefined || value === null || value === '') errors.push(`missing required field: ${field}`);
  }
  if (baseline.schemaVersion !== undefined && baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    errors.push(`unsupported baseline schemaVersion: ${baseline.schemaVersion}`);
  }

  // Integrity only. A matching digest proves the object is self-consistent,
  // NOT that it was ever minted from a verified release — an attacker who
  // recomputes the digest over their fabrication passes this check. The
  // corroboration block below is what actually establishes provenance.
  if (baseline.baselineDigest) {
    const { baselineDigest, ...body } = baseline;
    if (computeBaselineDigest(body) !== baselineDigest) {
      errors.push('baselineDigest does not match baseline content — baseline was modified after minting');
    }
  }

  if (baseline.componentSourceHashes && typeof baseline.componentSourceHashes === 'object') {
    for (const [name, hash] of Object.entries(baseline.componentSourceHashes)) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
        errors.push(`malformed component source hash for ${name}`);
      }
    }
  }

  // Every component must have been attested, and attested acceptably.
  if (baseline.componentAttestations && typeof baseline.componentAttestations === 'object') {
    for (const [name, attestation] of Object.entries(baseline.componentAttestations)) {
      if (attestation === 'UNATTESTED') errors.push(`baseline claims an UNATTESTED component: ${name}`);
    }
    for (const name of Object.keys(baseline.componentSourceHashes || {})) {
      if (!(name in baseline.componentAttestations)) errors.push(`component ${name} has no recorded attestation`);
    }
  }

  // A baseline may never vouch for a governed-excluded component.
  if (manifest) {
    const classes = new Map((manifest.edgeFunctions || []).map((fn) => [fn.name, fn.class]));
    for (const name of Object.keys(baseline.componentSourceHashes || {})) {
      const declared = classes.get(name);
      if (declared === undefined) {
        errors.push(`baseline claims component ${name}, which the manifest does not classify`);
      } else if (NON_BASELINE_CLASSES.includes(declared)) {
        errors.push(`baseline claims ${declared} component ${name}`);
      }
    }
  }

  const structurallyValid = errors.length === 0;

  // ── corroboration against the authoritative source evidence ───────────────
  //
  // This is the part an unkeyed checksum cannot substitute for. The baseline
  // must agree with real, retained release evidence that itself shows a
  // STAGING_VERIFIED-eligible release.
  if (!priorReleaseEvidence) {
    errors.push('PRIOR_RELEASE_EVIDENCE_MISSING: a standalone baseline cannot authorize carry-forward, regardless of its checksum');
    return { valid: false, structurallyValid, errors };
  }

  const evidenceDigest = priorReleaseEvidence.evidenceDigest;
  if (!evidenceDigest) {
    errors.push('prior release evidence carries no evidenceDigest');
  } else {
    const { evidenceDigest: _omit, ...evidenceBody } = priorReleaseEvidence;
    const recomputed = crypto.createHash('sha256').update(canonicalize(evidenceBody), 'utf8').digest('hex');
    if (recomputed !== evidenceDigest) {
      errors.push('prior release evidence failed its own integrity check');
    }
    if (baseline.releaseEvidenceDigest !== evidenceDigest) {
      errors.push('baseline.releaseEvidenceDigest does not match the supplied prior release evidence');
    }
  }

  const release = priorReleaseEvidence.release || {};
  if (baseline.releaseId !== release.releaseId) {
    errors.push(`release id mismatch: baseline ${baseline.releaseId} vs evidence ${release.releaseId}`);
  }
  if (baseline.sourceSha !== release.sourceSha) {
    errors.push('source SHA mismatch between baseline and prior release evidence');
  }
  if (baseline.sourceTreeSha !== release.sourceTreeSha) {
    errors.push('source tree SHA mismatch between baseline and prior release evidence');
  }
  if (baseline.manifestDigest !== release.manifestDigest) {
    errors.push('manifest digest mismatch between baseline and prior release evidence');
  }

  const priorReceiptDigest = priorReleaseEvidence.deployment && priorReleaseEvidence.deployment.receiptDigest;
  if (baseline.receiptDigest !== priorReceiptDigest) {
    errors.push('receipt digest mismatch between baseline and prior release evidence');
  }

  if (priorReleaseEvidence.stagingVerifiedEligible !== true) {
    errors.push('prior release evidence was not eligible for STAGING_VERIFIED');
  }
  const decision = stagingVerifiedDecision(priorReleaseEvidence);
  if (!decision.allowed) {
    errors.push(`prior release could not enter STAGING_VERIFIED: ${decision.reasons.join('; ')}`);
  }
  if (!ELIGIBLE_PRIOR_VERDICTS.includes(priorReleaseEvidence.releaseCandidateVerdict)) {
    errors.push(`prior releaseCandidateVerdict ${priorReleaseEvidence.releaseCandidateVerdict} is not an eligible verdict`);
  }

  const priorExact = priorReleaseEvidence.exactCandidateVerification;
  if (!priorExact || priorExact.result !== 'PASS') {
    errors.push(`prior exact candidate verification was ${priorExact ? priorExact.result : 'absent'}, not PASS`);
  } else {
    // Component hashes/attestations must agree with the evidence that minted
    // the baseline, so a baseline cannot quietly widen its own coverage.
    const byName = new Map((priorExact.components || []).map((c) => [c.name, c]));
    for (const [name, hash] of Object.entries(baseline.componentSourceHashes || {})) {
      const component = byName.get(name);
      if (!component) {
        errors.push(`baseline claims component ${name}, absent from the prior evidence's attested set`);
      } else if (component.sourceHash !== hash) {
        errors.push(`component ${name} hash disagrees with the prior evidence`);
      } else if (baseline.componentAttestations[name] !== component.attestation) {
        errors.push(`component ${name} attestation disagrees with the prior evidence`);
      }
    }
  }

  return { valid: errors.length === 0, structurallyValid, errors };
}

// ── BOOTSTRAP_FULL_ATTESTATION ───────────────────────────────────────────────

/**
 * The one authoritative staging-applicability rule.
 *
 * `class` governs RELEASE inclusion; `environments` governs DEPLOY targeting.
 * They are independent axes, and bootstrap needs both: a GOVERNED function
 * scoped to production only must not be required by a staging bootstrap, and
 * a quarantined function is never applicable regardless of its environments.
 *
 * A GOVERNED entry with no `environments` is a shared function under the
 * current model and is applicable everywhere.
 */
function isApplicableToEnvironment(entry, environment) {
  if (!entry) return false;
  if (entry.class !== 'GOVERNED' || !entry.releaseIncluded) return false;
  const environments = entry.environments;
  if (environments === undefined || environments === null) return true;
  if (!Array.isArray(environments)) return false;
  return environments.includes(environment);
}

const RELEASE_MODE = Object.freeze({
  CHANGE_SCOPED_DEPLOYMENT: 'CHANGE_SCOPED_DEPLOYMENT',
  BOOTSTRAP_FULL_ATTESTATION: 'BOOTSTRAP_FULL_ATTESTATION',
});

const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

/**
 * Plans the one-time bootstrap that creates the first staging trust root.
 *
 * BOOTSTRAP IS NOT AN INSTALLER. It redeploys already-live governed functions
 * from the frozen candidate so each becomes EXACTLY_DEPLOYED. It must never
 * introduce a function that is not already running on staging merely to obtain
 * attestation — that would be using a provenance mechanism to change what the
 * backend *is*.
 *
 * Migrations are deliberately out of scope: database provenance comes from the
 * manifest inventory plus live migration-state verification. Already-applied
 * migrations are never replayed to manufacture trust.
 *
 * This PLANS and VALIDATES only. It executes nothing.
 */
function planBootstrapFullAttestation({
  manifest,
  frozen,
  environment,
  projectRef,
  liveFunctionNames = null,
  previousVerifiedState = null,
  freezeValid = null,
  candidateBindingOk = null,
} = {}) {
  const refusals = [];
  const refuse = (code, detail) => refusals.push({ code, detail });

  if (environment !== 'staging') refuse('BOOTSTRAP_STAGING_ONLY', `environment ${environment === undefined || environment === null ? '(absent)' : environment} is not staging`);
  if (!projectRef) refuse('BOOTSTRAP_ENVIRONMENT_IDENTITY_MISSING', 'no project ref supplied');
  else if (projectRef !== STAGING_PROJECT_REF) refuse('BOOTSTRAP_UNKNOWN_PROJECT', `project ref ${projectRef} is not the staging project`);

  if (previousVerifiedState !== null && previousVerifiedState !== undefined) {
    refuse('BOOTSTRAP_BASELINE_ALREADY_EXISTS', 'a verified baseline already exists; bootstrap is an initialization exception, not a repeatable mode');
  }
  if (freezeValid === false) refuse('BOOTSTRAP_FREEZE_INVALID', 'candidate freeze did not validate');
  if (candidateBindingOk === false) refuse('BOOTSTRAP_CANDIDATE_BINDING_FAILED', 'candidate binding reported violations');
  if (!manifest) refuse('BOOTSTRAP_MANIFEST_MISSING', 'a release manifest is required');
  if (!frozen) refuse('BOOTSTRAP_FROZEN_RELEASE_MISSING', 'a freeze record is required');

  if (refusals.length > 0 || !manifest) {
    return { ok: false, mode: RELEASE_MODE.BOOTSTRAP_FULL_ATTESTATION, refusals, plan: null };
  }

  // Staging-applicable governed functions only.
  //
  // DEF-REL-011: this previously filtered on class + releaseIncluded alone,
  // despite the surrounding code calling the result "staging-applicable". A
  // GOVERNED function scoped to production would have been demanded by a
  // STAGING bootstrap and, being absent from live staging, would have halted
  // it with a spurious reconciliation error. Environment applicability is now
  // applied through the single shared rule.
  const governedForStaging = (manifest.edgeFunctions || [])
    .filter((fn) => isApplicableToEnvironment(fn, 'staging'));

  if (liveFunctionNames === null) {
    refuse('BOOTSTRAP_LIVE_INVENTORY_UNAVAILABLE', 'live staging Edge Function inventory was not supplied; cannot prove bootstrap adds nothing new');
    return { ok: false, mode: RELEASE_MODE.BOOTSTRAP_FULL_ATTESTATION, refusals, plan: null };
  }

  const live = new Set(liveFunctionNames);
  const eligible = governedForStaging.filter((fn) => live.has(fn.name)).map((fn) => fn.name).sort();
  const absent = governedForStaging.filter((fn) => !live.has(fn.name)).map((fn) => fn.name).sort();

  if (absent.length > 0) {
    return {
      ok: false,
      mode: RELEASE_MODE.BOOTSTRAP_FULL_ATTESTATION,
      refusals: [{
        code: 'BOOTSTRAP_LIVE_INVENTORY_RECONCILIATION_REQUIRED',
        detail: `governed staging function(s) not live on staging: ${absent.join(', ')}. Bootstrap will not install them; reconcile the inventory first.`,
      }],
      plan: null,
      absentGovernedFunctions: absent,
    };
  }

  return {
    ok: true,
    mode: RELEASE_MODE.BOOTSTRAP_FULL_ATTESTATION,
    refusals: [],
    plan: {
      environment: 'staging',
      projectRef,
      releaseId: frozen.releaseId,
      candidateSha: frozen.sourceSha,
      functions: eligible,
      // Explicitly empty and explicitly explained, so a reader does not assume
      // an omission.
      migrations: [],
      migrationsNote: 'Bootstrap establishes Edge Function provenance only. Database provenance comes from the manifest migration inventory plus live migration-state verification; already-applied migrations are never replayed to manufacture trust.',
      excludedByGovernance: (manifest.edgeFunctions || [])
        .filter((fn) => !isApplicableToEnvironment(fn, 'staging'))
        .map((fn) => ({
          name: fn.name,
          class: fn.class,
          reason: fn.class === 'GOVERNED' && fn.releaseIncluded
            ? 'not applicable to staging'
            : `class ${fn.class}`,
        })),
    },
  };
}

module.exports = {
  BASELINE_SCHEMA_VERSION,
  REQUIRED_BASELINE_FIELDS,
  NON_BASELINE_CLASSES,
  ELIGIBLE_PRIOR_VERDICTS,
  RELEASE_MODE,
  isApplicableToEnvironment,
  STAGING_PROJECT_REF,
  VerifiedBaselineError,
  canonicalize,
  computeBaselineDigest,
  stagingVerifiedDecision,
  mintVerifiedBaseline,
  validateVerifiedBaseline,
  planBootstrapFullAttestation,
};
