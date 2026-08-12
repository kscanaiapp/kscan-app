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
 * may NEVER become a trust root. Minting now requires the complete evidence
 * chain, and consumption re-validates it — a caller cannot fabricate a
 * baseline-shaped object and have it trusted just because the field names line
 * up.
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
  'componentSourceHashes',
  'componentAttestations',
  'baselineDigest',
]);

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
    componentSourceHashes,
    componentAttestations,
    verifiedAt: verifiedAt || new Date().toISOString(),
  };

  const baseline = { ...body, baselineDigest: computeBaselineDigest(body) };
  assertNoEmbeddedSecret(baseline, 'verifiedBaseline');
  return Object.freeze(baseline);
}

/**
 * Validates a baseline at CONSUMPTION time. Protecting only creation would be
 * pointless — a caller can hand `verifyExactCandidate` any object it likes, so
 * a baseline must prove itself every time it is trusted.
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateVerifiedBaseline(baseline, { manifest = null } = {}) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object') return { valid: false, errors: ['baseline must be an object'] };

  for (const field of REQUIRED_BASELINE_FIELDS) {
    const value = baseline[field];
    if (value === undefined || value === null || value === '') errors.push(`missing required field: ${field}`);
  }
  if (baseline.schemaVersion !== undefined && baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    errors.push(`unsupported baseline schemaVersion: ${baseline.schemaVersion}`);
  }

  // Integrity: this is what rejects a hand-written, manifest-shaped object.
  if (baseline.baselineDigest) {
    const { baselineDigest, ...body } = baseline;
    if (computeBaselineDigest(body) !== baselineDigest) {
      errors.push('baselineDigest does not match baseline content — baseline was fabricated or modified');
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

  return { valid: errors.length === 0, errors };
}

// ── BOOTSTRAP_FULL_ATTESTATION ───────────────────────────────────────────────

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

  // Staging-applicable governed functions only. Quarantined, heritage and
  // excluded surfaces are structurally unreachable from this list.
  const governedForStaging = (manifest.edgeFunctions || []).filter((fn) => (
    fn.class === 'GOVERNED' && fn.releaseIncluded
  ));

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
        .filter((fn) => !(fn.class === 'GOVERNED' && fn.releaseIncluded))
        .map((fn) => ({ name: fn.name, class: fn.class })),
    },
  };
}

module.exports = {
  BASELINE_SCHEMA_VERSION,
  REQUIRED_BASELINE_FIELDS,
  NON_BASELINE_CLASSES,
  RELEASE_MODE,
  STAGING_PROJECT_REF,
  VerifiedBaselineError,
  canonicalize,
  computeBaselineDigest,
  stagingVerifiedDecision,
  mintVerifiedBaseline,
  validateVerifiedBaseline,
  planBootstrapFullAttestation,
};
