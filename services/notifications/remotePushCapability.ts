// Remote-push activation capability (Android Repair 05).
//
// THE PROBLEM THIS EXISTS TO SOLVE
//
// Notification permission, Expo push-token acquisition, token registration and
// token refresh are all ACTIVATION steps: each one asks the user for something,
// or mints and stores an identifier that makes the handset addressable. They
// are only legitimate when a feature that actually ships in this build can send
// the user a remote push.
//
// Before this module, K Scan's activation path had no such condition. Onboarding
// offered a live Notifications toggle whose own copy promises watched-item price
// alerts, and turning it on requested the OS permission, obtained an Expo push
// token and registered the device -- in a production build where the Watchlist
// that produces those alerts is dark (eas.json: EXPO_PUBLIC_SMART_WATCHLIST_V1
// is set for `staging-certification` only).
//
// THE AUTHORITY
//
// Every remote push K Scan can send originates in exactly one backend producer,
// supabase/functions/commerce-watch-refresh/pushDelivery.ts, and all four of its
// event types (target_price_reached, price_decreased, listing_unavailable,
// listing_available_again) are Watchlist events. There is no other push sender
// in the backend and no local-notification scheduling anywhere in the app. So
// "a shipping feature needs remote push" is, today, exactly "Smart Watchlist is
// live in this build" -- and that is what this module encodes, in ONE place, so
// permission UI, permission request, token acquisition and token refresh cannot
// drift apart.
//
// The list is deliberately a named set rather than a bare `=== SMART_WATCHLIST_V1`
// alias: when a second push-capable feature ships, it is added here and every
// consumer inherits the new answer with no further edits.
//
// PLATFORM SCOPE
//
// This is an Android release repair, and it is scoped to Android on purpose.
// iOS notification behaviour is deliberately left exactly as it was: no
// gating, no new condition, nothing to observe. Widening the gate to every
// platform would silently darken iOS notifications as a side effect of an
// Android fix, which is a different decision needing its own authority.
//
// FAIL-CLOSED
//
// Every input is a build-time flag resolved by an explicit `=== 'true'`
// comparison (constants/featureFlags.ts), so a missing, empty or malformed
// value resolves false and activation stays off. Unknown capability never
// means "ask for permission anyway".

import { Platform } from 'react-native';
import { SMART_WATCHLIST_V1 } from '../../constants/featureFlags';

/**
 * Platforms whose remote-push ACTIVATION this repair governs.
 *
 * Anything not listed here keeps its pre-repair behaviour unconditionally --
 * see PLATFORM SCOPE above.
 */
export const REMOTE_PUSH_GATED_PLATFORMS: readonly string[] = ['android'] as const;

/** True when this build's push activation is subject to the capability decision. */
export function isRemotePushActivationGated(platformOS: string = Platform.OS): boolean {
  return REMOTE_PUSH_GATED_PLATFORMS.includes(platformOS);
}

/**
 * Does any feature that actually ships in this build consume remote push?
 *
 * The argument defaults to the real resolved flag and exists only as a test
 * seam; no caller in application code should ever pass it.
 */
export function resolveRemotePushConsumerActive(
  smartWatchlistActive: boolean = SMART_WATCHLIST_V1,
): boolean {
  return smartWatchlistActive === true;
}

/**
 * THE canonical decision: may this build acquire remote-push capability?
 *
 * Read by the onboarding permission surface, the permission request, both
 * token-acquisition paths and the token-refresh listener. Passive handling --
 * presenting a notification that already arrived, routing a tap -- is NOT an
 * activation step and deliberately does not consult this.
 *
 * Both arguments default to the real running values and exist only as a test
 * seam.
 */
export function resolveRemotePushActivationAllowed(
  platformOS: string = Platform.OS,
  consumerActive: boolean = resolveRemotePushConsumerActive(),
): boolean {
  if (!isRemotePushActivationGated(platformOS)) return true;
  return consumerActive === true;
}
