/**
 * The PostHog identity-transition rule, factored out from posthogClient.tsx
 * so it has zero JSX/vendor-SDK dependency and can be exercised directly by
 * __tests__/posthogIdentitySync.test.js against a fake client.
 *
 * Always resets before establishing a different identity: anonymous →
 * identify(A) → reset() → identify(B), logout → reset, and an actor switch
 * (A signs out, B signs in) never lets B inherit A's distinct id. A re-sync
 * with the same userId is a no-op.
 */

export interface PostHogIdentityClient {
  identify(distinctId: string): void;
  reset(): void;
}

// `undefined` means this process has not synchronized the SDK yet. It is
// deliberately distinct from anonymous (`null`): PostHog can restore a prior
// distinct id from its own storage, so the first anonymous sync must reset it.
let lastSyncedUserId: string | null | undefined;

export function syncPostHogIdentityWith(
  client: PostHogIdentityClient | null,
  userId: string | null,
): void {
  if (!client) return;
  if (userId === lastSyncedUserId) return;
  client.reset();
  if (userId) client.identify(userId);
  lastSyncedUserId = userId;
}

/** Test seam only. Not used by production code. */
export function __resetPostHogIdentitySyncForTests(): void {
  lastSyncedUserId = undefined;
}
