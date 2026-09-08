// Smart Watchlist feature availability (Watchlist Repair 06).
//
// THE DISTINCTION THIS EXISTS TO ENFORCE
//
//   AVAILABILITY  — does Smart Watchlist EXIST in this build/environment?
//                   Authority: SMART_WATCHLIST_V1 (constants/featureFlags.ts),
//                   set from EXPO_PUBLIC_SMART_WATCHLIST_V1 in eas.json.
//   ENTITLEMENT   — may THIS ACTOR use an available premium feature?
//                   Authority: KPlusGate / the K+ entitlement state.
//
// The correct composition is AVAILABLE && ENTITLED. The inverse —
// treating entitlement as availability — is the defect this module closes.
//
// THE DEFECT
//
// components/home/HomeLuxuryTechV1.tsx already ordered these correctly
// (`watchlistEnabled && <KPlusGate>`), but the rest of the feature did not.
// The ProductShelf Watch action, the Watch-creation modal, both /watchlist
// routes and the createWatch/resumeWatch/refreshWatches service operations
// consulted K+ alone, or nothing at all. Production containment therefore
// rested partly on KPLUS_EARLY_ACCESS_ENABLED being false rather than on
// SMART_WATCHLIST_V1 being false — so a future, unrelated K+ activation
// could have reached Watch creation without Smart Watchlist ever being
// switched on. Latent, not live: both flags are off in production today.
//
// ONE AUTHORITY, NOT A SECOND ROLLOUT SYSTEM
//
// This resolver deliberately has exactly one feature-existence input and no
// others. No remote config, no second environment variable, no feature-freeze
// key, no per-platform variation, and above all nothing entitlement-derived.
// It exists to give every Watchlist surface and write path ONE place to ask
// the question, not to become a parallel source of truth.
//
// Android remote-push activation (services/notifications/remotePushCapability.ts,
// Repair 05) answers a different question from the same flag and is left
// exactly as it was.
//
// FAIL-CLOSED
//
// SMART_WATCHLIST_V1 is resolved by an explicit `=== 'true'` comparison, so a
// missing, empty or malformed value resolves false and the feature stays dark.

import { SMART_WATCHLIST_V1 } from '../../constants/featureFlags';

/**
 * THE canonical Smart Watchlist availability decision.
 *
 * The argument defaults to the real resolved flag and exists only as a test
 * seam; no caller in application code should ever pass it.
 */
export function resolveWatchlistAvailable(
  smartWatchlistActive: boolean = SMART_WATCHLIST_V1,
): boolean {
  return smartWatchlistActive === true;
}

/** Evaluated once at import time against the real flag. */
export const WATCHLIST_AVAILABLE = resolveWatchlistAvailable();
