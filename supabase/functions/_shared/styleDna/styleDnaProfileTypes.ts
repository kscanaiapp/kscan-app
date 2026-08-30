// Build 34 / Track B / Phase B4 — Style DNA profile types.
//
// PURE TYPES/CONSTANTS ONLY. No Deno/network imports, so every consumer
// (the derivation module, the store, and any future test) can import this
// from either a Deno Edge Function or a Node test harness unchanged.

/** Schema/derivation contract version for `profile_data`. Bump only for a
 *  breaking shape change old readers cannot safely interpret. */
export const STYLE_DNA_PROFILE_VERSION = 1;

/** Top-N cap applied to every frequency dimension below. Keeps the aggregate
 *  a compact summary rather than a compressed second Closet, and keeps the
 *  serialized size far below the 64 KiB database bound (Micro-addendum H). */
export const STYLE_DNA_TOP_N = 10;

/** One frequency entry: a bounded label plus how many evidence items support it. */
export interface StyleDnaFrequencyEntry {
  value: string;
  count: number;
}

/**
 * The bounded aggregate summary stored in `user_style_profiles.profile_data`.
 *
 * EVERY FIELD IS A DERIVED AGGREGATE. Never an item id, a storage path, a raw
 * note, a brand list beyond the top N, or anything that could reconstruct the
 * underlying Closet row by row (Micro-addendum G).
 */
export interface StyleDnaProfileDataV1 {
  /** Non-tombstoned Closet rows this profile was derived from. */
  evidenceCount: number;
  colorFrequency: StyleDnaFrequencyEntry[];
  categoryFrequency: StyleDnaFrequencyEntry[];
  garmentTypeFrequency: StyleDnaFrequencyEntry[];
  brandFrequency: StyleDnaFrequencyEntry[];
  materialFrequency: StyleDnaFrequencyEntry[];
}

/** One row of the shape the derivation module needs from `user_closet_items`.
 *  Intentionally narrower than the full table: only facts columns Style DNA
 *  actually aggregates over, never media/storage columns. */
export interface StyleDnaClosetFactsRow {
  updatedAt: string;
  category: string | null;
  clothingType: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: string[] | null;
  material: string[] | null;
}

/** The full persisted record, mirroring `user_style_profiles` column-for-column. */
export interface StyleDnaProfileRecord {
  userId: string;
  profileVersion: number;
  evidenceRevision: string;
  derivedAt: string;
  profileData: StyleDnaProfileDataV1;
}
