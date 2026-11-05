// Build 35 / Shared repair — the single Cloud Closet rollout authority.
//
// ONE question, asked by every Cloud Closet path: is the cloud service
// currently proven to work in this environment and build? The Closet card's
// claim and CTA, the manual CHECK, automatic outbound sync (save / delete /
// Closet open / purchase import), legacy migration and cross-device restore
// all ask it here. Before this module the card asked the proof and the engines
// asked only flag + K+, so an active member's Closet uploaded in the
// background while the card said "Cloud backup is currently unavailable".
//
// The answer is the dated, environment-scoped, fingerprint-bound runtime proof
// in services/kplus/kplusCapabilityProof.ts. Nothing here invents, extends or
// relaxes a proof: with no current PROVEN_RUNTIME record the rollout is
// WITHHELD and every path stays dormant, so "unavailable" is literally true.
// A real proof record re-enables all paths together, on the same rule.
//
// This is a ROLLOUT gate layered ON TOP of the existing gates. It never
// replaces the build flags, the server-authoritative K+ entitlement, consent,
// RLS, actor isolation or the proof's own freshness checks, and it never grants
// anything. Local Closet behaviour is untouched by it.
//
// One narrow exception lives in closetSyncEngine.ts, not here: while withheld,
// an entitled member's DELETION of an item that already reached the cloud is
// still pushed as a tombstone, so withholding new uploads never strands a copy
// the member asked to remove.

import { hasRuntimeCapabilityProof, type CapabilityProofContext } from '../kplus/kplusCapabilityProof';

/** Outbound backup (facts + sanitized media) and legacy-item enrolment. */
export function isCloudClosetOutboundAuthorized(context?: CapabilityProofContext): boolean {
  return hasRuntimeCapabilityProof('cloud_closet', 'closet_outbound_sync', context);
}

/** Cross-device restore. Requires its OWN proof as well as outbound: restore
 *  was never runtime-proven, and outbound evidence does not transfer to it. */
export function isCloudClosetRestoreAuthorized(context?: CapabilityProofContext): boolean {
  return isCloudClosetOutboundAuthorized(context)
    && hasRuntimeCapabilityProof('cloud_closet', 'closet_cross_device_restore', context);
}
