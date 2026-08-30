// Build 34 / Track B integration closure — Signature Style profile store.
//
// The only writer of public.user_style_profiles. Implements Micro-addendum F:
//
//   Signature Style requested/needed
//     -> request the zero-argument trusted recomputation RPC
//     -> database derives from auth.uid()'s live Closet evidence
//     -> database reuses a current profile or persists a new one
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
// Deliberately takes an injected client rather than importing a concrete
// Supabase SDK, so it is testable from Node without a Deno runtime.
//
// The public RPC takes no parameters. It validates auth.uid() and K+ under
// SECURITY DEFINER, reads only that actor's live non-tombstoned Closet rows,
// derives the profile/revision, and upserts it. A client can request work but
// cannot provide authoritative profile data, a revision, or another user id.

import {
  isStyleDnaProfileDataV1,
  type StyleDnaProfileRecord,
} from './styleDnaProfileTypes.ts';

export interface StyleDnaSupabaseClient {
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

/**
 * Map one persisted row, or null when its `profile_data` is not a shape this
 * build can interpret.
 *
 * `profile_data` is jsonb whose database constraints intentionally enforce only
 * an object and size bound. Even though the sole writer now derives the exact
 * shape server-side, schema drift or corrupted historical data must degrade to
 * "no profile" rather than reaching the prompt builder.
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
  failureReason?: 'profile_recompute_failed';
}

/**
 * Request the current server-authoritative Signature Style profile. The
 * database decides whether to reuse or recompute based on trusted evidence.
 */
export async function getOrRecomputeStyleDnaProfile(input: {
  supabase: StyleDnaSupabaseClient;
}): Promise<StyleDnaProfileResult> {
  const { supabase } = input;
  const result = await supabase.rpc('recompute_signature_style', {});
  if (result.error) return { ok: false, profile: null, failureReason: 'profile_recompute_failed' };

  const writtenRows = Array.isArray(result.data) ? result.data : [result.data];
  const written = writtenRows[0];
  if (!written) return { ok: false, profile: null, failureReason: 'profile_recompute_failed' };

  // The row we just wrote is re-validated on the way back for the same reason
  // the stored row is: what came back is whatever the database holds, not
  // necessarily what this module sent.
  const writtenRecord = mapProfileRow(written);
  if (!writtenRecord) return { ok: false, profile: null, failureReason: 'profile_recompute_failed' };

  return { ok: true, recomputed: written.recomputed === true, profile: writtenRecord };
}
