/**
 * Every shopper-facing string on the Saved Look surfaces.
 *
 * WHY THIS FILE EXISTS: the ownership resolver produces a diagnosis, and a
 * diagnosis is written for whoever has to debug it — "the saved slot lacks
 * enough normalized taxonomy to decide ownership" is a correct sentence and an
 * unacceptable thing to show a shopper. Rendering the resolver's own words was
 * the whole of BUG-15.
 *
 * So the boundary is explicit: `PrivateSlotOwnership.diagnosticReason` is
 * internal and is never rendered, and every word the user reads comes from
 * here. That also makes the rule testable — the copy is data, so a contract
 * test can walk all of it and assert no implementation vocabulary survives.
 *
 * Rules for anything added below:
 *   - say what the shopper needs to decide, not how we decided it;
 *   - no enum values, no taxonomy/slot/schema/query vocabulary, no phase names;
 *   - never claim a state we have not proven ("Owned" when we only suspect it).
 */

import type { PrivateOwnershipState } from './privateSavedLookOwnership';

export type SavedLookSlotCopy = {
  /** Short status shown beside the piece. */
  label: string;
  /** One line telling the shopper what to do about it. */
  detail: string;
};

/**
 * Ownership states as the shopper sees them.
 *
 * `probable_owned` and `exact_owned` share a label on purpose: the difference
 * between "this is the exact piece" and "this matches a piece you own" changes
 * whether we suppress commerce, and changes nothing the shopper must decide.
 */
const SLOT_COPY: Record<PrivateOwnershipState, SavedLookSlotCopy> = {
  exact_owned: {
    label: 'In your Closet',
    detail: 'This is the piece you saved.',
  },
  probable_owned: {
    label: 'In your Closet',
    detail: 'This matches a piece you already own.',
  },
  similar_owned: {
    label: 'Similar piece in your Closet',
    detail: 'You own something close to this. Take a look before you shop.',
  },
  not_owned: {
    label: 'Not in your Closet',
    detail: 'Add this piece to complete the look.',
  },
  unknown: {
    label: 'Not confirmed',
    detail: "We can't tell yet whether this piece is in your Closet.",
  },
  deleted_reference: {
    label: 'No longer in your Closet',
    detail: 'The piece you saved has since been removed from your Closet.',
  },
  incompatible_edit: {
    label: 'Changed in your Closet',
    detail: 'The piece you saved is now filed under a different category.',
  },
};

/** Shown when ownership could not be worked out for a piece at all. */
export const SAVED_LOOK_SLOT_UNAVAILABLE: SavedLookSlotCopy = {
  label: 'Item details unavailable',
  detail: "We couldn't check this piece against your Closet just now.",
};

export function savedLookSlotCopy(
  state: PrivateOwnershipState | null | undefined,
): SavedLookSlotCopy {
  if (!state) return SAVED_LOOK_SLOT_UNAVAILABLE;
  return SLOT_COPY[state] ?? SAVED_LOOK_SLOT_UNAVAILABLE;
}

/** Notices and headings on the Saved Look detail screen. */
export const SAVED_LOOK_DETAIL_COPY = {
  closetUnavailableTitle: 'Closet unavailable',
  closetUnavailableBody:
    "We couldn't read your Closet just now, so we're not showing what you already own. Your Saved Look is unchanged.",
  refreshedSuffix: 'updated',
  refreshedBody: 'We checked this piece against your Closet again.',
  ownedAlternativeTitle: 'Already in your Closet',
  otherOwnedOptionsPrefix: 'Other pieces you own',
} as const;

/** The shopping handoff screen. */
export const SAVED_LOOK_HANDOFF_COPY = {
  readyTitle: 'Ready to shop',
  readySubtitle: 'Shopping opens outside K Scan AI',
  preparing: 'Getting things ready...',
  selectedPieceEyebrow: 'LOOKING FOR',
  deferredBody:
    "We've noted the piece you're looking for. Shopping for it isn't available in this version yet.",
  noSelectionTitle: 'Nothing selected yet',
  noSelectionBody: 'Open a Saved Look and choose a piece to shop for.',
} as const;

/** The commerce shelf fallback when a product arrives without a usable name. */
export const PRODUCT_TITLE_UNAVAILABLE = 'Item details unavailable';

/**
 * Vocabulary that must never reach a shopper on these surfaces.
 *
 * Deliberately narrow and phrase-shaped rather than a blanket ban on words like
 * "unknown", which is legitimate internally and inside diagnostics. Each entry
 * is a phrase that was, or could plausibly become, user-visible.
 */
export const FORBIDDEN_SHOPPER_PHRASES: readonly string[] = [
  'ownership unknown',
  'ownership unavailable',
  'normalized taxonomy',
  'semantic slot',
  'unknown product',
  'taxonomy',
  'schema',
  'enum',
  'fallback',
  'query',
  'endpoint',
  'handoff',
  'idempoten',
  'actor context',
  'phase 5',
  'null',
  'undefined',
];

/** Every shopper-visible string this module owns, for contract testing. */
export function allSavedLookShopperCopy(): string[] {
  const slotStrings = Object.values(SLOT_COPY).flatMap((copy) => [copy.label, copy.detail]);
  return [
    ...slotStrings,
    SAVED_LOOK_SLOT_UNAVAILABLE.label,
    SAVED_LOOK_SLOT_UNAVAILABLE.detail,
    ...Object.values(SAVED_LOOK_DETAIL_COPY),
    ...Object.values(SAVED_LOOK_HANDOFF_COPY),
    PRODUCT_TITLE_UNAVAILABLE,
  ];
}
