// When a claimed wearable session stops being usable.
//
// THE PROBLEM THIS SOLVES. wearable-bridge issues sessions with a 15-minute TTL
// (`SESSION_TTL_MS`) and enforces it on every protected call. The companion
// screen stored `sessionExpiresAt` from the pair.approved frame and then never
// looked at it again, so after expiry the UI still said "Paired." and kept the
// Capture button live. Pressing it opened the camera, took a real photo, ran the
// full on-device privacy pipeline and compressed the image — and only THEN
// learned from the server that the session was gone. A wearer was invited to
// photograph something by an app that already had no authority to scan it.
//
// This module is the clock, kept pure so the transition is testable off-device.
//
// No runtime imports: loaded by the Node test harness in a sandbox whose
// `require` throws.

/**
 * Mirrors `SESSION_TTL_MS` in the deployed wearable-bridge Edge Function.
 *
 * Only used as a fail-CLOSED fallback when the server did not tell us when the
 * session ends. Treating an unknown expiry as "never" is what produced the
 * false READY state in the first place, so an unknown expiry is treated as the
 * protocol's own maximum instead.
 */
export const WEARABLE_SESSION_TTL_MS = 15 * 60_000;

/** Absolute epoch-ms instant a claimed session stops being usable. */
export function wearableSessionExpiryAt(sessionExpiresAt: unknown, claimedAt: number): number {
  return typeof sessionExpiresAt === 'number' && Number.isFinite(sessionExpiresAt)
    ? sessionExpiresAt
    : claimedAt + WEARABLE_SESSION_TTL_MS;
}

/**
 * True once the session is no longer usable.
 *
 * Uses `>=`, not `>`: the bridge rejects a session whose `expires_at` has been
 * reached (`Date.parse(expires_at) <= Date.now()`), so the client must consider
 * the exact expiry instant expired too, or it would offer one last capture the
 * server is already refusing.
 */
export function isWearableSessionExpired(
  sessionExpiresAt: unknown,
  claimedAt: number,
  now: number,
): boolean {
  return now >= wearableSessionExpiryAt(sessionExpiresAt, claimedAt);
}

/** Whole seconds left before expiry; 0 once expired. Never negative. */
export function wearableSessionSecondsRemaining(
  sessionExpiresAt: unknown,
  claimedAt: number,
  now: number,
): number {
  const remaining = wearableSessionExpiryAt(sessionExpiresAt, claimedAt) - now;
  return remaining > 0 ? Math.floor(remaining / 1000) : 0;
}
