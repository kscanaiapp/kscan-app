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
  /**
   * The existing record is archived / soft-deleted — still on file, but the
   * user has already put it out of sight.
   *
   * Distinct from `existingItemExists: false`, and the distinction matters:
   * a soft-deleted record CAN still be hard-deleted (so the row is not simply
   * absent), but re-deleting something the user has already dismissed is
   * almost never what they meant, and `keep_both` is misleading when one of
   * the two is already archived. Optional so that callers written before this
   * field keep compiling; treated as `false` when omitted.
   */
  existingItemArchived?: boolean;
};

export type ActionIneligibilityReason =
  | 'existing_item_missing'
  | 'already_in_closet'
  | 'already_in_recent_scans'
  | 'no_commerce_candidates'
  | 'needs_two_records'
  | 'existing_item_archived';

export type ActionAvailability = {
  action: SimilarItemAction;
  eligible: boolean;
  reason?: ActionIneligibilityReason;
  /**
   * This action destroys a record and MUST NOT execute on a single tap.
   *
   * Returned as data rather than left to each screen to remember, because
   * "the confirmation step" is the only thing standing between an advisory
   * notice and irreversible data loss — and a rule that lives in a code
   * review comment gets forgotten by the second screen that renders this.
   * `assertConfirmedBeforeExecute` below turns it into a runtime guard.
   */
  requiresConfirmation: boolean;
  /**
   * Presentation weight. `primary` is the safe, expected choice; `secondary`
   * is ordinary; `destructive` must never be visually prioritized — no
   * default-button styling, no first position, no accent colour.
   *
   * Supplied here so the ordering rule is testable. A screen is free to
   * render however it likes, but it cannot claim it did not know which
   * action was the dangerous one.
   */
  emphasis: 'primary' | 'secondary' | 'destructive';
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
/**
 * The scope each action is permitted to affect.
 *
 * Exported as data so a caller — and a test — can check an intended mutation
 * against the action that authorised it, rather than trusting a handler to have
 * confined itself. `reject_new_scan` affecting the existing record is the
 * specific failure this table is written to make visible.
 *
 * Declared ABOVE its consumers on purpose: `evaluateSimilarItemActions` and
 * `assertConfirmedBeforeExecute` derive both the confirmation requirement and
 * the presentation emphasis from `destructive` here, so there is exactly one
 * place that decides which actions are dangerous.
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

export function evaluateSimilarItemActions(
  state: SimilarItemRecordState,
): ActionAvailability[] {
  const scope = (action: SimilarItemAction) => ACTION_SCOPE[action];
  const decorate = (
    action: SimilarItemAction,
    eligible: boolean,
    reason?: ActionIneligibilityReason,
  ): ActionAvailability => ({
    action,
    eligible,
    ...(reason ? { reason } : {}),
    // Both derived from the single ACTION_SCOPE table rather than restated
    // here, so "destructive" cannot mean one thing for confirmation and
    // another for presentation.
    requiresConfirmation: scope(action).destructive,
    emphasis: scope(action).destructive
      ? 'destructive'
      : action === 'keep_both'
      ? 'primary'
      : 'secondary',
  });
  const ineligible = (action: SimilarItemAction, reason: ActionIneligibilityReason) =>
    decorate(action, false, reason);
  const eligible = (action: SimilarItemAction) => decorate(action, true);

  const archived = state.existingItemArchived === true;

  return ALL_SIMILAR_ITEM_ACTIONS.map((action) => {
    switch (action) {
      case 'delete_existing_item':
        if (!state.existingItemExists) return ineligible(action, 'existing_item_missing');
        // Already archived: the user has put this out of sight once. Offering
        // to destroy it again on the back of an ADVISORY notice is the single
        // most dangerous thing this feature could do, for the least benefit.
        if (archived) return ineligible(action, 'existing_item_archived');
        return eligible(action);

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
        if (!state.existingItemExists) return ineligible(action, 'needs_two_records');
        // "Keep both" promises two live records side by side. With one of them
        // archived that promise is false, and the honest answer is that there
        // is nothing here to keep.
        if (archived) return ineligible(action, 'existing_item_archived');
        return eligible(action);

      case 'reject_new_scan':
        // Always available, and deliberately unconditional. Discarding the
        // thing you just scanned is the user's escape hatch from a comparison
        // they consider wrong, and it must never depend on the state of the
        // OTHER record. It also, by definition, does not touch that record —
        // see `actionMayTouchExistingRecord` below.
        return eligible(action);

      default:
        return eligible(action);
    }
  });
}

/**
 * Runtime guard: refuses to let a destructive action run unconfirmed.
 *
 * Call this immediately before executing a chosen action. It throws rather
 * than returning false, because the failure mode it prevents — a delete that
 * proceeds because a screen forgot to wire its confirmation dialog — is
 * exactly the kind of bug that returns `false` into an ignored variable.
 *
 * `confirmed` must come from an explicit, separate user gesture (a
 * confirmation dialog), never from the same tap that chose the action.
 */
export function assertConfirmedBeforeExecute(
  action: SimilarItemAction,
  confirmed: boolean,
): void {
  if (ACTION_SCOPE[action]?.destructive && !confirmed) {
    throw new Error(
      `similar-item action '${action}' destroys a record and requires explicit confirmation`,
    );
  }
}

/**
 * Guard for the "two source records referring to the same existing item" case.
 *
 * The same garment can legitimately appear in BOTH the Closet list and the
 * Recent Scans list (it was scanned, then saved). Comparing the new scan
 * against both produces two notices for one physical item, which reads to the
 * user as the system being confused rather than thorough — and worse, offers
 * `delete_existing_item` twice for what may be one underlying record.
 *
 * Keeps the FIRST occurrence of each `existingItemId`. Callers that supply
 * candidates already ordered strongest-first therefore keep the strongest.
 * Deliberately keyed on id alone: two records sharing an id ARE the same
 * record regardless of which list surfaced them.
 */
export function dedupeComparisonsByExistingItem<T extends { existingItemId: string }>(
  comparisons: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const comparison of comparisons) {
    if (!comparison || typeof comparison.existingItemId !== 'string') continue;
    if (seen.has(comparison.existingItemId)) continue;
    seen.add(comparison.existingItemId);
    out.push(comparison);
  }
  return out;
}

/** Convenience: just the actions a screen should offer. */
export function eligibleSimilarItemActions(
  state: SimilarItemRecordState,
): SimilarItemAction[] {
  return evaluateSimilarItemActions(state)
    .filter((entry) => entry.eligible)
    .map((entry) => entry.action);
}

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
  authoritative_identifier_match: 'Same product code',
  same_brand: 'Same brand',
  same_model_tokens: 'Same model name',
  same_normalized_color: 'Same colour',
  same_canonical_category: 'Same category',
  same_material: 'Same material',
  same_silhouette: 'Same shape',
  same_pattern: 'Same pattern',
};

/**
 * Checkpoint 4 — plain-language explanation for each soft conflict, shown
 * alongside the reasons above when a notice still surfaces despite a
 * disagreement (e.g. "Same brand, Same model name, Different colourway").
 * `identifier_conflict` / `category_conflict` never reach the client — they
 * suppress the notice on the backend — so only the three soft reasons need a
 * label here.
 */
export const CONFLICT_REASON_LABELS: Record<string, string> = {
  different_model_family: 'Different model',
  different_silhouette: 'Different shape',
  different_colorway: 'Different colourway',
  different_pattern: 'Different pattern',
};
