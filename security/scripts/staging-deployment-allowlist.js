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

const STAGING_DEPLOYMENT_ALLOWLIST = [
  // Already live before this pass.
  'privacy-controls',
  'public-sale-share-opt-out',
  'handle-user-deletion',
  'privacy-correction-request',
  'privacy-data-export',
  'stylechat-generate',
  // Hardened and cleared for redeploy in Pass 4.
  'product-search-deals',
  'kickscrew-sneaker-description',
  // Deliberately NOT listed — hardened in source this pass but kept
  // undeployed pending an explicit follow-up decision:
  //   'search-vinted-secondhand' — required Apify secrets absent from staging
  //   'tryon-clothes-pro'        — no explicit deploy decision made this pass
  //   'nike-shoe-details'        — no live caller, no deploy decision made
];

// Splits a computed deploy manifest into what's actually approved to deploy
// now vs. what's changed-and-ready-in-source but held back pending approval.
// Never silently drops the held-back set — callers must surface it.
function filterToApproved(manifest, allowlist = STAGING_DEPLOYMENT_ALLOWLIST) {
  const approvedSet = new Set(allowlist);
  const approved = manifest.filter((name) => approvedSet.has(name));
  const heldBack = manifest.filter((name) => !approvedSet.has(name));
  return { approved, heldBack };
}

module.exports = { STAGING_DEPLOYMENT_ALLOWLIST, filterToApproved };
