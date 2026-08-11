#!/usr/bin/env node
'use strict';

/**
 * PURE VALIDATOR for production promotion eligibility.
 *
 * This module deploys nothing, mutates nothing, and calls nothing over the
 * network. It answers one question about a release manifest: "would
 * promoting this to production be permitted right now, and if not, why not."
 *
 * It exists so the rest of the release control plane can be built and tested
 * without accidentally making production deployable. Today it is expected to
 * return BLOCKED for every input, and the test suite asserts exactly that.
 *
 * Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

const { CURRENT_LAST_KNOWN_GOOD } = require('./last-known-good');

/** Provenance state established by Phase 1 discovery and not yet resolved. */
const PRODUCTION_SOURCE_PROVENANCE = Object.freeze({
  sourceShaKnown: false,
  migrationLevelKnown: false,
  edgeFunctionAttribution: 'PARTIAL',
  configFingerprintAvailable: false,
});

const BLOCKER_CODES = Object.freeze({
  LAST_KNOWN_GOOD_UNKNOWN: 'LAST_KNOWN_GOOD_UNKNOWN',
  PRODUCTION_SOURCE_PROVENANCE_UNKNOWN: 'PRODUCTION_SOURCE_PROVENANCE_UNKNOWN',
  PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED: 'PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED',
  PITR_REQUIRED_FOR_RISK_CLASS: 'PITR_REQUIRED_FOR_RISK_CLASS',
  RECOVERY_PLAN_REQUIRED_FOR_RISK_CLASS: 'RECOVERY_PLAN_REQUIRED_FOR_RISK_CLASS',
  REVIEWED_RECOVERY_PLAN_REQUIRED: 'REVIEWED_RECOVERY_PLAN_REQUIRED',
  DESTRUCTIVE_MIGRATION_PROHIBITED: 'DESTRUCTIVE_MIGRATION_PROHIBITED',
  UNCLASSIFIED_MIGRATION_IN_RELEASE: 'UNCLASSIFIED_MIGRATION_IN_RELEASE',
  MANIFEST_NOT_FROZEN: 'MANIFEST_NOT_FROZEN',
});

function loadPolicy(repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'security', 'release', 'backup-capability-policy.json'), 'utf8'));
}

/**
 * @param {object} opts
 * @param {object} opts.manifest - a release manifest from generate-release-manifest.js
 * @param {string} opts.repoRoot
 * @param {object} [opts.lastKnownGood] - defaults to the current (UNKNOWN) state
 * @param {object} [opts.productionProvenance] - defaults to the discovered (unknown) state
 * @returns {{stagingControlPlaneEligible: boolean, productionPromotionEligible: boolean, blockers: Array}}
 */
function evaluateEligibility(opts) {
  const {
    manifest,
    repoRoot,
    lastKnownGood = CURRENT_LAST_KNOWN_GOOD,
    productionProvenance = PRODUCTION_SOURCE_PROVENANCE,
  } = opts || {};

  if (!manifest) throw new Error('manifest is required');
  const policy = loadPolicy(repoRoot);
  const blockers = [];

  const add = (code, detail) => blockers.push({ code, detail });

  if (!lastKnownGood || lastKnownGood.status !== 'KNOWN') {
    add(BLOCKER_CODES.LAST_KNOWN_GOOD_UNKNOWN,
      'No verified Last Known Good backend release exists to roll back to.');
  }

  if (!productionProvenance.sourceShaKnown || !productionProvenance.migrationLevelKnown) {
    add(BLOCKER_CODES.PRODUCTION_SOURCE_PROVENANCE_UNKNOWN,
      'Current production cannot be attributed to a source SHA or a trustworthy migration level.');
  }

  const reconciliation = manifest.productionMigrationReconciliation;
  if (!reconciliation || reconciliation.status !== 'RESOLVED') {
    add(BLOCKER_CODES.PRODUCTION_MIGRATION_RECONCILIATION_REQUIRED,
      `Production carries migrations with no staging equivalent (${reconciliation ? reconciliation.unresolvedCount : 'unknown'} unresolved). See docs/release/PRODUCTION_MIGRATION_RECONCILIATION.md.`);
  }

  // Migration risk classes, gated by verified backup capability.
  const unclassified = (manifest.migrations || []).filter((m) => m.classificationStatus === 'UNCLASSIFIED_NEW');
  if (unclassified.length > 0) {
    add(BLOCKER_CODES.UNCLASSIFIED_MIGRATION_IN_RELEASE,
      `unclassified migrations: ${unclassified.map((m) => m.name).join(', ')}`);
  }

  const includedClasses = manifest.riskClassification ? manifest.riskClassification.includedRiskClasses || [] : [];
  for (const riskClass of includedClasses) {
    const rule = policy.productionPromotionPolicy[riskClass];
    if (!rule) continue;
    if (!rule.productionPromotionEligible && rule.blockerCode) {
      add(rule.blockerCode, `migration risk class ${riskClass}: ${rule.condition}`);
    }
  }

  if (manifest.status !== 'FROZEN' && manifest.status !== 'STAGING_VERIFIED') {
    add(BLOCKER_CODES.MANIFEST_NOT_FROZEN,
      `manifest status is ${manifest.status}; production promotion requires a frozen, staging-verified candidate.`);
  }

  // Staging control-plane work is deliberately NOT gated on any of the above.
  // Unresolved production reconciliation must never block staging progress.
  const stagingControlPlaneEligible = true;

  return {
    stagingControlPlaneEligible,
    productionPromotionEligible: blockers.length === 0,
    blockers,
  };
}

module.exports = {
  BLOCKER_CODES,
  PRODUCTION_SOURCE_PROVENANCE,
  evaluateEligibility,
};
