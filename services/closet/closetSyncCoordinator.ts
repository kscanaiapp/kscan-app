// Build 34 / Track B / Phase B2B — local-mutation ↔ cloud-sync coordination.
//
// The seam between the certified local Closet store (services/closetLibrary.js,
// untouched by B2B) and the cloud sync engine. It exists so the UI layer never
// has to know the ordering rules below, and so those rules are testable without
// a React tree.
//
// THE ORDERING RULES, and why each one is the way round it is:
//
//   CREATE / EDIT — local first, then mark.
//     The local write is the user's actual outcome and must never be delayed,
//     conditioned, or rolled back by cloud state. Marking after it means a
//     crash between the two leaves an item that is simply local-only, which is
//     a correct resting state, not a corrupt one.
//
//   DELETE — mark first, then local delete.
//     The opposite order, for a specific reason: closetLibrary#deleteClosetItem
//     is a HARD delete. Marking afterwards would mean a crash in between
//     destroys the only evidence that a synced cloud row still needs a
//     tombstone, and B2B would never learn the item had been deleted. Marking
//     first makes the worst case a pending_delete for an item that is still
//     present locally — which the revert below undoes, and which a discovery
//     pass would otherwise resolve harmlessly.
//
// NOTHING HERE THROWS. Every function degrades to "no cloud sync for this
// item", never to a failed local operation.

import {
  getClosetSyncEntry,
  markClosetItemPendingDelete,
  updateClosetSyncEntry,
} from './closetSyncStore';
import {
  isClosetCloudSyncEligible,
  markClosetItemForSync,
  runClosetSyncPass,
} from './closetSyncEngine';
import type { ClosetSyncEntry } from './closetSyncContract';

/**
 * Call after a local create or edit has ALREADY succeeded.
 *
 * Fire-and-forget by design: the returned promise is for tests and for callers
 * that genuinely want to await a pass. A UI caller should not await it, because
 * the local operation is already complete and the user is already done.
 */
export async function noteClosetItemSaved(ownerId: string | null, clientId: string): Promise<void> {
  if (!isClosetCloudSyncEligible()) return;
  try {
    await markClosetItemForSync(ownerId, clientId);
    await runClosetSyncPass({ reason: 'item_saved' });
  } catch {
    /* cloud sync never affects the local outcome */
  }
}

/**
 * Capture delete evidence BEFORE the local hard delete removes the record.
 *
 * Returns the entry as it was, so a failed local delete can be reverted. A
 * never-synced item returns null and needs no cloud work at all.
 */
export async function beforeClosetItemDeleted(
  ownerId: string | null,
  clientId: string,
): Promise<ClosetSyncEntry | null> {
  try {
    const previous = await getClosetSyncEntry(ownerId, clientId);
    await markClosetItemPendingDelete(ownerId, clientId);
    return previous;
  } catch {
    return null;
  }
}

/**
 * Undo the pending_delete written by beforeClosetItemDeleted when the local
 * delete did not actually happen. Without this a refused local delete would
 * leave the cloud row scheduled for a tombstone the user never asked for.
 */
export async function revertClosetItemDeleteMark(
  ownerId: string | null,
  clientId: string,
  previous: ClosetSyncEntry | null,
): Promise<void> {
  try {
    await updateClosetSyncEntry(ownerId, clientId, () => previous);
  } catch {
    /* best effort */
  }
}

/** Call after a local delete has succeeded, to push the cloud tombstone. */
export async function afterClosetItemDeleted(): Promise<void> {
  if (!isClosetCloudSyncEligible()) return;
  try {
    await runClosetSyncPass({ reason: 'item_deleted' });
  } catch {
    /* best effort */
  }
}

/**
 * Opportunistic trigger for Closet-open and app-foreground.
 *
 * Safe to call as often as a caller likes: the engine is single-flight, so
 * overlapping triggers join one pass rather than starting several.
 */
export async function resumeClosetSync(reason: string): Promise<void> {
  if (!isClosetCloudSyncEligible()) return;
  try {
    await runClosetSyncPass({ reason });
  } catch {
    /* best effort */
  }
}
