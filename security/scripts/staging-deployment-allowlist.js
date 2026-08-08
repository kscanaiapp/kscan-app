#!/usr/bin/env node
'use strict';

/**
 * The explicit "this function is approved for automatic CI deployment to
 * staging" decision, as data rather than an implicit side effect of source
 * changing. Without this gate, hardening a currently-undeployed function's
 * source (to get tests passing locally) would cause the changed-function
 * detector to treat it as "changed" and deploy it on the next push — exactly
 * the unapproved first-deployment this project's pause rules forbid.
 *
 * A function must be added here deliberately (a reviewable one-line diff)
 * before deploy-changed-functions.js will ever deploy it, even if its
 * directory is in the computed change manifest.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVENANCE_EXCEPTIONS_PATH = path.join(__dirname, '..', 'staging', 'provenance-exceptions.json');

const STAGING_DEPLOYMENT_ALLOWLIST = [
  // Already live before this pass.
  // NOTE: privacy-controls and public-sale-share-opt-out were removed from this
  // list. Their deployed bundles cannot be tied to source in this repository
  // (issue #46) and they are quarantined in provenance-exceptions.json. Leaving
  // them here was a latent hazard: the moment their source appeared under
  // supabase/functions/, the changed-function detector would have deployed an
  // unverified bundle over a live, privacy-relevant function.
  'handle-user-deletion',
  'privacy-correction-request',
  'privacy-data-export',
  'stylechat-generate',
  // Hardened and cleared for redeploy in Pass 4.
  'product-search-deals',
  'kickscrew-sneaker-description',
  // Staging deployment observability — approved for controlled pipeline proof.
  'staging-health',
  // Deliberately NOT listed — hardened in source this pass but kept
  // undeployed pending an explicit follow-up decision:
  //   'search-vinted-secondhand' — required Apify secrets absent from staging
  //   'tryon-clothes-pro'        — no explicit deploy decision made this pass
  //   'nike-shoe-details'        — no live caller, no deploy decision made
  //   'scan-identify'            — not first resumed deployment
  //   'shared-room-image-url'    — not present in this branch yet
];

// Slugs whose live bundle cannot be tied to source in this repository. These are
// refused unconditionally, even if an allowlist entry is added, so recovering a
// function's source can never by itself cause it to be redeployed over the live
// unverified bundle. Read from data so the quarantine and the security evidence
// stay in one place.
function loadQuarantinedSlugs(file = PROVENANCE_EXCEPTIONS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed.functions || [])
      .filter((fn) => fn.deployment_policy === 'DO_NOT_REDEPLOY')
      .map((fn) => fn.slug);
  } catch (error) {
    // Fail closed: if the quarantine cannot be read we cannot prove a slug is
    // safe to deploy, so refuse the whole batch rather than deploying blind.
    throw new Error(`provenance quarantine unreadable, refusing to deploy: ${error.message}`);
  }
}

// Splits a computed deploy manifest into what's actually approved to deploy
// now vs. what's changed-and-ready-in-source but held back pending approval,
// vs. what is quarantined for unproven provenance.
// Never silently drops the held-back or quarantined sets — callers must surface them.
function filterToApproved(manifest, allowlist = STAGING_DEPLOYMENT_ALLOWLIST, quarantined = loadQuarantinedSlugs()) {
  const approvedSet = new Set(allowlist);
  const quarantinedSet = new Set(quarantined);

  const quarantinedHits = manifest.filter((name) => quarantinedSet.has(name));
  const remaining = manifest.filter((name) => !quarantinedSet.has(name));
  const approved = remaining.filter((name) => approvedSet.has(name));
  const heldBack = remaining.filter((name) => !approvedSet.has(name));

  return { approved, heldBack, quarantined: quarantinedHits };
}

module.exports = {
  STAGING_DEPLOYMENT_ALLOWLIST,
  PROVENANCE_EXCEPTIONS_PATH,
  loadQuarantinedSlugs,
  filterToApproved,
};
