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

// ── Stored-shape validation (audit repair, Track B B4/B5) ────────────────────
//
// WHY THIS EXISTS: `user_style_profiles.profile_data` is a `jsonb` column whose
// only database-level constraints are "is an object" and "<= 64 KiB". Its
// WRITER is public.upsert_style_dna_profile(), a SECURITY DEFINER RPC granted
// to `authenticated` that takes `p_profile_data` as a parameter -- so the exact
// shape below is an application-layer contract, not something the database
// enforces. Anything reading a stored profile back (the store, and through it
// the Elise prompt builder) must therefore VALIDATE rather than assume.
//
// Before this guard, a stored row whose `profile_data` was missing a frequency
// array (or carried a non-string label) made the prompt builder throw a
// TypeError from inside stylechat-generate's request path, OUTSIDE the
// try/catch that guards the profile fetch -- turning an optional
// personalization signal into a total chat failure for that account. The
// required behaviour is the opposite: an unusable profile is treated as no
// profile, and Elise falls back to non-profile reasoning.

/** One well-formed frequency entry: a non-empty string label and a finite,
 *  non-negative count. Anything else is not usable evidence. */
export function isStyleDnaFrequencyEntry(value: unknown): value is StyleDnaFrequencyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.value === 'string' &&
    entry.value.length > 0 &&
    typeof entry.count === 'number' &&
    Number.isFinite(entry.count) &&
    entry.count >= 0
  );
}

function isFrequencyList(value: unknown): value is StyleDnaFrequencyEntry[] {
  return Array.isArray(value) && value.every(isStyleDnaFrequencyEntry);
}

/**
 * Strict structural check for a stored `profile_data` payload.
 *
 * Deliberately total and allocation-free: it never throws, never coerces, and
 * never repairs a partially-valid payload into a "mostly fine" one. A profile
 * either matches the shape this build derives and can safely interpret, or it
 * is not a profile as far as every reader is concerned.
 */
export function isStyleDnaProfileDataV1(value: unknown): value is StyleDnaProfileDataV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (
    typeof data.evidenceCount !== 'number' ||
    !Number.isFinite(data.evidenceCount) ||
    data.evidenceCount < 0
  ) {
    return false;
  }
  return (
    isFrequencyList(data.colorFrequency) &&
    isFrequencyList(data.categoryFrequency) &&
    isFrequencyList(data.garmentTypeFrequency) &&
    isFrequencyList(data.brandFrequency) &&
    isFrequencyList(data.materialFrequency)
  );
}
