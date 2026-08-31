// K+ Packing Intelligence V1 — authoritative Closet retrieval.
//
// ONE SOURCE, DELIBERATELY. Packing reads public.user_closet_items and nothing
// else. It does NOT reuse retrieveAuthorizedWardrobeCandidates, which merges
// saved scans, inspiration items and Dressing Room rows: those are things the
// traveller photographed, saved or was shown, and Packing may never describe
// any of them as owned. Narrowing the source is what makes "100% of rendered
// owned items resolve to authoritative Closet evidence" true by construction
// rather than by a downstream filter someone could forget.
//
// THREE INDEPENDENT GUARANTEES, none of which trusts the client:
//   - identity   : actorId comes from the verified JWT, never the request body
//   - ownership  : .eq('user_id', actorId) plus RLS's own user_id = auth.uid()
//   - K+         : RLS on user_closet_items requires has_active_k_plus(), so an
//                  expired entitlement returns zero rows even if every gate
//                  above it were bypassed
//
// The row shape is normalized through the SHARED normalizeWardrobeCandidate so
// Packing and Elise describe the same garment with the same vocabulary.

import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import { PACKING_LIMITS } from './packingContract.ts';

/**
 * A Closet candidate carrying the LOCAL record id alongside the cloud id.
 *
 * The client renders a packed item using the traveller's own photograph, which
 * lives in the device-local Closet (services/closetLibrary.js) and is keyed by
 * that local id -- user_closet_items.client_id is the same value. Carrying it
 * means no image ever has to reach the model or cross the wire to make a card
 * render: the plan references identity, the device supplies the picture.
 */
export type PackingCandidate = EliseWardrobeCandidate & {
  closetClientId: string | null;
};

export interface PackingClosetDataSource {
  listClosetItems(actorId: string, limit: number): Promise<Record<string, unknown>[]>;
}

export interface PackingRetrievalResult {
  candidates: PackingCandidate[];
  /** Rows returned by the query that survived every ownership/identity check. */
  authorizedCount: number;
  /** Rows rejected: unusable id, or an owner that is not the actor. */
  rejectedCount: number;
  retrievalLatencyMs: number;
  /** True when the query itself failed. Distinct from "the Closet is empty". */
  failed: boolean;
  /**
   * False when the query came back full, i.e. the Closet may hold garments this
   * retrieval never saw.
   *
   * THIS IS THE DIFFERENCE BETWEEN "you own no shoes" AND "I did not see all of
   * your Closet". The census the gap engine and the scarcity signals are built
   * from is only as complete as this retrieval, and both of those make ABSENCE
   * claims about the traveller's own property. When this is false, no absence
   * may be asserted -- the same discipline `failed` already applies to a Closet
   * that could not be read at all.
   */
  censusComplete: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function retrievePackingClosetCandidates(input: {
  actorId: string;
  data: PackingClosetDataSource;
  limit?: number;
}): Promise<PackingRetrievalResult> {
  const started = Date.now();
  const limit = Math.min(input.limit ?? PACKING_LIMITS.maxClosetCandidates, PACKING_LIMITS.maxClosetCandidates);
  const candidates: PackingCandidate[] = [];
  let authorizedCount = 0;
  let rejectedCount = 0;

  let rows: Record<string, unknown>[];
  try {
    rows = await input.data.listClosetItems(input.actorId, limit);
  } catch {
    return {
      candidates: [],
      authorizedCount: 0,
      rejectedCount: 0,
      retrievalLatencyMs: Date.now() - started,
      failed: true,
      censusComplete: false,
    };
  }

  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : null;
    if (!id || !UUID_RE.test(id)) {
      rejectedCount += 1;
      continue;
    }
    // Belt and braces over RLS. A row whose user_id is not this actor is a bug
    // or an attack; either way it is not this traveller's clothing.
    if (row.user_id !== input.actorId) {
      rejectedCount += 1;
      continue;
    }
    // A tombstoned row is not in the Closet any more. The query already filters
    // these; re-checking here means a caller that forgets the filter cannot
    // pack a deleted garment.
    if (row.deleted_at != null) {
      rejectedCount += 1;
      continue;
    }

    const clothingType = typeof row.clothing_type === 'string' ? row.clothing_type : null;
    const subtype = typeof row.subtype === 'string' ? row.subtype : null;
    const category = typeof row.category === 'string' ? row.category : null;

    const base = normalizeWardrobeCandidate({
      candidateId: `closet:${id}`,
      sourceType: 'closet',
      actorRelationship: 'owned',
      row: {
        ...row,
        // normalizeWardrobeCandidate reads a top-level `category` and takes
        // `subcategory` only from snapshot_payload. Prefer the specific garment
        // type ("chore jacket") over the broad bucket ("Outerwear") for the
        // category, and hand it the subtype through the shape it already reads,
        // so the Closet's third taxonomy level is not silently lost.
        category: clothingType ?? category,
        color: [
          ...(typeof row.primary_color === 'string' ? [row.primary_color] : []),
          ...(Array.isArray(row.secondary_colors) ? row.secondary_colors : []),
        ],
        snapshot_payload: subtype ? { subcategory: subtype } : undefined,
      },
      canonicalResourceIds: { itemId: id },
    });

    candidates.push({
      ...base,
      closetClientId: typeof row.client_id === 'string' ? row.client_id.slice(0, 200) : null,
    });
    authorizedCount += 1;
  }

  return {
    candidates,
    authorizedCount,
    rejectedCount,
    retrievalLatencyMs: Date.now() - started,
    failed: false,
    // A full page back means there is probably more Closet behind it. Assume
    // incomplete rather than assume we saw everything: guessing wrong in this
    // direction only costs a suppressed gap, guessing wrong the other way tells
    // someone they do not own a coat they are wearing.
    censusComplete: rows.length < limit,
  };
}
