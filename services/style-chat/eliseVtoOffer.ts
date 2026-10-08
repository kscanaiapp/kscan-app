// Elise contextual Virtual Try-On offer — the PURE half.
//
// WHAT THIS IS. When a customer gives Elise a photo of a garment K Scan can
// genuinely visualize, the APPLICATION appends one offer to her reply:
//
//     Would you like to try that on?
//     [ TRY IT ON ]
//
// The sentence and the button are ONE app-owned UI block. The model does not
// write the sentence, does not emit the block, does not pick the garment and
// does not decide eligibility. It gives fashion advice; this module (and the
// impure bridge beside it, eliseVtoUploadSource.ts) decides whether an offer
// exists at all.
//
// WHAT LIVES HERE. Only decisions that are functions of their inputs:
//
//   - the persisted block's contract, and how strictly it is read back;
//   - which ONE garment of a send snapshot may receive the offer.
//
// (The negative prose guard for model text that invites a try-on by itself is
// reply validation, so it lives with the rest of it in eliseConversationFrame.)
//
// No storage, no network, no clock and no React: every rule below is testable
// with plain objects, and nothing here can reach a device file or a paid call.

/** The persisted ui_block type. */
export const ELISE_VTO_OFFER_BLOCK_TYPE = 'elise_vto_offer' as const;

/**
 * Contract version of the persisted block. ui_blocks outlive app versions, so
 * a reader that meets a version it does not know IGNORES the block rather than
 * guessing at it — see {@link parseEliseVtoOfferBlock}.
 */
export const ELISE_VTO_OFFER_CONTRACT_VERSION = '1' as const;

/**
 * The one place the offer's words live. The invitation and the button label are
 * rendered together from this object or not at all.
 *
 * No fit, sizing or body claim, and no promise about the result: the offer
 * names a capability, and the governed sheet says everything else.
 */
export const ELISE_VTO_OFFER_COPY = Object.freeze({
  invitation: 'Would you like to try that on?',
  cta: 'TRY IT ON',
  ctaAccessibilityLabel: 'Try this on',
  ctaAccessibilityHint: 'Opens virtual try-on with a photo you choose',
  unavailable: "Try It On isn't available for this upload anymore.",
  garmentTitleFallback: 'Your photo',
});

/**
 * What the synced conversation record carries for an offer: an opaque handle
 * and nothing else.
 *
 * A StyleChat message is stored in the cloud and can appear on another device.
 * The garment behind an Elise upload is device-local. So the candidate id, its
 * content hash, its category and every path stay on the device, inside the
 * actor-scoped binding store, and only this random id — meaningless anywhere
 * else — is written to the message.
 */
export type EliseVtoOfferBlock = {
  type: typeof ELISE_VTO_OFFER_BLOCK_TYPE;
  contractVersion: typeof ELISE_VTO_OFFER_CONTRACT_VERSION;
  localBindingId: string;
};

/** Shape of an opaque local binding id. Bounded, and never a path or a URL. */
export const ELISE_VTO_LOCAL_BINDING_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isEliseVtoLocalBindingId(value: unknown): value is string {
  return typeof value === 'string' && ELISE_VTO_LOCAL_BINDING_ID_PATTERN.test(value);
}

/**
 * Builds the block that is persisted with the assistant message.
 *
 * It is constructed from the id ALONE, by key, so no other field of whatever
 * the caller happens to hold can ride along into the synced record.
 */
export function buildEliseVtoOfferBlock(localBindingId: string): EliseVtoOfferBlock | null {
  if (!isEliseVtoLocalBindingId(localBindingId)) return null;
  return {
    type: ELISE_VTO_OFFER_BLOCK_TYPE,
    contractVersion: ELISE_VTO_OFFER_CONTRACT_VERSION,
    localBindingId,
  };
}

export function isEliseVtoOfferBlockType(block: unknown): boolean {
  return !!block && typeof block === 'object' && !Array.isArray(block)
    && (block as { type?: unknown }).type === ELISE_VTO_OFFER_BLOCK_TYPE;
}

/**
 * Reads a persisted block back.
 *
 * Returns the binding id, or null for anything that is not exactly a block this
 * version understands: another type, an unknown contract version, a missing or
 * malformed id. A null is rendered as nothing. It is never repaired, never
 * routed to another action, and never a reason to throw — one bad row must not
 * take the conversation down with it.
 *
 * ONLY the id is returned. Any other field on a stored block is ignored, so a
 * block written by a different build cannot smuggle a source in through it.
 */
export function parseEliseVtoOfferBlock(block: unknown): { localBindingId: string } | null {
  if (!isEliseVtoOfferBlockType(block)) return null;
  const record = block as Record<string, unknown>;
  if (record.contractVersion !== ELISE_VTO_OFFER_CONTRACT_VERSION) return null;
  if (!isEliseVtoLocalBindingId(record.localBindingId)) return null;
  return { localBindingId: record.localBindingId };
}

// ── Which garment gets the offer ─────────────────────────────────────────────

/**
 * One direct Elise image in a send snapshot, with everything needed to say
 * which garment it is. Built by the bridge from the snapshot's own drafts.
 */
export type EliseVtoSnapshotGarment = {
  /** The composer draft this garment was attached as. */
  draftId: string;
  /** The device-local Closet candidate backing that draft. */
  candidateId: string;
  /** Position of this garment's item in the fashion context that was sent. */
  sourceIndex: number;
  /** Category from the canonical identification of THIS draft. */
  category: string;
  /** Whether the existing VTO eligibility authority accepts that category. */
  offerable: boolean;
};

export type EliseVtoOfferSelection =
  | { kind: 'offer'; garment: EliseVtoSnapshotGarment }
  | { kind: 'none'; reason: 'no_offerable_garment' | 'ambiguous' };

/**
 * The selection policy. At most one garment, and never a guess.
 *
 *   exactly one offerable garment                    -> that garment
 *   several, and the customer EXPLICITLY focused one
 *     of them                                        -> that exact garment
 *   several, and no explicit focus on one of them    -> no offer
 *   none                                             -> no offer
 *
 * `focusExplicit` must be true only when the customer chose the focused draft
 * themselves. The composer also focuses the first attachment automatically, and
 * that default is NOT a choice: treating it as one would be exactly "pick the
 * first attachment" by another name.
 *
 * Nothing here consults order. The input may arrive in any order and the answer
 * is the same, which is what makes "first", "last" and "most recent" unable to
 * influence it.
 */
export function selectEliseVtoOfferGarment(input: {
  garments: readonly EliseVtoSnapshotGarment[];
  focusedDraftId?: string | null;
  focusExplicit?: boolean;
}): EliseVtoOfferSelection {
  const offerable = (Array.isArray(input.garments) ? input.garments : []).filter(
    (garment) => garment && garment.offerable === true,
  );
  if (offerable.length === 0) return { kind: 'none', reason: 'no_offerable_garment' };
  if (offerable.length === 1) return { kind: 'offer', garment: offerable[0] };

  if (input.focusExplicit === true && typeof input.focusedDraftId === 'string' && input.focusedDraftId) {
    const focused = offerable.filter((garment) => garment.draftId === input.focusedDraftId);
    if (focused.length === 1) return { kind: 'offer', garment: focused[0] };
  }
  return { kind: 'none', reason: 'ambiguous' };
}

/** The fields of a context item this module reads. */
export type EliseVtoContextItem = {
  sourceIndex?: unknown;
  state?: unknown;
  identification?: { category?: unknown; subtype?: unknown } | null;
};

/** The fields of a composer draft this module reads. */
export type EliseVtoSnapshotDraft = {
  draftId?: unknown;
  resolved?: unknown;
  fashionContext?: unknown;
  selection?: { closetCandidateId?: unknown } | null;
};

function isGroundable(item: EliseVtoContextItem | undefined): boolean {
  return !!item && (item.state === 'ready' || item.state === 'partial') && !!item.identification;
}

function categoryOf(item: EliseVtoContextItem | undefined): string {
  const identification = item?.identification;
  const category = typeof identification?.category === 'string' ? identification.category.trim() : '';
  const subtype = typeof identification?.subtype === 'string' ? identification.subtype.trim() : '';
  // The same precedence the attachment used when it filed the candidate.
  return category || subtype;
}

/**
 * Correlates a send snapshot's direct images with the fashion context that was
 * actually sent.
 *
 *     draftId <-> device-local candidate <-> this draft's canonical identity
 *             <-> its position in the sent context
 *
 * `itemsOf` returns a draft's VALIDATED context items (or null), using the same
 * validator the send path merged with, so positions are counted the way the
 * wire contract counted them. `sentItems` is the merged context that went to
 * Elise.
 *
 * A draft is a correlated direct image only when ALL of this holds:
 *   - it has no resolved reference (a direct upload travels by fashion context);
 *   - it is backed by a device-local candidate;
 *   - it carries exactly ONE context item, and that item is groundable;
 *   - the item at its computed position in the SENT context is groundable and
 *     names the same category.
 *
 * Anything else is left out. A draft that cannot be tied to one sent item is
 * not a garment this module will speak for.
 */
export function correlateEliseDirectImageGarments(input: {
  drafts: readonly EliseVtoSnapshotDraft[];
  sentItems: readonly EliseVtoContextItem[] | null | undefined;
  itemsOf: (draft: EliseVtoSnapshotDraft) => readonly EliseVtoContextItem[] | null;
  isOfferableCategory: (category: string) => boolean;
}): EliseVtoSnapshotGarment[] {
  const sent = Array.isArray(input.sentItems) ? input.sentItems : null;
  if (!sent || !Array.isArray(input.drafts)) return [];

  const garments: EliseVtoSnapshotGarment[] = [];
  const seenCandidates = new Set<string>();
  let nextIndex = 0;
  for (const draft of input.drafts) {
    const items = draft ? input.itemsOf(draft) : null;
    if (!items || items.length === 0) continue;
    const firstIndex = nextIndex;
    nextIndex += items.length;

    if (draft.resolved != null) continue;
    const candidateId = draft.selection?.closetCandidateId;
    if (typeof draft.draftId !== 'string' || !draft.draftId) continue;
    if (typeof candidateId !== 'string' || !candidateId) continue;
    if (items.length !== 1 || !isGroundable(items[0])) continue;

    const category = categoryOf(items[0]);
    const sentItem = sent[firstIndex];
    if (!category || !isGroundable(sentItem)) continue;
    if (sentItem.sourceIndex !== firstIndex || categoryOf(sentItem) !== category) continue;
    // One candidate, one garment. A duplicate reference is not a second one.
    if (seenCandidates.has(candidateId)) continue;
    seenCandidates.add(candidateId);

    garments.push({
      draftId: draft.draftId,
      candidateId,
      sourceIndex: firstIndex,
      category,
      offerable: input.isOfferableCategory(category) === true,
    });
  }
  return garments;
}
