// Elise image styling loop: attach → answer → follow up → save → style.
//
// PURE. No React, no persistence, no network, no clock. Everything the loop
// decides — which attached photo Elise is currently discussing, how it is
// described, which follow-ups are offered, and whether Style This Item may run
// at all — is a function of the composer's existing draft attachments.
//
// WHY A SEPARATE MODULE RATHER THAN LOGIC IN THE SCREEN. The three rules this
// build must not get wrong (the attach/save independence, the ownership
// boundary, and "never offer a control that cannot complete") are all decidable
// from state alone. Deciding them here means they are testable without a
// renderer, which is the only kind of test this repository can actually run.
//
// THE OWNERSHIP BOUNDARY IS THE POINT.
//
//   attached photo  =  an actor-scoped Closet CANDIDATE
//   owned item      =  a promoted Closet item with a committed closetItemId
//
// They are not the same thing and this module never lets the second be inferred
// from the first. `Style This Item` becomes eligible only when the existing
// Closet persistence contract has reported `saved` AND handed back a real
// closetItemId — which is exactly what `saveDirectImageToCloset` requires before
// it publishes that state. An unsaved candidate is never described as owned,
// never anchors a Dressing Room, and never suppresses anything.
//
// ATTACH-FIRST IS PRESERVED, NOT REVERSED. Nothing here consults `closetState`
// to decide whether an attachment is usable: an item that has never been saved,
// or whose save failed, still produces an active context and still produces
// follow-ups. Closet persistence only ever ADDS an action.
//
// NO MODEL DECIDES WHAT IS SHOWN. Follow-ups are selected from a fixed table by
// the repository's own category vocabulary (`bucketForCategory`, the same engine
// services/privateDressingRoomSlots.ts uses) and by the attachment's own state.
// There is no request, no scoring, and no ordering that can vary between two
// renders of the same state.

import { bucketForCategory } from '../free-tier/outfitGenerator';
import type { CategoryBucket } from '../free-tier/outfitGenerator';
import {
  groundableItems,
  titleForItem,
  validateEliseFashionContextV2,
} from './eliseFashionContextV2';
import type { EliseFashionContextV2 } from '../../types/fashionIdentificationV2';
import type {
  AttachmentState,
  ClosetSaveState,
  DraftAttachment,
} from '../../types/styleChatAttachments';

// ── Copy ─────────────────────────────────────────────────────────────────────

/**
 * Every user-facing string this loop can render.
 *
 * Centralized for the same reason constants/elise.ts exists: the words a stylist
 * says are product copy, and copy that lives inline in three components drifts
 * into three slightly different products.
 */
export const ELISE_IMAGE_LOOP_COPY = {
  contextHeading: 'Currently styling',
  savedBadge: 'Saved to Closet',
  unsavedBadge: 'Not saved to Closet',
  savingBadge: 'Saving to Closet…',
  saveFailedBadge: "Couldn't save to Closet",
  clearLabel: 'Clear',
  changeLabel: 'Change item',
  clearAccessibilityLabel: 'Stop styling this item',
  changeAccessibilityLabel: 'Style a different item',
  /** Lead-in above the follow-ups, chosen by state — never by a model. */
  leadInUnsent: 'Ask Elise about this',
  leadInSavePrompt: 'Like this piece?',
  leadInSaved: 'Keep going',
  leadInStyled: 'Back to your Dressing Room',
  saveLabel: 'Save to Closet',
  savingLabel: 'Saving…',
  retrySaveLabel: 'Try again',
  styleThisItemLabel: 'Style This Item',
  openDressingRoomLabel: 'Open Dressing Room',
  changeSomethingLabel: 'Change something',
  ownershipBlockedMessage:
    'Save this piece to your Closet first, then Elise can build a Look around it.',
  handoffFailedMessage:
    "Couldn't open your Dressing Room for this piece. It's still saved in your Closet.",
  /** Neutral label when identification produced nothing nameable. */
  unnamedItem: 'This photo',
} as const;

// ── Active item context ──────────────────────────────────────────────────────

/**
 * The attachment states in which an item is genuinely still "the thing Elise is
 * discussing".
 *
 * `sent` is included, and that is the whole reason the context survives a send:
 * `setSnapshotSendState` deliberately keeps candidate-backed drafts at `sent`
 * instead of removing them, so the conversation can keep referring to the photo.
 *
 * `send_failed` is included because the send failing does not un-attach the
 * photo — the user may retry, or simply ask something else about it.
 *
 * Pending states (`sanitizing`, `identifying`, …) are excluded: an item that has
 * not finished identifying has no honest label and no category to choose
 * follow-ups from, and showing "Currently styling" over it would claim a
 * grounding that does not exist yet.
 */
const ACTIVE_ATTACHMENT_STATES: readonly AttachmentState[] = [
  'ready',
  'sending',
  'sent',
  'send_failed',
];

export type EliseActiveItemContext = {
  /**
   * The composer-local draft id. Client-only and deliberately the ONLY
   * identifier on this object: it is not a candidate id, a saved-scan id, a
   * Closet id or an actor id, and it never leaves the device.
   */
  draftId: string;
  /** Strongest approved deterministic label. Never a model-authored sentence. */
  title: string;
  /** Local thumbnail for display only; never sent anywhere. */
  thumbnailUri: string | null;
  /** Repository category vocabulary, not a new taxonomy. */
  categoryBucket: CategoryBucket;
  attachmentState: AttachmentState;
  closetState: ClosetSaveState;
  /**
   * TRUE ONLY when Closet persistence has reported `saved` AND handed back a
   * committed item id. This is the ownership boundary in one field.
   */
  owned: boolean;
  /** Set once this item has been handed off to the Dressing Room this session. */
  styled: boolean;
};

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * The validated canonical context carried by a draft, or null.
 *
 * `DraftAttachment.fashionContext` is deliberately typed `unknown` — it may have
 * been written by an older build — so every read revalidates rather than trusting
 * the type. Returning null on invalid input is what keeps a malformed context
 * from becoming a confident-looking label.
 */
export function draftFashionContext(
  draft: Pick<DraftAttachment, 'fashionContext'> | null | undefined,
): EliseFashionContextV2 | null {
  if (!draft || draft.fashionContext == null) return null;
  const validated = validateEliseFashionContextV2(draft.fashionContext);
  return validated.kind === 'ok' ? validated.context : null;
}

/**
 * Category bucket for one attachment, by decreasing specificity.
 *
 * The precedence — subtype, then category, then the review subtitle, then the
 * title — mirrors services/privateDressingRoomSlots.ts, and for the same reason:
 * a `subtype: 'blazer'` under `category: 'Tops'` is outerwear, and consulting the
 * most specific field first is what makes that come out right. `bucketForCategory`
 * is the repository's existing vocabulary; no second mapping is invented here.
 */
export function resolveCategoryBucket(
  draft: Pick<DraftAttachment, 'fashionContext' | 'summary'>,
): CategoryBucket {
  const identity = groundableItems(draftFashionContext(draft))[0]?.identification ?? null;
  const candidates = [
    identity ? nonEmpty(identity.subtype) : null,
    identity ? nonEmpty(identity.category) : null,
    nonEmpty(draft.summary?.subtitle),
    nonEmpty(draft.summary?.title),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const bucket = bucketForCategory(candidate);
    if (bucket !== 'other') return bucket;
  }
  return 'other';
}

/**
 * The strongest label we are entitled to show.
 *
 * The review title comes first because the user confirmed it; the canonical
 * identity is the fallback, and a neutral literal is the floor. Never a
 * template-interpolated nullable — that is how "undefined jacket" reaches a
 * screen.
 */
function resolveTitle(draft: Pick<DraftAttachment, 'fashionContext' | 'summary'>): string {
  const reviewed = nonEmpty(draft.summary?.title);
  if (reviewed) return reviewed;
  const item = groundableItems(draftFashionContext(draft))[0] ?? null;
  const identified = item ? nonEmpty(titleForItem(item)) : null;
  if (identified && identified !== 'Photo') return identified;
  return ELISE_IMAGE_LOOP_COPY.unnamedItem;
}

/** A direct-image attachment is the one backed by a Closet candidate. */
function isDirectImageDraft(draft: DraftAttachment): boolean {
  return Boolean(draft?.selection?.closetCandidateId);
}

/**
 * The item Elise is currently discussing, or null.
 *
 * The NEWEST usable direct-image attachment wins. Deterministic rather than
 * "whichever resolved last": drafts are appended in selection order, so the last
 * one is the one the user most recently chose, and a late saga completion on an
 * older draft cannot silently steal the context.
 */
export function resolveActiveItemContext(
  drafts: readonly DraftAttachment[] | null | undefined,
): EliseActiveItemContext | null {
  if (!Array.isArray(drafts) || drafts.length === 0) return null;
  for (let index = drafts.length - 1; index >= 0; index -= 1) {
    const draft = drafts[index];
    if (!draft || !isDirectImageDraft(draft)) continue;
    if (!ACTIVE_ATTACHMENT_STATES.includes(draft.state)) continue;

    const closetState: ClosetSaveState = draft.closetState ?? 'not_saved';
    const closetItemId = nonEmpty(draft.closetItemId);
    return {
      draftId: draft.draftId,
      title: resolveTitle(draft),
      thumbnailUri: nonEmpty(draft.summary?.imageUri),
      categoryBucket: resolveCategoryBucket(draft),
      attachmentState: draft.state,
      closetState,
      // BOTH conditions, always. `saved` without a committed id is not ownership,
      // and an id without `saved` is a stale hydration.
      owned: closetState === 'saved' && closetItemId !== null,
      styled: draft.styledInDressingRoom === true,
    };
  }
  return null;
}

/**
 * The canonical identity to carry on the NEXT message about this item.
 *
 * This is what makes a follow-up "context-aware" without a second upload, a
 * second identification, a second candidate or a second charge: the identity was
 * already derived and validated when the photo was attached, and it is a
 * styling-safe projection with no image, no evidence id and no candidate id in
 * it. Re-sending it is re-sending JSON the client already holds.
 */
export function resolveActiveItemFashionContext(
  drafts: readonly DraftAttachment[] | null | undefined,
  draftId: string,
): EliseFashionContextV2 | null {
  if (!Array.isArray(drafts)) return null;
  const draft = drafts.find((entry) => entry?.draftId === draftId) ?? null;
  return draftFashionContext(draft);
}

// ── Ownership-gated Dressing Room target ─────────────────────────────────────

export type EliseStyleTarget = {
  draftId: string;
  /**
   * The committed Closet item id. Held OFF the display context on purpose: the
   * context bar renders a title and a thumbnail and must not be able to leak an
   * id, while the handoff needs one. Two objects, two audiences.
   */
  closetItemId: string;
};

/**
 * The anchor for a Dressing Room handoff, or null.
 *
 * Re-derived from the LIVE drafts at tap time rather than captured when the
 * chip rendered. A context object that was correct three seconds ago is not
 * evidence of ownership now — the user may have removed the attachment, or the
 * actor may have changed and the store been reset underneath it.
 */
export function resolveStyleTarget(
  drafts: readonly DraftAttachment[] | null | undefined,
  draftId: string,
): EliseStyleTarget | null {
  if (!Array.isArray(drafts)) return null;
  const draft = drafts.find((entry) => entry?.draftId === draftId) ?? null;
  if (!draft || !isDirectImageDraft(draft)) return null;
  if (!ACTIVE_ATTACHMENT_STATES.includes(draft.state)) return null;
  if (draft.closetState !== 'saved') return null;
  const closetItemId = nonEmpty(draft.closetItemId);
  if (!closetItemId) return null;
  return { draftId: draft.draftId, closetItemId };
}

// ── Follow-up actions ────────────────────────────────────────────────────────

export type EliseFollowUpActionType =
  | 'prompt'
  | 'save_to_closet'
  | 'style_this_item'
  | 'open_dressing_room'
  | 'change_something';

export type EliseFollowUpAction = {
  /** Stable within a state, so React keys never collide or churn. */
  id: string;
  type: EliseFollowUpActionType;
  label: string;
  /** Present only for `prompt`; this exact text is what the user "typed". */
  prompt?: string;
  accessibilityLabel: string;
  /** True while the underlying operation is already running. */
  busy?: boolean;
};

/**
 * Predefined fashion prompts per category bucket, most useful first.
 *
 * Written against the repository's actual buckets, not an invented taxonomy.
 * `bag`, `accessory` and `other` share the generic pair because there is no
 * honest slot-specific question to ask about them — offering "What pants work?"
 * for a handbag would be a worse experience than offering nothing specific.
 */
const CATEGORY_PROMPTS: Readonly<Record<CategoryBucket, readonly string[]>> = Object.freeze({
  dress: Object.freeze([
    'What shoes work?',
    'Make this more casual',
    'What jacket would you add?',
  ]),
  outerwear: Object.freeze([
    'What pants work?',
    'What should I wear under this?',
    'Build a Look around this',
  ]),
  footwear: Object.freeze([
    'What pants work?',
    'What colors go with these?',
    'Build a Look around these',
  ]),
  top: Object.freeze([
    'What bottoms work?',
    'Dress this up',
    'Make this more casual',
  ]),
  bottom: Object.freeze([
    'What top works?',
    'What shoes work?',
    'Build a Look around this',
  ]),
  bag: Object.freeze([
    'What outfit works with this?',
    'What colors go with this?',
  ]),
  accessory: Object.freeze([
    'What outfit works with this?',
    'What colors go with this?',
  ]),
  other: Object.freeze([
    'What would you wear with this?',
    'Make this more casual',
  ]),
});

/** Category-agnostic opener, used where §12 asks for the generic pairing question. */
const GENERIC_PAIRING_PROMPT = 'What would you wear with this?';

function promptAction(prompt: string, index: number): EliseFollowUpAction {
  return {
    id: `prompt_${index}`,
    type: 'prompt',
    label: prompt,
    prompt,
    accessibilityLabel: `Ask Elise: ${prompt}`,
  };
}

/**
 * Up to three deterministic follow-ups for the current state.
 *
 * NEVER MORE THAN THREE, and never a control that cannot complete: the save
 * action appears only while saving is actually possible, and Style This Item
 * appears only once `owned` is true. `saving` renders the save control busy
 * rather than removing it, so the row does not reflow underneath a finger that
 * is already on its way down.
 */
export function resolveFollowUpActions(
  context: EliseActiveItemContext | null,
): EliseFollowUpAction[] {
  if (!context) return [];
  const prompts = CATEGORY_PROMPTS[context.categoryBucket] ?? CATEGORY_PROMPTS.other;

  // Already handed off to the Dressing Room. Both navigating actions are
  // completable — the anchored session exists — which is why this state offers
  // them instead of an "Open Look" that no Look is behind.
  if (context.styled && context.owned) {
    return [
      {
        id: 'open_dressing_room',
        type: 'open_dressing_room',
        label: ELISE_IMAGE_LOOP_COPY.openDressingRoomLabel,
        accessibilityLabel: `${ELISE_IMAGE_LOOP_COPY.openDressingRoomLabel}: ${context.title}`,
      },
      {
        id: 'change_something',
        type: 'change_something',
        label: ELISE_IMAGE_LOOP_COPY.changeSomethingLabel,
        accessibilityLabel: `${ELISE_IMAGE_LOOP_COPY.changeSomethingLabel} in this Look`,
      },
      promptAction(prompts[0], 0),
    ];
  }

  if (context.owned) {
    return [
      {
        id: 'style_this_item',
        type: 'style_this_item',
        label: ELISE_IMAGE_LOOP_COPY.styleThisItemLabel,
        accessibilityLabel: `${ELISE_IMAGE_LOOP_COPY.styleThisItemLabel}: ${context.title}`,
      },
      promptAction(prompts[1] ?? prompts[0], 1),
      promptAction(prompts[0], 0),
    ];
  }

  // Not owned. The save control is an OFFER, never a gate: the two prompts above
  // it work whether or not the user ever saves.
  //
  // POST-ANSWER ONLY, and that is a deliberate boundary rather than a missing
  // state. The repaired attachment chip already carries its own Save / Retry
  // save control from the moment the photo is attached, and that repair is not
  // being redesigned here; offering a second Save button directly beneath it,
  // for the same item, in the same stack, would be two controls for one action.
  // What this build adds is the progression AFTER Elise has answered — which is
  // exactly where the user has a reason to keep the piece and no affordance
  // suggested it. Before the first send the row is two questions, which is still
  // inside the 2–3 bound.
  const answered =
    context.attachmentState === 'sent' || context.attachmentState === 'send_failed';
  const saveAction: EliseFollowUpAction | null = !answered
    ? null
    : context.closetState === 'saving'
      ? {
          id: 'save_to_closet',
          type: 'save_to_closet',
          label: ELISE_IMAGE_LOOP_COPY.savingLabel,
          accessibilityLabel: `${ELISE_IMAGE_LOOP_COPY.savingLabel} ${context.title}`,
          busy: true,
        }
      : {
          id: 'save_to_closet',
          type: 'save_to_closet',
          label:
            context.closetState === 'save_failed'
              ? ELISE_IMAGE_LOOP_COPY.retrySaveLabel
              : ELISE_IMAGE_LOOP_COPY.saveLabel,
          accessibilityLabel:
            context.closetState === 'save_failed'
              ? `${ELISE_IMAGE_LOOP_COPY.retrySaveLabel}: save ${context.title} to Closet`
              : `${ELISE_IMAGE_LOOP_COPY.saveLabel}: ${context.title}`,
        };

  // Before the first send the generic opener leads; afterwards the second
  // category prompt leads, so a follow-up is not the question just asked.
  const second = answered ? prompts[1] ?? prompts[0] : prompts[0];

  const actions = [promptAction(GENERIC_PAIRING_PROMPT, 9), promptAction(second, 1)];
  if (saveAction) actions.push(saveAction);
  return actions;
}

/** Lead-in copy above the follow-up row. State-driven; never model-authored. */
export function resolveFollowUpLeadIn(context: EliseActiveItemContext | null): string | null {
  if (!context) return null;
  if (context.styled && context.owned) return ELISE_IMAGE_LOOP_COPY.leadInStyled;
  if (context.owned) return ELISE_IMAGE_LOOP_COPY.leadInSaved;
  if (context.attachmentState === 'sent' || context.attachmentState === 'send_failed') {
    // "Like this piece?" only where a save is actually being offered; a saving
    // item is mid-transaction and being asked again would be noise.
    return context.closetState === 'saving'
      ? ELISE_IMAGE_LOOP_COPY.leadInSaved
      : ELISE_IMAGE_LOOP_COPY.leadInSavePrompt;
  }
  return ELISE_IMAGE_LOOP_COPY.leadInUnsent;
}

/** Accessible, honest one-line description of ownership. Never implies ownership. */
export function describeClosetState(context: EliseActiveItemContext): string {
  if (context.owned) return ELISE_IMAGE_LOOP_COPY.savedBadge;
  if (context.closetState === 'saving') return ELISE_IMAGE_LOOP_COPY.savingBadge;
  if (context.closetState === 'save_failed') return ELISE_IMAGE_LOOP_COPY.saveFailedBadge;
  return ELISE_IMAGE_LOOP_COPY.unsavedBadge;
}
