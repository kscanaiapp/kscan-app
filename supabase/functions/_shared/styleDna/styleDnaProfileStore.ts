// Build 34 / Track B / Phase B4 — Style DNA profile store (read-or-recompute).
//
// The only writer of public.user_style_profiles. Implements Micro-addendum F:
//
//   Style DNA requested/needed
//     -> compute current evidence revision cheaply (one bounded select)
//     -> compare to stored evidence revision
//     -> same       -> reuse existing profile, no write
//     -> different  -> recompute once, persist new revision/profile
//
// This naturally debounces a batch of Closet writes (e.g. a B3 migration
// pass) without a timer: the evidence revision only needs to be checked
// against whatever the source Closet looks like at the moment a caller (B5)
// actually asks, never against every intermediate mutation.
//
// NO CRON, NO WORKER, NO PER-ITEM RECOMPUTE. This module is called from
// within a request (stylechat-generate), exactly like closetSyncEngine.ts's
// "no background scheduler" discipline on the client side.
//
// THIS MODULE NEVER TRUSTS THE CALLING CLIENT FOR `userId`. Every caller is
// expected to have already resolved `userId` from a verified JWT, the same
// discipline every other Track B server module in this repository follows.
//
// Deliberately takes an injected client rather than importing a concrete
// Supabase SDK, so it is testable from Node without a Deno runtime.
//
// READS go straight through the caller's own JWT-scoped client: RLS already
// restricts both `user_closet_items` (owner + active K+) and
// `user_style_profiles` (owner only) to exactly the caller's own rows, so an
// ordinary authenticated client is the correct and sufficient authority.
//
// THE WRITE goes through public.upsert_style_dna_profile(), a SECURITY
// DEFINER RPC (see the B5 migration) -- the same pattern
// public.has_active_k_plus() and public.grant_kplus_early_access() already
// established. user_style_profiles intentionally grants no direct INSERT/
// UPDATE to `authenticated` (Micro-addendum N: the client is never the
// personalization write authority); the RPC derives the caller's identity
// from auth.uid() itself, so no argument can ever forge another user's
// profile write, and this module never needs a raw service-role key.

import {
  computeClosetEvidenceRevision,
  STYLE_DNA_EMPTY_EVIDENCE_REVISION,
} from './styleDnaEvidenceRevision.ts';
import { deriveStyleDnaProfile } from './styleDnaProfileDerivation.ts';
import {
  STYLE_DNA_PROFILE_VERSION,
  isStyleDnaProfileDataV1,
  type StyleDnaClosetFactsRow,
  type StyleDnaProfileRecord,
} from './styleDnaProfileTypes.ts';

const CLOSET_TABLE = 'user_closet_items';
const PROFILE_TABLE = 'user_style_profiles';
const CLOSET_FACTS_COLUMNS = 'updated_at,category,clothing_type,brand,primary_color,secondary_colors,material';

/** The minimal query-builder surface this module needs. Matches the real
 *  @supabase/supabase-js chainable shape closely enough that the real client
 *  satisfies this interface unmodified. */
export interface StyleDnaSupabaseClient {
  from(table: string): {
    select: (columns: string) => any;
  };
  /**
   * Supabase `.rpc()` returns a thenable PostgrestFilterBuilder, NOT a full
   * Promise (it has no `.catch`, `.finally`, or `[Symbol.toStringTag]`).
   * Declaring `Promise` here made a real SupabaseClient fail to satisfy this
   * interface, so `deno check` on stylechat-generate/index.ts reported TS2322
   * at the call site. `PromiseLike` is the shape the repository already
   * settled on for exactly this quirk — see generationSafety.ts's
   * GenerationRpcClient — and `await` behaves identically.
   */
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }>;
}

function mapClosetRow(raw: Record<string, any>): StyleDnaClosetFactsRow {
  return {
    updatedAt: raw.updated_at,
    category: raw.category ?? null,
    clothingType: raw.clothing_type ?? null,
    brand: raw.brand ?? null,
    primaryColor: raw.primary_color ?? null,
    secondaryColors: Array.isArray(raw.secondary_colors) ? raw.secondary_colors : null,
    material: Array.isArray(raw.material) ? raw.material : null,
  };
}

/**
 * Map one persisted row, or null when its `profile_data` is not a shape this
 * build can interpret.
 *
 * `profile_data` is jsonb whose only DB constraints are "object" and "<= 64
 * KiB"; its write path (public.upsert_style_dna_profile) takes the payload as
 * a parameter. A stored row is therefore validated here rather than trusted,
 * so a malformed/foreign-shaped payload degrades to "no profile" -- which the
 * caller already handles by recomputing from the real Closet evidence -- and
 * can never reach the prompt builder.
 */
function mapProfileRow(raw: Record<string, any>): StyleDnaProfileRecord | null {
  if (!isStyleDnaProfileDataV1(raw?.profile_data)) return null;
  return {
    userId: raw.user_id,
    profileVersion: raw.profile_version,
    evidenceRevision: raw.evidence_revision,
    derivedAt: raw.derived_at,
    profileData: raw.profile_data,
  };
}

export interface StyleDnaProfileResult {
  ok: boolean;
  profile: StyleDnaProfileRecord | null;
  /** True when this call actually recomputed and persisted a new profile,
   *  false when the stored profile was reused unchanged. Absent on failure. */
  recomputed?: boolean;
  /** Present only on failure. Never includes raw error detail — see
   *  services/closetTelemetry.ts's own discipline for the same reasoning. */
  failureReason?: 'closet_read_failed' | 'profile_read_failed' | 'profile_write_failed';
}

/**
 * Read the current authoritative Style DNA profile for one user, recomputing
 * it first if the underlying Closet evidence has changed since it was last
 * derived.
 */
export async function getOrRecomputeStyleDnaProfile(input: {
  supabase: StyleDnaSupabaseClient;
  userId: string;
}): Promise<StyleDnaProfileResult> {
  const { supabase, userId } = input;

  const closetResult = await supabase
    .from(CLOSET_TABLE)
    .select(CLOSET_FACTS_COLUMNS)
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (closetResult.error) return { ok: false, profile: null, failureReason: 'closet_read_failed' };

  const closetRows: Record<string, any>[] = Array.isArray(closetResult.data) ? closetResult.data : [];
  const evidenceRevision = computeClosetEvidenceRevision(closetRows.map((r) => r.updated_at));

  const existingResult = await supabase
    .from(PROFILE_TABLE)
    .select('user_id,profile_version,evidence_revision,derived_at,profile_data')
    .eq('user_id', userId)
    .maybeSingle();
  if (existingResult.error) return { ok: false, profile: null, failureReason: 'profile_read_failed' };

  const existing = existingResult.data ? mapProfileRow(existingResult.data) : null;
  if (
    existing &&
    existing.profileVersion === STYLE_DNA_PROFILE_VERSION &&
    existing.evidenceRevision === evidenceRevision
  ) {
    // Same evidence -> same profile (Micro-addendum F). No write.
    return { ok: true, profile: existing, recomputed: false };
  }

  const profileData = deriveStyleDnaProfile(closetRows.map(mapClosetRow));
  const writeResult = await supabase.rpc('upsert_style_dna_profile', {
    p_profile_version: STYLE_DNA_PROFILE_VERSION,
    p_evidence_revision: evidenceRevision,
    p_profile_data: profileData,
  });
  if (writeResult.error) return { ok: false, profile: null, failureReason: 'profile_write_failed' };

  const writtenRows = Array.isArray(writeResult.data) ? writeResult.data : [writeResult.data];
  const written = writtenRows[0];
  if (!written) return { ok: false, profile: null, failureReason: 'profile_write_failed' };

  // The row we just wrote is re-validated on the way back for the same reason
  // the stored row is: what came back is whatever the database holds, not
  // necessarily what this module sent.
  const writtenRecord = mapProfileRow(written);
  if (!writtenRecord) return { ok: false, profile: null, failureReason: 'profile_write_failed' };

  return { ok: true, recomputed: true, profile: writtenRecord };
}

export { STYLE_DNA_EMPTY_EVIDENCE_REVISION };
