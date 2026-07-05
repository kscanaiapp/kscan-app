/**
 * Free Tier Utility Expansion — optional backend sync feature flags.
 *
 * All flags default to false. The free-tier utility layer remains fully
 * local-first and functional when every flag here is disabled.
 *
 * Backend sync is opt-in only via environment variables and must never be
 * required for core free-tier features to work.
 */

const isTrue = (value?: string): boolean => value === 'true';

/** Master switch: if false, no backend sync code paths are active. */
export const FREE_TIER_BACKEND_SYNC_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_BACKEND_SYNC_ENABLED
);

/** Allow reading remote utility data into local stores. */
export const FREE_TIER_BACKEND_READ_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_BACKEND_READ_ENABLED
);

/** Allow writing local utility data to remote tables. */
export const FREE_TIER_BACKEND_WRITE_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_BACKEND_WRITE_ENABLED
);

/** Enable the local pending-write queue (storage-only; no network). */
export const FREE_TIER_BACKEND_QUEUE_ENABLED = isTrue(
  process.env.EXPO_PUBLIC_FREE_TIER_BACKEND_QUEUE_ENABLED
);
