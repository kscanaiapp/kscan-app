// Receipt & Purchase Intelligence V1 — the explicit ownership write.
//
// THE ONLY PLACE A PURCHASE IMPORT CREATES OWNERSHIP, and it runs only after
// the customer tapped "Add N items to my Closet". It is the fourth documented
// call site of services/closetLibrary.js#createClosetItem (see
// __tests__/closetCorrectionAuthority.test.js "SEAM" and
// docs/closet-productization/01-closet-contract-map.md section 4).
//
//     before a successful authoritative write   OWNED = NO
//     after  a successful authoritative write   OWNED = YES
//
// PARTIAL FAILURE (spec section 20): units are written one at a time and each
// result is reported individually. Two successes and one failure are reported
// as exactly that, never as "all added".
//
// RETRY WITHOUT DUPLICATES: every unit carries a lineage id minted for this
// import session (purchaseImportReview.ts#purchaseLineageId). createClosetItem
// short-circuits a lineage it has already committed for this owner, so a retry
// that re-sends a unit which in fact succeeded returns the existing item,
// `deduped: true`, rather than creating a second one.
//
// ACTOR ISOLATION: one actor request is captured for the whole confirmation.
// If the actor changes mid-way, createClosetItem rejects the remaining writes
// (`stale_actor_context`) and this module stops and reports the change.

import { createClosetItem } from '../closetLibrary';
import { noteClosetItemSaved } from '../closet/closetSyncCoordinator';
import type { PurchaseClosetDraft } from './purchaseImportReview';

export type ActorRequest = { actorId: string | null; epoch: number; requestId: string };

export type UnitCommitOutcome =
  | { sourceLineageId: string; lineIndex: number; status: 'added'; itemId: string }
  | { sourceLineageId: string; lineIndex: number; status: 'already_added'; itemId: string }
  | { sourceLineageId: string; lineIndex: number; status: 'failed'; reason: string }
  | { sourceLineageId: string; lineIndex: number; status: 'not_attempted' };

export type CommitResult = {
  outcomes: UnitCommitOutcome[];
  addedCount: number;
  failedCount: number;
  /** True when the actor changed and the remaining writes were not made. */
  actorChanged: boolean;
};

type CreateFn = typeof createClosetItem;

export type CommitDeps = {
  create?: CreateFn;
  noteSaved?: (ownerId: string | null, clientId: string) => Promise<void>;
};

/** services/actorContext.js#resolveWriteAuthority reasons that mean "not this actor any more". */
const STALE_REASONS = new Set([
  'stale_actor_context',
  'missing_actor_context',
  'owner_mismatch',
  'ownerless_context_declared_owner',
]);

/**
 * Write each draft through the ownership authority.
 *
 * `photos` maps a line index to the garment photo the customer chose for it,
 * if any. A line without a photo is committed without media, which only the
 * `purchase_import` origin permits.
 */
export async function commitPurchaseDrafts(
  drafts: readonly PurchaseClosetDraft[],
  {
    actorRequest,
    ownerId,
    photos,
  }: { actorRequest: ActorRequest; ownerId: string | null; photos: ReadonlyMap<number, string> },
  deps: CommitDeps = {},
): Promise<CommitResult> {
  const create = deps.create ?? createClosetItem;
  const noteSaved = deps.noteSaved ?? noteClosetItemSaved;
  const outcomes: UnitCommitOutcome[] = [];
  let actorChanged = false;

  for (const unit of drafts) {
    if (actorChanged) {
      outcomes.push({ sourceLineageId: unit.sourceLineageId, lineIndex: unit.lineIndex, status: 'not_attempted' });
      continue;
    }
    let result: Awaited<ReturnType<CreateFn>>;
    try {
      result = await create({
        sourceUri: photos.get(unit.lineIndex) ?? (null as unknown as string),
        draft: unit.draft,
        actorRequest,
        ownerId,
      });
    } catch {
      result = { ok: false, reason: 'unexpected_error' } as Awaited<ReturnType<CreateFn>>;
    }

    if (result && (result as { ok?: boolean }).ok) {
      const { item, deduped } = result as { item: { id: string }; deduped: boolean };
      outcomes.push({
        sourceLineageId: unit.sourceLineageId,
        lineIndex: unit.lineIndex,
        status: deduped ? 'already_added' : 'added',
        itemId: item.id,
      });
      if (!deduped) {
        // Cloud sync is started after the local commit and never awaited: the
        // local write is the ownership fact, and a slow network must not hold it.
        void noteSaved(ownerId, item.id).catch(() => undefined);
      }
      continue;
    }

    const reason = String((result as { reason?: unknown })?.reason ?? 'unexpected_error');
    if (STALE_REASONS.has(reason)) actorChanged = true;
    outcomes.push({ sourceLineageId: unit.sourceLineageId, lineIndex: unit.lineIndex, status: 'failed', reason });
  }

  return {
    outcomes,
    addedCount: outcomes.filter((o) => o.status === 'added' || o.status === 'already_added').length,
    failedCount: outcomes.filter((o) => o.status === 'failed' || o.status === 'not_attempted').length,
    actorChanged,
  };
}

/** Drafts whose last outcome was not a success, for a retry that cannot duplicate. */
export function draftsToRetry(
  drafts: readonly PurchaseClosetDraft[],
  previous: CommitResult,
): PurchaseClosetDraft[] {
  const done = new Set(
    previous.outcomes
      .filter((o) => o.status === 'added' || o.status === 'already_added')
      .map((o) => o.sourceLineageId),
  );
  return drafts.filter((d) => !done.has(d.sourceLineageId));
}
