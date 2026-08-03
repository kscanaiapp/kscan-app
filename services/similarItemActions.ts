/**
 * State-aware action eligibility for the potential-similar-item notice.
 *
 * THE DISTINCTION THIS IMPLEMENTS
 *
 * The CONTRACT carries the full action vocabulary — all six, always. That is
 * deliberate and stays: the backend cannot know the current state of the user's
 * records (is the new scan already saved? does the existing item still exist?),
 * and a backend that guessed would be filtering choices on stale information.
 *
 * The CLIENT knows those things, so the client decides what to show. This
 * module is that decision, kept out of the view layer so the rules are
 * reviewable in one place and testable without rendering anything.
 *
 * WHY AN INELIGIBLE ACTION IS RETURNED WITH A REASON
 *
 * `evaluateSimilarItemActions` returns every action with `eligible` and, when
 * false, a `reason`. A screen can then hide it, disable it with an explanation,
 * or show it differently — and a test can assert WHY something was hidden
 * rather than just that a list got shorter. Returning a filtered array would
 * make "this action is impossible right now" indistinguishable from "someone
 * forgot to include it".
 *
 * NOTHING HERE MUTATES ANYTHING. Eligibility is a question about state, not a
 * command. Executing an action is the caller's job, and the caller is bound by
 * the rule that the whole feature rests on: nothing merges, deletes or
 * suppresses a record unless the user chose it.
 */

import type { SimilarItemAction } from './scanJourney';

export type { SimilarItemAction };

/** Everything the contract permits, in stable presentation order. */
export const ALL_SIMILAR_ITEM_ACTIONS: SimilarItemAction[] = [
  'keep_both',
  'add_to_closet',
  'keep_in_recent_scans',
  'shop_identified_product',
  'reject_new_scan',
  'delete_existing_item',
];

/**
 * What the client knows about the two records right now.
 *
 * Every field is required rather than optional. An optional field would let a
 * caller omit `existingItemExists` and silently get `delete_existing_item`
 * offered for an item that is already gone — the eligibility rules are only
 * worth anything if the state they read is complete.
 */
export type SimilarItemRecordState = {
  /** The existing Closet / Recent Scans item still exists. */
  existingItemExists: boolean;
  /** Where the existing item lives. */
  existingItemSource: 'closet' | 'recent_scan';
  /** The newly scanned item has already been saved to the Closet. */
  newItemSavedToCloset: boolean;
  /** The newly scanned item is present in Recent Scans. */
  newItemInRecentScans: boolean;
  /** Usable commerce results exist for the new scan. */
  hasCommerceCandidates: boolean;
};

export type ActionIneligibilityReason =
  | 'existing_item_missing'
  | 'already_in_closet'
  | 'already_in_recent_scans'
  | 'no_commerce_candidates'
  | 'needs_two_records';

export type ActionAvailability = {
  action: SimilarItemAction;
  eligible: boolean;
  reason?: ActionIneligibilityReason;
};

/**
 * Evaluates every action against the current record state.
 *
 * Rules, and why each one exists:
 *
 *   delete_existing_item     needs an existing saved item. Offering it for a
 *                            record that is already gone produces an error the
 *                            user cannot act on.
 *   add_to_closet            disappears once the new item is saved. A second
 *                            "add" is either a no-op or a duplicate, and the
 *                            user cannot tell which.
 *   keep_in_recent_scans     irrelevant when it is already there. Presenting it
 *                            implies a change that would not happen.
 *   shop_identified_product  needs usable commerce candidates, or the button
 *                            leads to an empty screen.
 *   keep_both                needs two distinct records to keep. With the
 *                            existing item gone there is only one.
 *   reject_new_scan          ALWAYS eligible — see below.
 */
export function evaluateSimilarItemActions(
  state: SimilarItemRecordState,
): ActionAvailability[] {
  const ineligible = (
    action: SimilarItemAction,
    reason: ActionIneligibilityReason,
  ): ActionAvailability => ({ action, eligible: false, reason });
  const eligible = (action: SimilarItemAction): ActionAvailability => ({ action, eligible: true });

  return ALL_SIMILAR_ITEM_ACTIONS.map((action) => {
    switch (action) {
      case 'delete_existing_item':
        return state.existingItemExists
          ? eligible(action)
          : ineligible(action, 'existing_item_missing');

      case 'add_to_closet':
        return state.newItemSavedToCloset
          ? ineligible(action, 'already_in_closet')
          : eligible(action);

      case 'keep_in_recent_scans':
        return state.newItemInRecentScans
          ? ineligible(action, 'already_in_recent_scans')
          : eligible(action);

      case 'shop_identified_product':
        return state.hasCommerceCandidates
          ? eligible(action)
          : ineligible(action, 'no_commerce_candidates');

      case 'keep_both':
        return state.existingItemExists
          ? eligible(action)
          : ineligible(action, 'needs_two_records');

      case 'reject_new_scan':
        // Always available, and deliberately unconditional. Discarding the
        // thing you just scanned is the user's escape hatch from a comparison
        // they consider wrong, and it must never depend on the state of the
        // OTHER record. It also, by definition, does not touch that record —
        // see `rejectNewScanTouchesExistingRecord` below.
        return eligible(action);

      default:
        return eligible(action);
    }
  });
}

/** Convenience: just the actions a screen should offer. */
export function eligibleSimilarItemActions(
  state: SimilarItemRecordState,
): SimilarItemAction[] {
  return evaluateSimilarItemActions(state)
    .filter((entry) => entry.eligible)
    .map((entry) => entry.action);
}

/**
 * The scope each action is permitted to affect.
 *
 * Exported as data so a caller — and a test — can check an intended mutation
 * against the action that authorised it, rather than trusting a handler to have
 * confined itself. `reject_new_scan` affecting the existing record is the
 * specific failure this table is written to make visible.
 */
export const ACTION_SCOPE: Record<SimilarItemAction, {
  affectsNewScan: boolean;
  affectsExistingItem: boolean;
  destructive: boolean;
}> = {
  keep_both: { affectsNewScan: false, affectsExistingItem: false, destructive: false },
  add_to_closet: { affectsNewScan: true, affectsExistingItem: false, destructive: false },
  keep_in_recent_scans: { affectsNewScan: true, affectsExistingItem: false, destructive: false },
  shop_identified_product: { affectsNewScan: false, affectsExistingItem: false, destructive: false },
  // Discards the NEW scan only. Never the existing record — that is what makes
  // it safe to offer unconditionally.
  reject_new_scan: { affectsNewScan: true, affectsExistingItem: false, destructive: true },
  // The only action permitted to touch the existing record, and only because
  // the user explicitly chose it.
  delete_existing_item: { affectsNewScan: false, affectsExistingItem: true, destructive: true },
};

/** True when an action is allowed to modify the user's existing record. */
export function actionMayTouchExistingRecord(action: SimilarItemAction): boolean {
  return ACTION_SCOPE[action]?.affectsExistingItem === true;
}

/**
 * Neutral label copy.
 *
 * Kept beside the eligibility rules on purpose. The safety property of this
 * feature is that it offers a COMPARISON rather than asserting a duplicate, and
 * that property lives as much in the wording as in the data model — a correct
 * advisory payload rendered as "Duplicate found" is still a duplicate claim.
 * None of these strings says duplicate, same, or already own.
 */
export const SIMILAR_ITEM_ACTION_LABELS: Record<SimilarItemAction, string> = {
  keep_both: 'Keep both',
  add_to_closet: 'Add to Closet',
  keep_in_recent_scans: 'Keep in Recent Scans',
  shop_identified_product: 'Shop this item',
  reject_new_scan: 'Discard this scan',
  delete_existing_item: 'Remove the saved item',
};

/** Neutral headline for the notice. Never asserts the items are the same. */
export const SIMILAR_ITEM_NOTICE_TITLE = 'This looks similar to something you have';

export const SIMILAR_ITEM_SOURCE_LABELS: Record<'closet' | 'recent_scan', string> = {
  closet: 'In your Closet',
  recent_scan: 'In Recent Scans',
};

/** Plain-language explanation for each machine reason. */
export const SIMILARITY_REASON_LABELS: Record<string, string> = {
  shared_product_url: 'Same product page',
  same_brand: 'Same brand',
  same_model_tokens: 'Same model name',
  same_normalized_color: 'Same colour',
  same_canonical_category: 'Same category',
  same_material: 'Same material',
  same_silhouette: 'Same shape',
  same_pattern: 'Same pattern',
};
