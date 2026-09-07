// Closet Ownership V1 — the review queue, as DERIVED state (PR A2, sections 48-51).
//
// WHAT THIS IS: a pure function from (items, sync entries) to "which items could
// use a quick review, and why".
//
// WHAT IT IS NOT, and the invariant section 48 exists to protect:
//
//     review queue  !=  a table
//     review queue  !=  a task system
//     review queue  !=  a notification system
//     review queue  !=  a queue backend
//
// There is no review store. Nothing is enqueued, nothing is marked read, nothing
// is dismissed. An item is in review because a CONDITION on it is true right
// now; fix the condition and it leaves, with no state anywhere remembering it
// was ever there. That is also why there is no Dismiss button (DM-03): derived
// state cannot remember a dismissal, and inventing somewhere for it to live
// would create exactly the durable per-item, per-actor data class section 48
// says not to build.
//
// STABILITY (section 51). Reasons are computed only from settled facts — the
// item as the store returned it, and a sidecar entry's terminal condition. A
// pass that is mid-restore contributes nothing, so the list cannot flicker
// between NEEDS REVIEW and COMPLETE while reconciliation is still running.

import type { ClosetItemProjection } from '../closetItemProjection';
import type { ClosetSyncEntry } from './closetSyncContract';

export const CLOSET_REVIEW_CONTRACT_VERSION = 1;

/**
 * Why one item is reviewable. A CLOSED, small vocabulary.
 *
 * Deliberately does NOT include "missing brand", "missing colour", "missing
 * size" and the rest. The coverage audit (docs/closet-productization/02) shows
 * two of the three shipping intake paths populate none of those fields, so
 * flagging them would put most of a Closet into review for something the
 * pipeline never captured — turning the wardrobe into a chore list and burying
 * the two conditions a user can actually act on. Those gaps are an upstream
 * metadata finding, not a user task.
 */
export const CLOSET_REVIEW_REASONS = [
  /** No category: the item cannot be grouped, filtered or counted by kind. */
  'missing_category',
  /** Title is the store's placeholder, so the card has no real name. */
  'placeholder_name',
  /** The cloud copy diverged and a human has to decide. */
  'sync_conflict',
  /** The cloud refused this item's image, permanently. */
  'media_blocked',
] as const;
export type ClosetReviewReason = (typeof CLOSET_REVIEW_REASONS)[number];

/** The placeholder `buildClosetRecord` writes when a draft carries no title. */
export const CLOSET_PLACEHOLDER_TITLE = 'Closet item';

export const CLOSET_REVIEW_REASON_LABELS: Readonly<Record<ClosetReviewReason, string>> =
  Object.freeze({
    missing_category: 'Add a category',
    placeholder_name: 'Give this item a name',
    sync_conflict: 'This item changed on another device',
    media_blocked: "This item's photo stays on this device",
  });

export type ClosetReviewItem = {
  id: string;
  title: string;
  /** Every reason true for this item, in CLOSET_REVIEW_REASONS order. */
  reasons: readonly ClosetReviewReason[];
};

export type ClosetReviewSummary = {
  contractVersion: typeof CLOSET_REVIEW_CONTRACT_VERSION;
  items: readonly ClosetReviewItem[];
  count: number;
  totalItems: number;
  /**
   * Section 50's volume guard.
   *
   * True when the reviewable set is large enough that listing it item-by-item on
   * Closet Home would be nagging rather than helping. The dedicated list still
   * shows the truthful count either way — this only changes how HOME presents it.
   */
  coalesced: boolean;
  /** The one line Closet Home shows. Null when there is nothing to say. */
  homeMessage: string | null;
};

/** Section 50's thresholds, named once. */
export const CLOSET_REVIEW_COALESCE_RATIO = 0.2;
export const CLOSET_REVIEW_COALESCE_COUNT = 10;

function reasonsFor(
  item: ClosetItemProjection,
  entry: ClosetSyncEntry | null | undefined,
): ClosetReviewReason[] {
  const reasons: ClosetReviewReason[] = [];

  const category = typeof item.category === 'string' ? item.category.trim() : '';
  if (!category) reasons.push('missing_category');

  // Only the store's own placeholder counts. A user who deliberately named
  // something "Closet item" has named it, and second-guessing that would make
  // the condition unfixable — they would retype the same words and stay flagged.
  // The comparison is exact, not case-insensitive, for the same reason.
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!title || title === CLOSET_PLACEHOLDER_TITLE) reasons.push('placeholder_name');

  if (entry) {
    // A conflict is terminal until a human resolves it. `retryable` and
    // `unexpected_authorization` are NOT reviewable: they retry themselves, and
    // asking the user to look at an item the engine is about to fix on its own
    // is how a review queue loses its meaning.
    if (entry.lastFailureClass === 'conflict') reasons.push('sync_conflict');
    if (entry.mediaState === 'blocked') reasons.push('media_blocked');
  }

  return reasons;
}

/**
 * Derive the review set.
 *
 * Ordering is deterministic: reviewable items keep the order they were given
 * (the caller has already sorted them), and each item's reasons are emitted in
 * CLOSET_REVIEW_REASONS order rather than discovery order, so the same Closet
 * produces the same list every time.
 */
export function deriveClosetReview(
  items: readonly ClosetItemProjection[] | null | undefined,
  syncEntries: Readonly<Record<string, ClosetSyncEntry>> = {},
): ClosetReviewSummary {
  const source = Array.isArray(items) ? items.filter(Boolean) : [];
  const entries = syncEntries ?? {};

  const reviewable: ClosetReviewItem[] = [];
  for (const item of source) {
    const reasons = reasonsFor(item, entries[item.id]);
    if (reasons.length === 0) continue;
    reviewable.push({ id: item.id, title: item.title, reasons });
  }

  const count = reviewable.length;
  const totalItems = source.length;

  // Either threshold trips it. The ratio catches a small Closet that is mostly
  // unclassified; the absolute count catches a large one where 15% is still
  // fifteen separate nags.
  const coalesced =
    count > CLOSET_REVIEW_COALESCE_COUNT ||
    (totalItems > 0 && count / totalItems > CLOSET_REVIEW_COALESCE_RATIO);

  let homeMessage: string | null = null;
  if (count > 0) {
    homeMessage = coalesced
      ? 'Some items could use a quick review.'
      : count === 1
        ? '1 item could use a quick review.'
        : `${count} items could use a quick review.`;
  }

  return {
    contractVersion: CLOSET_REVIEW_CONTRACT_VERSION,
    items: reviewable,
    count,
    totalItems,
    coalesced,
    homeMessage,
  };
}
