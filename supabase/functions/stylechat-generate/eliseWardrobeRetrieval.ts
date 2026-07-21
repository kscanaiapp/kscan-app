/**
 * E-4 actor-authorized wardrobe retrieval.
 * Client IDs never establish access; unauthorized rows are rejected.
 */

import { isUuid } from './eliseResourceResolvers.ts';
import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import type {
  EliseActorRelationship,
  EliseAdviceIntent,
  EliseWardrobeCandidate,
  EliseWardrobeSourceType,
} from './eliseAdviceTypes.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';
import { intentAllowsCommerce, intentNeedsShared, intentPrefersOwned } from './eliseAdviceIntents.ts';

export type EliseWardrobeDataSource = {
  listSavedScans(actorId: string, limit: number): Promise<Record<string, unknown>[]>;
  listInspirationItems(actorId: string, limit: number): Promise<Record<string, unknown>[]>;
  listOwnedRoomItems(actorId: string, limit: number): Promise<Record<string, unknown>[]>;
  listSharedRoomItems?(
    actorId: string,
    limit: number,
  ): Promise<Array<Record<string, unknown> & { room_id?: string }>>;
};

export interface EliseWardrobeRetrievalResult {
  candidates: EliseWardrobeCandidate[];
  authorizedCount: number;
  rejectedCount: number;
  countsBySource: Record<string, number>;
  ownershipSourceCounts: Record<string, number>;
  retrievalLatencyMs: number;
  partialFailure: boolean;
}

function ownerMatches(row: Record<string, unknown>, actorId: string): boolean {
  const owner =
    (typeof row.user_id === 'string' && row.user_id) ||
    (typeof row.owner_id === 'string' && row.owner_id) ||
    null;
  return owner === actorId;
}

/**
 * A room item being in the actor's own Dressing Room does not by itself mean
 * the actor physically owns the garment — it may be a saved/bookmarked
 * catalog product (DR-1 `source_type: 'product_match'` /
 * canonical `source.kind: 'catalog_product'`) the actor is only considering.
 * Only genuinely Scanner/Closet-originated items are truthfully "owned."
 * Consults DR-1's canonical snapshot extension when present (forward
 * compatible with DRESSING_ROOM_CANONICAL_ITEM_V1), falling back to the
 * legacy `source_type` column that exists on every row today.
 */
const DISCOVERED_ROOM_SOURCE_KINDS = new Set(['catalog_product', 'product_match']);

function roomItemRelationship(row: Record<string, unknown>): {
  sourceType: EliseWardrobeSourceType;
  actorRelationship: EliseActorRelationship;
} {
  const payload =
    row.snapshot_payload && typeof row.snapshot_payload === 'object' && !Array.isArray(row.snapshot_payload)
      ? (row.snapshot_payload as Record<string, unknown>)
      : {};
  const canonical =
    payload.canonical && typeof payload.canonical === 'object' && !Array.isArray(payload.canonical)
      ? (payload.canonical as Record<string, unknown>)
      : null;
  const canonicalSource =
    canonical && canonical.source && typeof canonical.source === 'object' && !Array.isArray(canonical.source)
      ? (canonical.source as Record<string, unknown>)
      : null;
  const canonicalKind = typeof canonicalSource?.kind === 'string' ? canonicalSource.kind : null;
  const legacyKind = typeof row.source_type === 'string' ? row.source_type : null;
  const kind = canonicalKind ?? legacyKind;

  if (kind && DISCOVERED_ROOM_SOURCE_KINDS.has(kind)) {
    return { sourceType: 'saved_product', actorRelationship: 'saved' };
  }
  return { sourceType: 'owned_room', actorRelationship: 'owned' };
}

function pushCount(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

export async function retrieveAuthorizedWardrobeCandidates(input: {
  actorId: string;
  intent: EliseAdviceIntent;
  message: string;
  data: EliseWardrobeDataSource;
  includeShared?: boolean;
}): Promise<EliseWardrobeRetrievalResult> {
  const started = Date.now();
  const limit = ELISE_ADVICE_LIMITS.initialCandidatesPerSource;
  const countsBySource: Record<string, number> = {};
  const ownershipSourceCounts: Record<string, number> = {};
  const candidates: EliseWardrobeCandidate[] = [];
  let authorizedCount = 0;
  let rejectedCount = 0;
  let partialFailure = false;

  const preferOwned = intentPrefersOwned(input.intent);
  const allowCommerce = intentAllowsCommerce(input.intent, input.message);
  const needShared = input.includeShared ?? intentNeedsShared(input.intent, input.message);

  const tasks: Array<Promise<void>> = [];

  tasks.push(
    (async () => {
      try {
        const rows = await input.data.listSavedScans(input.actorId, limit);
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id : null;
          if (!id || !isUuid(id)) {
            rejectedCount += 1;
            continue;
          }
          if (!ownerMatches(row, input.actorId)) {
            rejectedCount += 1;
            continue;
          }
          const candidate = normalizeWardrobeCandidate({
            candidateId: `saved_scan:${id}`,
            sourceType: 'saved_scan',
            actorRelationship: 'scanned',
            row,
            canonicalResourceIds: { scanId: id, itemId: id },
          });
          // Saved scans that are closet-backed are owned when marked or default owned for actor.
          candidate.actorRelationship = 'owned';
          candidate.sourceType = 'closet';
          candidates.push(candidate);
          authorizedCount += 1;
          pushCount(countsBySource, 'closet');
          pushCount(ownershipSourceCounts, 'owned');
        }
      } catch {
        partialFailure = true;
      }
    })(),
  );

  tasks.push(
    (async () => {
      try {
        const rows = await input.data.listInspirationItems(input.actorId, limit);
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id : null;
          if (!id || !isUuid(id)) {
            rejectedCount += 1;
            continue;
          }
          if (!ownerMatches(row, input.actorId)) {
            rejectedCount += 1;
            continue;
          }
          const candidate = normalizeWardrobeCandidate({
            candidateId: `inspiration:${id}`,
            sourceType: 'inspiration',
            actorRelationship: 'saved',
            row,
            canonicalResourceIds: { inspirationId: id, itemId: id },
          });
          candidates.push(candidate);
          authorizedCount += 1;
          pushCount(countsBySource, 'inspiration');
          pushCount(ownershipSourceCounts, 'saved');
        }
      } catch {
        partialFailure = true;
      }
    })(),
  );

  tasks.push(
    (async () => {
      try {
        const rows = await input.data.listOwnedRoomItems(input.actorId, limit);
        for (const row of rows) {
          const id = typeof row.id === 'string' ? row.id : null;
          const roomId = typeof row.room_id === 'string' ? row.room_id : null;
          if (!id || !isUuid(id)) {
            rejectedCount += 1;
            continue;
          }
          // Owned room query must already be actor-scoped by the data source.
          if (row.__authorized !== true && !ownerMatches(row, input.actorId) && row.__room_owner !== true) {
            // Accept rows explicitly marked by data source as room-owned.
            if (row.__room_owned_by_actor !== true) {
              rejectedCount += 1;
              continue;
            }
          }
          const relationship = roomItemRelationship(row);
          const candidate = normalizeWardrobeCandidate({
            candidateId: `owned_room:${id}`,
            sourceType: relationship.sourceType,
            actorRelationship: relationship.actorRelationship,
            row,
            canonicalResourceIds: {
              itemId: id,
              roomId: roomId ?? undefined,
            },
          });
          candidates.push(candidate);
          authorizedCount += 1;
          pushCount(countsBySource, relationship.sourceType);
          pushCount(ownershipSourceCounts, relationship.actorRelationship);
        }
      } catch {
        partialFailure = true;
      }
    })(),
  );

  if (needShared && input.data.listSharedRoomItems) {
    tasks.push(
      (async () => {
        try {
          const rows = await input.data.listSharedRoomItems!(input.actorId, Math.min(limit, 20));
          for (const row of rows) {
            const id = typeof row.id === 'string' ? row.id : null;
            if (!id || !isUuid(id) || row.__shared_access !== true) {
              rejectedCount += 1;
              continue;
            }
            const candidate = normalizeWardrobeCandidate({
              candidateId: `shared_room:${id}`,
              sourceType: 'shared_room',
              actorRelationship: 'shared',
              row,
              canonicalResourceIds: {
                itemId: id,
                roomId: typeof row.room_id === 'string' ? row.room_id : undefined,
              },
            });
            candidates.push(candidate);
            authorizedCount += 1;
            pushCount(countsBySource, 'shared_room');
            pushCount(ownershipSourceCounts, 'shared');
          }
        } catch {
          partialFailure = true;
        }
      })(),
    );
  }

  await Promise.all(tasks);

  // Deterministic ordering: owned → saved → scanned → shared → discovered
  const priority = (c: EliseWardrobeCandidate): number => {
    switch (c.actorRelationship) {
      case 'owned':
        return 0;
      case 'saved':
        return preferOwned ? 1 : 0;
      case 'scanned':
        return 2;
      case 'shared':
        return 3;
      case 'discovered':
        return allowCommerce ? 4 : 9;
      default:
        return 8;
    }
  };

  let filtered = candidates;
  if (!allowCommerce) {
    filtered = filtered.filter((c) => c.actorRelationship !== 'discovered');
  }

  filtered.sort((a, b) => priority(a) - priority(b));
  const bounded = filtered.slice(0, ELISE_ADVICE_LIMITS.rankedCandidates);

  return {
    candidates: bounded,
    authorizedCount,
    rejectedCount,
    countsBySource,
    ownershipSourceCounts,
    retrievalLatencyMs: Date.now() - started,
    partialFailure,
  };
}
