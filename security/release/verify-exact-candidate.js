#!/usr/bin/env node
'use strict';

/**
 * Exact-candidate verification.
 *
 * Answers: "is what is running on staging exactly the frozen candidate we
 * intended to deploy?" — and, critically, is honest about the parts it cannot
 * prove.
 *
 * ─── TRUST MODEL (read this before extending) ───────────────────────────────
 *
 * Supabase's Management API exposes, per Edge Function, an `ezbr_sha256` and a
 * version counter. Neither is derivable from repository source: `ezbr_sha256`
 * hashes Supabase's own built bundle, not our tree, and the version counter is
 * per-project and monotonic (Phase 1 established that scan-identify reading v4
 * on staging and v141 on production is NOT drift). So there is no supported
 * way to recompute a deployed function's content hash from our source and
 * compare byte-for-byte.
 *
 * We therefore do not claim byte-level runtime attestation. Instead each
 * governed component carries an explicit, auditable attestation class:
 *
 *   EXACTLY_DEPLOYED_FROM_FROZEN_CANDIDATE
 *     The component was in this deployment's delta. Its bytes were read from
 *     the immutable candidate (git show), hashed into the binding, deployed in
 *     this run, and recorded in the receipt. Strongest available claim.
 *
 *   CARRIED_FORWARD_FROM_PREVIOUS_VERIFIED_STATE
 *     The component was NOT redeployed. Its correctness rests on a prior
 *     verified release baseline. Legitimate only when such a baseline exists
 *     AND its manifest digest matches what this candidate expects for that
 *     component.
 *
 *   UNATTESTED
 *     Neither of the above holds. Reported, never silently accepted.
 *
 * When any governed component is UNATTESTED because no prior verified baseline
 * exists, the verifier returns FULL_RUNTIME_ATTESTATION_GAP. That is the
 * expected result for the FIRST release through this system: there is no
 * earlier verified state to carry anything forward from, and inventing one
 * would be fabricated provenance. The gap is a disclosed limitation, not a
 * pass and not an error.
 *
 * Node built-ins only. Read-only: performs no deployment and no mutation.
 */

const { resolveEnvironment } = require('../scripts/lib/environment-authority.js');
const { verifyReceiptIntegrity } = require('./deployment-receipt.js');

const VERIFIER_SCHEMA_VERSION = 1;

const RESULT = Object.freeze({
  PASS: 'PASS',
  BLOCKED: 'BLOCKED',
  OPERATIONAL_FAILURE: 'OPERATIONAL_FAILURE',
  FULL_RUNTIME_ATTESTATION_GAP: 'FULL_RUNTIME_ATTESTATION_GAP',
});

const ATTESTATION = Object.freeze({
  EXACT: 'EXACTLY_DEPLOYED_FROM_FROZEN_CANDIDATE',
  CARRIED_FORWARD: 'CARRIED_FORWARD_FROM_PREVIOUS_VERIFIED_STATE',
  UNATTESTED: 'UNATTESTED',
});

function check(id, ok, detail, severity = 'BLOCKED') {
  return { id, status: ok ? 'PASS' : severity, detail: ok ? null : detail };
}

/**
 * Classifies every governed component in the manifest.
 *
 * @param {object} opts
 * @param {object} opts.manifest
 * @param {string[]} opts.deployedFunctions      - what this run actually deployed
 * @param {object|null} opts.previousVerifiedState - prior verified baseline, if any
 */
function attestComponents({ manifest, deployedFunctions = [], previousVerifiedState = null }) {
  const deployed = new Set(deployedFunctions);
  const carriedForwardHashes = (previousVerifiedState && previousVerifiedState.componentSourceHashes) || {};
  const components = [];

  for (const fn of manifest.edgeFunctions || []) {
    if (!fn.releaseIncluded) continue;

    if (deployed.has(fn.name)) {
      components.push({
        name: fn.name,
        attestation: ATTESTATION.EXACT,
        sourceHash: fn.sourceHash,
        basis: 'deployed in this run from the immutable frozen candidate',
      });
      continue;
    }

    const priorHash = carriedForwardHashes[fn.name];
    if (priorHash && priorHash === fn.sourceHash) {
      components.push({
        name: fn.name,
        attestation: ATTESTATION.CARRIED_FORWARD,
        sourceHash: fn.sourceHash,
        basis: `unchanged since verified release ${previousVerifiedState.releaseId}`,
      });
      continue;
    }

    components.push({
      name: fn.name,
      attestation: ATTESTATION.UNATTESTED,
      sourceHash: fn.sourceHash,
      basis: priorHash
        ? 'source hash differs from the last verified state but was not redeployed in this run'
        : 'not deployed in this run and no prior verified state covers it',
    });
  }

  return components;
}

/**
 * @param {object} opts
 * @param {object} opts.frozen                  - freeze record
 * @param {object} opts.manifest                - manifest for the candidate
 * @param {object} opts.receipt                 - finalized deployment receipt
 * @param {object|null} opts.liveVersion        - parsed /version response
 * @param {string[]} opts.liveMigrationNames    - migration names applied on staging
 * @param {string} opts.expectedEnvironment
 * @param {string} opts.observedProjectRef
 * @param {object|null} [opts.previousVerifiedState]
 * @returns {{result: string, checks: object[], components: object[], limitations: string[]}}
 */
function verifyExactCandidate(opts) {
  const {
    frozen,
    manifest,
    receipt,
    liveVersion,
    liveMigrationNames = null,
    expectedEnvironment = 'staging',
    observedProjectRef,
    previousVerifiedState = null,
  } = opts || {};

  const checks = [];
  const limitations = [];

  // ── required evidence present at all ──────────────────────────────────────
  if (!frozen || !manifest || !receipt) {
    return {
      result: RESULT.OPERATIONAL_FAILURE,
      checks: [check('required_evidence_present', false, 'freeze, manifest and receipt are all required', 'OPERATIONAL_FAILURE')],
      components: [],
      limitations: ['verification could not run: required evidence was not produced'],
    };
  }

  // ── environment ───────────────────────────────────────────────────────────
  let resolvedEnvironment = null;
  try {
    resolvedEnvironment = resolveEnvironment(observedProjectRef);
    checks.push(check('environment_resolves', true));
  } catch (error) {
    checks.push(check('environment_resolves', false, `observed project ref did not resolve: ${error.code}`));
  }
  checks.push(check(
    'environment_matches_expected',
    resolvedEnvironment === expectedEnvironment,
    `expected ${expectedEnvironment}, resolved ${resolvedEnvironment}`,
  ));
  checks.push(check(
    'receipt_environment_matches',
    receipt.environment === expectedEnvironment && receipt.projectRef === observedProjectRef,
    `receipt records ${receipt.environment}/${receipt.projectRef}`,
  ));

  // ── receipt integrity ─────────────────────────────────────────────────────
  const integrity = verifyReceiptIntegrity(receipt);
  checks.push(check('receipt_integrity', integrity.valid, integrity.reason, 'OPERATIONAL_FAILURE'));

  // ── source identity ───────────────────────────────────────────────────────
  checks.push(check('receipt_sha_matches_freeze', receipt.candidateSha === frozen.sourceSha,
    `receipt ${receipt.candidateSha} vs freeze ${frozen.sourceSha}`));
  checks.push(check('receipt_tree_matches_freeze', receipt.candidateTreeSha === frozen.sourceTreeSha,
    `receipt ${receipt.candidateTreeSha} vs freeze ${frozen.sourceTreeSha}`));
  checks.push(check('manifest_digest_matches_freeze', manifest.identityDigest === frozen.identityDigest,
    `manifest ${manifest.identityDigest} vs freeze ${frozen.identityDigest}`));
  checks.push(check('receipt_manifest_digest_matches', receipt.manifestDigest === frozen.identityDigest,
    `receipt ${receipt.manifestDigest} vs freeze ${frozen.identityDigest}`));

  // ── live release identity (/version) ──────────────────────────────────────
  if (!liveVersion) {
    checks.push(check('live_version_available', false, '/version was not reachable or returned no body', 'OPERATIONAL_FAILURE'));
  } else if (liveVersion.releaseIdentityState === 'NOT_VERIFIABLE') {
    checks.push(check('live_version_identity_present', false,
      'deployed function reports NOT_VERIFIABLE: release identity metadata is not configured', 'OPERATIONAL_FAILURE'));
  } else {
    checks.push(check('live_version_available', true));
    checks.push(check('live_release_id_matches', liveVersion.releaseId === frozen.releaseId,
      `live ${liveVersion.releaseId} vs frozen ${frozen.releaseId}`));
    checks.push(check('live_source_sha_matches', liveVersion.sourceSha === frozen.sourceSha,
      `live ${liveVersion.sourceSha} vs frozen ${frozen.sourceSha}`));
    checks.push(check('live_manifest_digest_matches', liveVersion.manifestDigest === frozen.identityDigest,
      `live ${liveVersion.manifestDigest} vs frozen ${frozen.identityDigest}`));
    checks.push(check('live_health_contract_matches', liveVersion.healthContractVersion === manifest.healthContractVersion,
      `live ${liveVersion.healthContractVersion} vs manifest ${manifest.healthContractVersion}`));
  }

  // ── migration state ───────────────────────────────────────────────────────
  if (liveMigrationNames === null) {
    checks.push(check('migration_state_observed', false, 'live migration inventory was not collected', 'OPERATIONAL_FAILURE'));
  } else {
    const expected = new Set((manifest.migrations || []).map((m) => m.name));
    const live = new Set(liveMigrationNames);
    const missing = [...expected].filter((name) => !live.has(name));
    checks.push(check('migration_state_matches', missing.length === 0,
      `staging is missing ${missing.length} candidate migration(s): ${missing.slice(0, 5).join(', ')}`));
    // Staging carrying extra migrations is expected (website heritage), so it
    // is reported as context rather than treated as candidate drift.
    const extra = [...live].filter((name) => !expected.has(name));
    if (extra.length > 0) {
      limitations.push(`staging carries ${extra.length} migration(s) not in the candidate manifest (expected for website-heritage objects)`);
    }
  }

  // ── deployment delta sanity ───────────────────────────────────────────────
  const deployedFunctions = receipt.functionsDeployed || [];
  const governed = new Set((manifest.edgeFunctions || []).filter((f) => f.releaseIncluded).map((f) => f.name));
  const ungovernedDeployed = deployedFunctions.filter((name) => !governed.has(name));
  checks.push(check('no_ungoverned_component_deployed', ungovernedDeployed.length === 0,
    `deployed but not governed: ${ungovernedDeployed.join(', ')}`));

  // ── component attestation ─────────────────────────────────────────────────
  const components = attestComponents({ manifest, deployedFunctions, previousVerifiedState });
  const unattested = components.filter((c) => c.attestation === ATTESTATION.UNATTESTED);

  // ── verdict ───────────────────────────────────────────────────────────────
  const operational = checks.filter((c) => c.status === 'OPERATIONAL_FAILURE');
  const blocked = checks.filter((c) => c.status === 'BLOCKED');

  let result;
  if (blocked.length > 0) {
    // A real mismatch outranks an evidence-collection problem: if the deployed
    // SHA is wrong, that is a blocker regardless of what else failed to load.
    result = RESULT.BLOCKED;
  } else if (operational.length > 0) {
    result = RESULT.OPERATIONAL_FAILURE;
  } else if (unattested.length > 0) {
    result = RESULT.FULL_RUNTIME_ATTESTATION_GAP;
    limitations.push(
      `${unattested.length} governed component(s) are UNATTESTED: ${unattested.map((c) => c.name).join(', ')}. ` +
      (previousVerifiedState
        ? 'They were neither redeployed in this run nor matched by the previous verified state.'
        : 'No previous verified release baseline exists, so nothing can be carried forward. This is expected for the first release through this system.'),
    );
  } else {
    result = RESULT.PASS;
  }

  limitations.push(
    'Runtime attestation is source-and-deployment based, not byte-level: Supabase exposes ezbr_sha256 over its own built bundle, which is not derivable from repository source, so a deployed function\'s live bytes cannot be recomputed and compared directly.',
  );

  return {
    schemaVersion: VERIFIER_SCHEMA_VERSION,
    result,
    checks,
    components,
    limitations,
  };
}

/** Builds the carry-forward baseline a future run will use. */
function buildVerifiedState({ releaseId, manifest }) {
  const componentSourceHashes = {};
  for (const fn of manifest.edgeFunctions || []) {
    if (fn.releaseIncluded && fn.sourceHash) componentSourceHashes[fn.name] = fn.sourceHash;
  }
  return {
    releaseId,
    manifestDigest: manifest.identityDigest,
    sourceSha: manifest.sourceSha,
    componentSourceHashes,
  };
}

module.exports = {
  VERIFIER_SCHEMA_VERSION,
  RESULT,
  ATTESTATION,
  attestComponents,
  verifyExactCandidate,
  buildVerifiedState,
};
