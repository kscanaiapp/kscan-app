/**
 * Commerce shelf state (Build 34 Lane A - scanner commerce-state truth).
 *
 * One pure vocabulary for "what is the shopping shelf for this item actually
 * doing", shared by the live per-item shelf, the saved-scan (reopen) surface and
 * the single-item shelf.
 *
 * HARD INVARIANT: NO_MATCH_COPY_MAY_RENDER_ONLY_AFTER_COMPLETED_EMPTY_RESULT.
 * The scanner may state that no shopping match was found only after retrieval
 * demonstrably completed with an empty result. Every other empty shelf is a
 * different fact, and this module keeps them apart:
 *
 *   NOT_STARTED      nothing searched for this item and nothing is going to be:
 *                    the backend skipped commerce (multi-item detection with the
 *                    deferred-commerce funnel off), the item
 *                    cannot be searched, or a saved scan carries no stored card.
 *   DEFERRED         the backend announced commerce.deferred; the client has not
 *                    dispatched yet (the first committed frame after the result).
 *   IN_PROGRESS      a commerce-only request is in flight.
 *   RESULTS          at least one offer.
 *   COMPLETED_EMPTY  the search ran to completion and found nothing. The ONLY
 *                    state whose copy is a no-match statement.
 *   ERROR            the search failed, was cut short, or produced no answer.
 *
 * WHY EMPTY IS NOT ENOUGH
 * An empty array has meant "never started", "failed" and "completed empty" at
 * different call sites. Nothing here infers a state from emptiness or from the
 * absence of a card: COMPLETED_EMPTY is reachable only from a card that a
 * producer positively classified as completed-empty (see toCardStatus in
 * services/multiItemCommerce.ts and settleEmptyResult in
 * services/commerceHydration.ts).
 *
 * DEPENDENCY-FREE ON PURPOSE. This file has no runtime imports, so the render
 * harnesses that load MultiItemCommerceSection without mocks can load it, and
 * hooks/useKScan.js (which its vm-based duplicate-guard test runs with imports
 * stripped) never needs to import it: the state is derived at render time from
 * what the hook already exposes.
 */

export type CommerceShelfState =
  | 'NOT_STARTED'
  | 'DEFERRED'
  | 'IN_PROGRESS'
  | 'RESULTS'
  | 'COMPLETED_EMPTY'
  | 'ERROR';

/** Structural view of a per-item commerce card (live or stored). */
export type CommerceCardLike =
  | { status?: unknown; bestMatch?: unknown }
  | null
  | undefined;

/**
 * Structural commerce eligibility, using only evidence multi-item detection
 * already produced: a candidate is eligible when it carries identification
 * content a commerce query can be built from, the same non-emptiness bar the
 * backend applies (`readCommerceOnlyEvidence` requires identification).
 *
 * Lives here (re-exported by services/multiItemCommerce.ts) so the section can
 * ask the question without importing the network-facing orchestrator.
 */
export function isCandidateCommerceEligible(
  candidate: { source?: { identification?: unknown } | null } | null | undefined,
): boolean {
  const identification = candidate?.source?.identification;
  if (!identification || typeof identification !== 'object') return false;
  return Object.keys(identification as Record<string, unknown>).length > 0;
}

/**
 * State of one detected item on the LIVE multi-item shelf.
 *
 * `deferred`     analysis.commerceDeferred: the backend announced deferral.
 * `shelfStatus`  the hook's whole-shelf lifecycle: 'idle' | 'pending' | 'ready'.
 * `eligible`     isCandidateCommerceEligible(candidate).
 * `card`         the item's card, if the orchestrator produced one.
 *
 * A card is evidence and is read as such. The ABSENCE of a card is never
 * evidence of anything on its own: with the shelf idle it means nothing was
 * dispatched, and with the shelf finished it means an eligible item was searched
 * for and produced no answer, which is a failure and never a statement about the
 * garment.
 */
export function resolveItemCommerceState(input: {
  deferred: boolean;
  shelfStatus: string | undefined;
  eligible: boolean;
  card?: CommerceCardLike;
}): CommerceShelfState {
  const { card } = input;
  if (card) {
    if (card.status === 'no_match') return 'COMPLETED_EMPTY';
    if (card.status === 'ready' && card.bestMatch) return 'RESULTS';
    // 'error', a "ready" card that carries no offer, or a status this build does
    // not know: none of them is a completed empty search.
    return 'ERROR';
  }
  if (input.shelfStatus === 'pending') return 'IN_PROGRESS';
  if (input.shelfStatus === 'idle') {
    return input.deferred ? 'DEFERRED' : 'NOT_STARTED';
  }
  if (input.shelfStatus === 'ready') {
    return input.eligible ? 'ERROR' : 'NOT_STARTED';
  }
  return 'NOT_STARTED';
}

/**
 * Whether the live multi-item shelf is about to be dispatched with no further
 * user action, which is the only situation DEFERRED ("Finding where to buy
 * this...") tells the truth about.
 *
 * `deferred` alone is not enough. With the multi-image Scanner on, useKScan
 * deliberately holds commerce for a detection result until the user selects a
 * garment (B35-SCAN-014: never spend on unseen candidates), so the shelf stays
 * idle with `deferred` true until Find Matches. Reporting DEFERRED there showed a
 * permanent spinner for a search nothing was running; the truthful state is
 * NOT_STARTED, whose copy points at the real next step.
 */
export function isLiveShelfDispatchImminent(input: {
  deferred: boolean;
  dispatchHeldForSelection: boolean;
}): boolean {
  return input.deferred && !input.dispatchHeldForSelection;
}

/**
 * State of one item on a SAVED (reopened) scan. Reopen issues no network call, so
 * the stored card is the only evidence there is. No stored card means commerce
 * was never persisted for the item, which is NOT_STARTED, never COMPLETED_EMPTY:
 * a completed empty search is persisted as an explicit 'no_match' card.
 */
export function resolveStoredItemCommerceState(card: CommerceCardLike): CommerceShelfState {
  if (!card) return 'NOT_STARTED';
  if (card.status === 'no_match') return 'COMPLETED_EMPTY';
  if (card.status === 'error') return 'ERROR';
  if (card.status === 'ready' && card.bestMatch) return 'RESULTS';
  return 'NOT_STARTED';
}

/**
 * State of the single-item WHERE TO BUY shelf. `commerceStatus` is the hook's
 * single-item status. 'empty' is COMPLETED_EMPTY only because
 * fetchDeferredCommerce returns 'empty' exclusively for a search the backend
 * reported as completed-empty; every other non-success result reaches this
 * shelf as 'error'. 'idle' (including a saved scan, which passes no status) is
 * NOT_STARTED.
 */
export function resolveShelfCommerceState(input: {
  optionsCount: number;
  commerceStatus: string | undefined;
}): CommerceShelfState {
  if (input.optionsCount >= 1) return 'RESULTS';
  if (input.commerceStatus === 'pending') return 'IN_PROGRESS';
  if (input.commerceStatus === 'error') return 'ERROR';
  if (input.commerceStatus === 'empty') return 'COMPLETED_EMPTY';
  return 'NOT_STARTED';
}

export type CommerceShelfCopy = {
  /** Live per-item inline notice. */
  notice: string;
  /** Same, for a surface that has no Find Matches action (NOT_STARTED only). */
  noticeWithoutAction?: string;
  /** Accessibility label; names the garment so stacked notices differ by voice. */
  noticeLabel: (garment: string) => string;
  noticeLabelWithoutAction?: (garment: string) => string;
  /** Empty-shelf copy for the saved-scan and single-item ProductShelf surfaces. */
  shelfTitle: string;
  shelfBody: string;
};

/**
 * The copy table. THE ONLY PLACE the no-match statements exist: the entry keyed
 * COMPLETED_EMPTY below. __tests__/scanCommerceStateTruth.test.js scans
 * components/, app/, services/, hooks/ and app.js and fails if any of these
 * sentences (or a near variant) appears anywhere else, or outside that entry.
 *
 * RESULTS has no entry: it renders offers, not copy.
 */
export const COMMERCE_SHELF_COPY: Readonly<
  Record<Exclude<CommerceShelfState, 'RESULTS'>, CommerceShelfCopy>
> = {
  NOT_STARTED: {
    // Points at the real next step. In the confirmation step the sticky action
    // row's only action is "Find Matches" (ScanResultV2), and it acts on the
    // selected item; that is what actually fetches offers when the backend did
    // not defer commerce.
    notice: 'Select this item, then tap Find Matches to see where to buy.',
    noticeWithoutAction: "Shopping matches haven't been loaded for this item.",
    noticeLabel: (garment) => `Select ${garment}, then tap Find Matches to see where to buy it`,
    noticeLabelWithoutAction: (garment) => `Shopping matches haven't been loaded for ${garment}`,
    // Asserts nothing about whether a search ran: a reopened single-item scan does
    // not record whether its inline search came back empty, failed or never started.
    shelfTitle: "Shopping matches aren't shown here.",
    shelfBody: "This item was identified, but where-to-buy results aren't shown in this view.",
  },
  DEFERRED: {
    notice: 'Finding where to buy this…',
    noticeLabel: (garment) => `Finding where to buy ${garment}`,
    shelfTitle: 'Finding where to buy this…',
    shelfBody: 'Shopping matches are still loading.',
  },
  IN_PROGRESS: {
    notice: 'Finding where to buy this…',
    noticeLabel: (garment) => `Finding where to buy ${garment}`,
    shelfTitle: 'Finding where to buy this…',
    shelfBody: 'Shopping matches are still loading.',
  },
  COMPLETED_EMPTY: {
    notice: 'No strong shopping match found.',
    noticeLabel: (garment) => `No strong shopping match found for ${garment}`,
    shelfTitle: 'No strong shopping match found.',
    shelfBody: 'This item was identified, but no confident retailer match was returned.',
  },
  ERROR: {
    notice: "Couldn't load purchase options for this item.",
    noticeLabel: (garment) => `Couldn't load purchase options for ${garment}`,
    shelfTitle: "Purchase options couldn't be loaded.",
    shelfBody: "We couldn't reach our retail partners for this item when this scan was saved.",
  },
};

/**
 * Empty-shelf copy for a REOPENED scan (P-COPY-2).
 *
 * Reopen issues no network call, so the saved record is the only evidence, and
 * what it can say is narrower than the live shelf's NOT_STARTED copy. That copy
 * ("aren't shown here" / "aren't shown in this view") was written for a live
 * surface with a next step on it. On a reopened scan it read as if matches
 * existed somewhere the screen would not say, and a saved list of N detected
 * items printed it N+1 times: once per item and once more for the single-item
 * shelf.
 *
 * Each entry states only what the saved record establishes:
 *
 *   NOT_SAVED             this scan's record holds no offers. Whether its search
 *                         came back empty, failed or never ran is not recorded,
 *                         so the copy says none were saved, never that none exist.
 *   NOT_SAVED_FOR_ITEM    the same, for one item of a saved multi-item scan whose
 *                         other items do have stored commerce.
 *   SAVED_WITH_EACH_ITEM  a saved list of detected items, none with stored
 *                         commerce. With the multi-image Scanner on this is every
 *                         such record: commerce runs only for the garment the
 *                         user chooses, and that garment is saved as its own
 *                         Recent Scans entry with its offers. Offers may
 *                         therefore exist and simply not be on this record, so
 *                         the copy says where they are kept instead of that they
 *                         are missing.
 *
 * None of them is a no-match statement; that stays with COMPLETED_EMPTY above.
 */
export const SAVED_SCAN_EMPTY_COPY = {
  NOT_SAVED: {
    emptyTitle: "Shopping matches weren't saved with this scan.",
    emptyBody: 'Scan the item again to see where to buy it.',
  },
  NOT_SAVED_FOR_ITEM: {
    emptyTitle: "Shopping matches weren't saved for this item.",
    emptyBody: 'Scan it again to see where to buy it.',
  },
  SAVED_WITH_EACH_ITEM: {
    emptyTitle: 'Shopping matches are saved with each item.',
    emptyBody:
      "When you choose an item from a scan, its matches are kept on that item's own entry in Recent Scans.",
  },
} as const;

/**
 * Whether a saved multi-item scan carries no commerce for ANY of its items, the
 * case SAVED_WITH_EACH_ITEM describes. A stored card of any status (offers,
 * no_match, error) is evidence that commerce ran for this record, and then every
 * item keeps its own per-item treatment.
 */
export function savedMultiItemScanHasNoCommerce(
  candidates: ReadonlyArray<{ id: string }>,
  cards: ReadonlyArray<{ candidateId?: unknown } | null | undefined> | null | undefined,
): boolean {
  if (candidates.length === 0) return false;
  const stored = new Set(
    (cards ?? []).map((card) => card?.candidateId).filter((id) => typeof id === 'string'),
  );
  return candidates.every((candidate) => !stored.has(candidate.id));
}

/** The one empty shelf a saved multi-item scan with no commerce shows. */
export function savedMultiItemSummaryShelfProps(): {
  emptyTitle: string;
  emptyBody: string;
  testID: string;
} {
  return {
    ...SAVED_SCAN_EMPTY_COPY.SAVED_WITH_EACH_ITEM,
    testID: 'multi-item-commerce-not-started-summary',
  };
}

/**
 * Copy for a state. RESULTS has none, and anything unexpected falls back to the
 * neutral NOT_STARTED copy: a lookup can never land on the no-match statement
 * unless the state really is COMPLETED_EMPTY.
 */
function copyFor(state: CommerceShelfState): CommerceShelfCopy {
  return state === 'RESULTS' ? COMMERCE_SHELF_COPY.NOT_STARTED : COMMERCE_SHELF_COPY[state];
}

/** Live per-item notice text and accessibility label for a state. */
export function commerceShelfNoticeCopy(
  state: CommerceShelfState,
  garment: string,
  findMatchesAvailable: boolean,
): { body: string; accessibilityLabel: string } {
  const copy = copyFor(state);
  const withoutAction = state === 'NOT_STARTED' && !findMatchesAvailable;
  const label = withoutAction && copy.noticeLabelWithoutAction
    ? copy.noticeLabelWithoutAction
    : copy.noticeLabel;
  return {
    body: withoutAction && copy.noticeWithoutAction ? copy.noticeWithoutAction : copy.notice,
    accessibilityLabel: label(garment),
  };
}

/**
 * ProductShelf props for one item of a saved (reopened) multi-item scan that has
 * no offers to show. The state comes from the stored card alone. An item with no
 * stored card says its matches were not saved (SAVED_SCAN_EMPTY_COPY), not the
 * live shelf's NOT_STARTED copy.
 */
export function storedItemEmptyShelfProps(
  card: CommerceCardLike,
  candidateId: string,
): { emptyTitle: string; emptyBody: string; testID: string } {
  const state = resolveStoredItemCommerceState(card);
  const kind = state === 'COMPLETED_EMPTY' ? 'no-match' : state === 'ERROR' ? 'error' : 'not-started';
  const testID = `multi-item-commerce-${kind}-${candidateId}`;
  if (kind === 'not-started') {
    return { ...SAVED_SCAN_EMPTY_COPY.NOT_SAVED_FOR_ITEM, testID };
  }
  const copy = copyFor(state);
  return { emptyTitle: copy.shelfTitle, emptyBody: copy.shelfBody, testID };
}

/**
 * ProductShelf empty-state copy for the single-item WHERE TO BUY shelf.
 *
 * `savedScan` marks a reopened Recent Scan. There the NOT_STARTED state means the
 * record holds no offers, and the copy says exactly that. A live shelf, and every
 * other state on either surface, is unchanged.
 */
export function purchaseShelfEmptyProps(
  optionsCount: number,
  commerceStatus: string | undefined,
  options: { savedScan?: boolean } = {},
): { emptyTitle: string; emptyBody: string } {
  const state = resolveShelfCommerceState({ optionsCount, commerceStatus });
  if (state === 'NOT_STARTED' && options.savedScan === true) {
    return { ...SAVED_SCAN_EMPTY_COPY.NOT_SAVED };
  }
  const copy = copyFor(state);
  return { emptyTitle: copy.shelfTitle, emptyBody: copy.shelfBody };
}
