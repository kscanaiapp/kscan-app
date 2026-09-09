/**
 * PH35-R2 — ANONYMOUS IDENTITY ONLY.
 *
 * K Scan's PostHog model is anonymous product analytics. PostHog is never
 * told who the user is: no Supabase user id, no email, no display name, no
 * profile id, no RevenueCat App User ID, no push/auth/refresh token, no
 * advertising identifier — and no hash of any of them, since a hash of an
 * authenticated identifier is still an authenticated identifier and this
 * analytics model does not need one.
 *
 * The ONLY identifier PostHog ever uses is the anonymous distinct id its own
 * SDK generates. This module never creates, stores, or correlates an
 * identifier of its own.
 *
 * WHY THIS TAKES A BOOLEAN AND NOT A USER ID: the signature is the guarantee.
 * A function that cannot receive an identifier cannot forward one, so no
 * future caller can reintroduce the leak by passing `session.user.id` to a
 * parameter that still accepts it. What crosses this boundary is one bit —
 * whether somebody is signed in — never who.
 *
 * WHAT IT STILL DOES: resets the SDK at an authentication boundary, so the
 * anonymous distinct id does not span two different people on a shared
 * device. That reset already existed (the previous implementation reset
 * before every identify); this repair removes the identify and keeps the
 * reset, which is the smaller change and the safer posture.
 *
 * Exercised directly by __tests__/posthogAnonymousIdentity.test.js against a
 * fake client — this file has zero JSX and zero vendor-SDK dependency, so it
 * runs for real under plain `node --test`.
 */

export interface PostHogAnonymousIdentityClient {
  reset(): void;
}

// `undefined` means this process has not synchronized the SDK yet, and is
// deliberately distinct from `false` (signed out): PostHog can restore a
// prior distinct id from its own storage, so the first sync must reset it
// even though nobody has signed in.
let lastAuthenticatedState: boolean | undefined;

/**
 * Reset PostHog's anonymous distinct id when the authentication state
 * changes. Takes no identifier and returns nothing to the caller.
 */
export function syncPostHogAnonymousIdentityWith(
  client: PostHogAnonymousIdentityClient | null,
  isAuthenticated: boolean,
): void {
  if (!client) return;
  if (isAuthenticated === lastAuthenticatedState) return;
  client.reset();
  lastAuthenticatedState = isAuthenticated;
}

/** Test seam only. Not used by production code. */
export function __resetPostHogAnonymousIdentityForTests(): void {
  lastAuthenticatedState = undefined;
}
