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
 * no offers to show. The state comes from the stored card alone.
 */
export function storedItemEmptyShelfProps(
  card: CommerceCardLike,
  candidateId: string,
): { emptyTitle: string; emptyBody: string; testID: string } {
  const state = resolveStoredItemCommerceState(card);
  const copy = copyFor(state);
  const kind = state === 'COMPLETED_EMPTY' ? 'no-match' : state === 'ERROR' ? 'error' : 'not-started';
  return {
    emptyTitle: copy.shelfTitle,
    emptyBody: copy.shelfBody,
    testID: `multi-item-commerce-${kind}-${candidateId}`,
  };
}

/** ProductShelf empty-state copy for the single-item WHERE TO BUY shelf. */
export function purchaseShelfEmptyProps(
  optionsCount: number,
  commerceStatus: string | undefined,
): { emptyTitle: string; emptyBody: string } {
  const copy = copyFor(resolveShelfCommerceState({ optionsCount, commerceStatus }));
  return { emptyTitle: copy.shelfTitle, emptyBody: copy.shelfBody };
}
