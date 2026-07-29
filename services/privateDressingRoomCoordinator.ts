/**
 * Private Dressing Room workspace resolution.
 *
 * PURE, and deliberately separate from the React hook that drives it. Everything
 * here is a function of inputs the hook has already gathered — actor state,
 * Closet state, the stored session, the route parameter — so the ordering rules
 * that actually matter can be tested without a renderer.
 *
 * THE ORDERING RULE THIS FILE EXISTS TO ENFORCE:
 *
 *     nothing is "missing" until everything it depends on has finished loading
 *
 * An anchor is not missing while the Closet is still loading, and a route item
 * is not unknown while the actor is still resolving. Getting that wrong shows
 * the user "this garment is gone" during a perfectly normal cold start, so the
 * gate is structural here rather than a condition each screen remembers.
 *
 * The coordinator does not generate outfits, call Elise, save Looks, open
 * commerce, mutate Closet records, or touch a collaborative room. It resolves
 * which of a fixed set of workspace states is true, and nothing else.
 */

import { PRIVATE_DRESSING_ROOM_SESSION_BOUNDS } from '../types/privateDressingRoomSession';
import type {
  PrivateDressingRoomSession,
  PrivateDressingRoomSessionErrorCode,
} from '../types/privateDressingRoomSession';
import { PRIVATE_SLOT_DISPLAY_ORDER } from '../types/privateDressingRoomComposition';
import type { PrivateSwapResultCode } from '../types/privateDressingRoomInteraction';
import type {
  PrivateDressingRoomSlot,
  PrivateLookCompleteness,
} from '../types/privateDressingRoomComposition';
import type { ClosetItemProjection } from './closetItemProjection';

/**
 * How the actor-scoped Closet read finished.
 *
 * KNOWN LIMITATION, stated rather than hidden: services/closetLibrary.js
 * `loadCloset` catches every internal error and returns `[]`, so a genuine read
 * failure is indistinguishable from an empty Closet at that boundary. This
 * coordinator models the two states separately and the hook reports `failed`
 * only when the call itself rejects. Making the distinction complete requires a
 * typed load result from the Closet domain, which Phase 1 must not change.
 */
export type ClosetLoadStatus = 'loading' | 'loaded' | 'failed';

export type PrivateWorkspaceStatus =
  | 'feature_disabled'
  | 'actor_loading'
  | 'actor_unavailable'
  | 'closet_loading'
  | 'closet_failed'
  | 'session_unrecoverable'
  | 'no_session'
  | 'active';

export type PrivateWorkspaceView = {
  status: PrivateWorkspaceStatus;
  session: PrivateDressingRoomSession | null;
  /** The resolved anchor projection, or null when there is none / it is gone. */
  anchor: ClosetItemProjection | null;
  /** The session references an anchor the Closet can no longer resolve. */
  anchorMissing: boolean;
  /** True only once the Closet has actually loaded and holds nothing. */
  closetEmpty: boolean;
  closetItems: readonly ClosetItemProjection[];
  /** A route-supplied closetItemId that does not belong to this actor's Closet. */
  routeItemUnavailable: boolean;
  /** The stored session was restored from the backup copy. */
  recoveredFromBackup: boolean;
  errorCode: PrivateDressingRoomSessionErrorCode | null;
  /** An explicit user-driven reset can clear the current failure. */
  canReset: boolean;
};

/** The session-store result shape the coordinator consumes. */
export type CoordinatorSessionInput = {
  ok: boolean;
  session: PrivateDressingRoomSession | null;
  recovered: 'primary' | 'backup' | 'none';
  errorCode: PrivateDressingRoomSessionErrorCode | null;
  recoverable: boolean;
} | null;

/**
 * Normalize a route-supplied Closet item id.
 *
 * Treated as an OPAQUE REQUEST, never as authority. expo-router hands back
 * `string | string[] | undefined`, so an array — which is what a duplicated
 * query parameter produces — is refused rather than silently taking its first
 * element. The bound is the session contract's own id ceiling, so a link cannot
 * push an unbounded string into a comparison loop.
 *
 * Returning a value here means only "this is a well-formed request". Whether it
 * names a garment this actor owns is decided later, against the loaded Closet.
 */
export function normalizeRouteClosetItemId(value: unknown): string | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length > PRIVATE_DRESSING_ROOM_SESSION_BOUNDS.anchorClosetItemId) return null;
  return text;
}

function findProjection(
  items: readonly ClosetItemProjection[],
  id: string | null,
): ClosetItemProjection | null {
  if (!id) return null;
  for (const item of items) {
    if (item && item.id === id) return item;
  }
  return null;
}

const EMPTY_VIEW: Omit<PrivateWorkspaceView, 'status'> = {
  session: null,
  anchor: null,
  anchorMissing: false,
  closetEmpty: false,
  closetItems: [],
  routeItemUnavailable: false,
  recoveredFromBackup: false,
  errorCode: null,
  canReset: false,
};

/**
 * Resolve the single workspace state that is true right now.
 *
 * The order of the gates below IS the loading sequence: feature, actor, Closet,
 * session, then reconciliation. Each gate returns early precisely so that a
 * later gate can assume everything before it has resolved.
 */
export function resolvePrivateWorkspaceView(input: {
  enabled: boolean;
  actorLoading: boolean;
  closetStatus: ClosetLoadStatus;
  closetItems: readonly ClosetItemProjection[];
  session: CoordinatorSessionInput;
  routeClosetItemId?: unknown;
}): PrivateWorkspaceView {
  if (!input.enabled) return { ...EMPTY_VIEW, status: 'feature_disabled' };

  // The actor gate comes before the Closet gate because an unresolved actor
  // means we do not yet know WHOSE Closet to read.
  if (input.actorLoading) return { ...EMPTY_VIEW, status: 'actor_loading' };

  if (input.closetStatus === 'loading') return { ...EMPTY_VIEW, status: 'closet_loading' };

  // A Closet that failed to load is NOT an empty Closet. Conflating them would
  // invite the user to start building an outfit from a wardrobe that is merely
  // unreadable right now.
  if (input.closetStatus === 'failed') return { ...EMPTY_VIEW, status: 'closet_failed' };

  const closetItems = Array.isArray(input.closetItems) ? input.closetItems : [];
  const closetEmpty = closetItems.length === 0;

  // The session has not been read yet.
  if (!input.session) {
    return { ...EMPTY_VIEW, status: 'closet_loading', closetItems, closetEmpty };
  }

  if (!input.session.ok) {
    const code = input.session.errorCode;
    const actorProblem = code === 'missing_actor_context' || code === 'stale_actor_context';
    return {
      ...EMPTY_VIEW,
      status: actorProblem ? 'actor_unavailable' : 'session_unrecoverable',
      closetItems,
      closetEmpty,
      errorCode: code,
      canReset: !actorProblem && input.session.recoverable === true,
    };
  }

  const routeId = normalizeRouteClosetItemId(input.routeClosetItemId);
  const routeMatch = findProjection(closetItems, routeId);
  // A route id that is unknown, or belongs to another actor, is reported the
  // SAME way: unavailable. The workspace must not become an oracle for whether
  // some other account owns a given garment.
  const routeItemUnavailable = routeId !== null && routeMatch === null;

  const session = input.session.session;
  const recoveredFromBackup = input.session.recovered === 'backup';

  if (!session) {
    return {
      ...EMPTY_VIEW,
      status: 'no_session',
      closetItems,
      closetEmpty,
      routeItemUnavailable,
      recoveredFromBackup,
    };
  }

  const anchor = findProjection(closetItems, session.anchorClosetItemId);
  // Safe to compute now, and only now: the Closet has loaded, so "not found"
  // genuinely means the garment is gone rather than not yet read.
  const anchorMissing = session.anchorClosetItemId !== null && anchor === null;

  return {
    status: 'active',
    session,
    anchor,
    anchorMissing,
    closetEmpty,
    closetItems,
    routeItemUnavailable,
    recoveredFromBackup,
    errorCode: null,
    canReset: false,
  };
}

/**
 * Decide what a route-supplied Closet item should do to the stored session.
 *
 * Returns the anchor to persist, or null when the route asked for nothing
 * actionable. Deliberately conservative: an unresolved or unowned id is never
 * written, so a crafted link cannot park a foreign id in the user's session.
 */
export function resolveRouteAnchorIntent(view: PrivateWorkspaceView, routeValue: unknown): string | null {
  const routeId = normalizeRouteClosetItemId(routeValue);
  if (!routeId) return null;
  if (view.status !== 'active' && view.status !== 'no_session') return null;
  if (view.routeItemUnavailable) return null;
  if (findProjection(view.closetItems, routeId) === null) return null;
  if (view.session && view.session.anchorClosetItemId === routeId) return null;
  return routeId;
}

// ── Composition (Phase 2) ────────────────────────────────────────────────────

/**
 * Serializable coordinator error codes.
 *
 * A raw exception, a stack trace or a filesystem path must never reach the UI,
 * so every failure the workspace can be in is one of these.
 */
export const PRIVATE_WORKSPACE_ERRORS = [
  'FEATURE_DISABLED',
  'ACTOR_UNAVAILABLE',
  'ACTOR_CHANGED',
  'CLOSET_LOAD_FAILED',
  'CLOSET_EMPTY',
  'SESSION_MISSING',
  'SESSION_CONTEXT_REQUIRED',
  'ANCHOR_MISSING',
  'UNSUPPORTED_ANCHOR',
  'INSUFFICIENT_ITEMS',
  'COMPOSITION_STALE',
  'COMPOSITION_CORRUPT',
  'COMPOSITION_FAILED',
  'PERSISTENCE_FAILED',
] as const;

export type PrivateWorkspaceErrorCode = (typeof PRIVATE_WORKSPACE_ERRORS)[number];

export type PrivateCompositionStatus =
  /** No anchor and no occasion yet: there is nothing to compose around. */
  | 'idle'
  | 'building'
  | 'ready'
  | 'partial'
  | 'stale'
  | 'corrupt'
  | 'failed'
  | 'insufficient';

export type ResolvedLookItem = {
  slot: PrivateDressingRoomSlot;
  closetItemId: string;
  /** null when the garment has been deleted from the Closet since composing. */
  item: ClosetItemProjection | null;
};

export type ResolvedLook = {
  lookId: string;
  rank: number;
  completeness: PrivateLookCompleteness;
  missingSlots: PrivateDressingRoomSlot[];
  labelCodes: readonly string[];
  /** Slot order for display: anchor first, then outward-in layering order. */
  items: ResolvedLookItem[];
  itemCount: number;
  missingCount: number;
  isActive: boolean;
  /** A referenced garment is gone, so this option can no longer be worn as-is. */
  stale: boolean;
};

/**
 * Turn a stored composition into display-ready looks.
 *
 * PURE, and the only place a stored `closetItemId` becomes a garment: every
 * item is resolved against the CURRENT projections, so a deleted garment
 * surfaces as `item: null` instead of stale metadata the composition never
 * carried in the first place.
 *
 * The anchor is ordered FIRST because it is the thing the user chose; the
 * remaining slots follow the layering order the contract declares.
 */
export function resolveCompositionLooks(input: {
  looks: readonly {
    lookId: string;
    rank: number;
    completeness: PrivateLookCompleteness;
    missingSlots: readonly PrivateDressingRoomSlot[];
    labelCodes: readonly string[];
    items: readonly { slot: PrivateDressingRoomSlot; closetItemId: string }[];
  }[];
  closetItems: readonly ClosetItemProjection[];
  activeLookId?: string | null;
  anchorClosetItemId?: string | null;
}): ResolvedLook[] {
  const byId = new Map<string, ClosetItemProjection>();
  for (const item of input.closetItems ?? []) {
    if (item && typeof item.id === 'string') byId.set(item.id, item);
  }
  const anchorId = input.anchorClosetItemId ?? null;

  const resolved: ResolvedLook[] = [];
  for (const look of input.looks ?? []) {
    const ordered = [...look.items].sort((a, b) => {
      if (anchorId) {
        if (a.closetItemId === anchorId && b.closetItemId !== anchorId) return -1;
        if (b.closetItemId === anchorId && a.closetItemId !== anchorId) return 1;
      }
      return (
        PRIVATE_SLOT_DISPLAY_ORDER.indexOf(a.slot) - PRIVATE_SLOT_DISPLAY_ORDER.indexOf(b.slot)
      );
    });
    const items = ordered.map((entry) => ({
      slot: entry.slot,
      closetItemId: entry.closetItemId,
      item: byId.get(entry.closetItemId) ?? null,
    }));
    resolved.push({
      lookId: look.lookId,
      rank: look.rank,
      completeness: look.completeness,
      missingSlots: [...look.missingSlots],
      labelCodes: [...look.labelCodes],
      items,
      itemCount: items.length,
      missingCount: look.missingSlots.length,
      isActive: !!input.activeLookId && input.activeLookId === look.lookId,
      stale: items.some((entry) => entry.item === null),
    });
  }
  return resolved.sort((a, b) => a.rank - b.rank);
}

/**
 * Is this session context enough to compose from?
 *
 * EITHER a resolvable anchor OR a non-empty occasion. Requiring both would
 * refuse to help a user who has said "somewhere smart" but not yet picked a
 * garment, and vice versa.
 */
export function isCompositionReady(input: {
  session: PrivateDressingRoomSession | null | undefined;
  anchorMissing: boolean;
}): boolean {
  const session = input.session;
  if (!session || session.status !== 'active') return false;
  const hasAnchor = !!session.anchorClosetItemId && !input.anchorMissing;
  const hasOccasion = typeof session.occasion === 'string' && session.occasion.trim().length > 0;
  return hasAnchor || hasOccasion;
}

/** Map a composer result code onto the workspace's own vocabulary. */
export function compositionStatusForComposerCode(code: string): {
  status: PrivateCompositionStatus;
  errorCode: PrivateWorkspaceErrorCode | null;
} {
  switch (code) {
    case 'SUCCESS':
      return { status: 'ready', errorCode: null };
    case 'SUCCESS_PARTIAL':
      return { status: 'partial', errorCode: null };
    case 'CLOSET_LOAD_FAILED':
      return { status: 'failed', errorCode: 'CLOSET_LOAD_FAILED' };
    case 'CLOSET_EMPTY':
      return { status: 'insufficient', errorCode: 'CLOSET_EMPTY' };
    case 'SESSION_CONTEXT_REQUIRED':
      return { status: 'idle', errorCode: 'SESSION_CONTEXT_REQUIRED' };
    case 'ANCHOR_MISSING':
      return { status: 'failed', errorCode: 'ANCHOR_MISSING' };
    case 'UNSUPPORTED_ANCHOR':
      return { status: 'insufficient', errorCode: 'UNSUPPORTED_ANCHOR' };
    case 'INSUFFICIENT_ITEMS':
      return { status: 'insufficient', errorCode: 'INSUFFICIENT_ITEMS' };
    case 'ACTOR_CHANGED':
      return { status: 'failed', errorCode: 'ACTOR_CHANGED' };
    default:
      return { status: 'failed', errorCode: 'COMPOSITION_FAILED' };
  }
}

/**
 * Whether a user-initiated Rebuild should be offered.
 *
 * Deliberately NOT offered on a valid, unchanged composition: repeated rebuilds
 * are deterministic and would return the same outfits, so a button promising
 * new ones would be lying about what the composer does.
 */
export function canRebuildComposition(status: PrivateCompositionStatus): boolean {
  return status === 'stale' || status === 'corrupt' || status === 'insufficient';
}

/** Whether a Retry should be offered — a failed operation, not a bad context. */
export function canRetryComposition(errorCode: PrivateWorkspaceErrorCode | null): boolean {
  return (
    errorCode === 'CLOSET_LOAD_FAILED' ||
    errorCode === 'PERSISTENCE_FAILED' ||
    errorCode === 'COMPOSITION_FAILED'
  );
}

// ── Slot editing (Phase 3) ───────────────────────────────────────────────────

export type PrivateSlotEditorStatus =
  | 'closed'
  | 'loading'
  | 'ready'
  | 'no_candidates'
  | 'anchor_locked'
  | 'applying'
  | 'failed';

/**
 * EPHEMERAL preview identity.
 *
 * A preview is not merely "the candidate the user tapped" — it carries enough
 * context to PROVE what is being applied. Apply consults this, never an
 * arbitrary id handed in by the UI, so a candidate that was previewed under a
 * context that has since moved cannot be committed.
 *
 * `generation` increments on every new preview, which is what makes the
 * Preview A → Preview B → Apply A race rejectable: A's generation is no longer
 * current even though its look, slot and candidate all still look plausible.
 *
 * Never persisted. Cleared on apply, cancel, editor close, context change,
 * route exit and app background.
 */
export type PrivateSlotPreview = {
  generation: number;
  lookId: string;
  slot: PrivateDressingRoomSlot;
  candidateClosetItemId: string;
  sessionId: string;
  compositionId: string;
  inputFingerprint: string;
  actorEpoch: number;
};

export type PrivateSlotPreviewRequest = Omit<PrivateSlotPreview, 'generation'>;

/**
 * May this preview be applied?
 *
 * Every identity component must still match. Returning a REASON rather than a
 * boolean keeps the rejection explainable — the UI needs to distinguish "you
 * previewed something else" from "your account changed".
 */
export function validatePreviewForApply(
  preview: PrivateSlotPreview | null | undefined,
  request: {
    generation: number;
    lookId: string;
    slot: PrivateDressingRoomSlot;
    candidateClosetItemId: string;
    sessionId: string;
    compositionId: string;
    inputFingerprint: string;
    actorEpoch: number;
  },
): { ok: boolean; reason: PrivateSwapResultCode | null } {
  if (!preview) return { ok: false, reason: 'STALE_PREVIEW' };
  if (preview.generation !== request.generation) return { ok: false, reason: 'STALE_PREVIEW' };
  if (preview.lookId !== request.lookId) return { ok: false, reason: 'STALE_PREVIEW' };
  if (preview.slot !== request.slot) return { ok: false, reason: 'STALE_PREVIEW' };
  if (preview.candidateClosetItemId !== request.candidateClosetItemId) {
    return { ok: false, reason: 'STALE_PREVIEW' };
  }
  if (preview.actorEpoch !== request.actorEpoch) return { ok: false, reason: 'ACTOR_CHANGED' };
  if (
    preview.sessionId !== request.sessionId ||
    preview.compositionId !== request.compositionId ||
    preview.inputFingerprint !== request.inputFingerprint
  ) {
    return { ok: false, reason: 'INTERACTION_STALE' };
  }
  return { ok: true, reason: null };
}

/**
 * Would changing the anchor or occasion discard work the user can see?
 *
 * Only then is a destructive-change confirmation warranted; asking on an
 * untouched workspace would be noise.
 */
export function contextChangeDiscardsWork(input: {
  hasOverrides: boolean;
  hasHistory: boolean;
  hasComparison: boolean;
  hasPreview: boolean;
}): boolean {
  return !!(
    input?.hasOverrides ||
    input?.hasHistory ||
    input?.hasComparison ||
    input?.hasPreview
  );
}

/**
 * Why Undo is or is not offered.
 *
 * `blocked_prior_item_missing` is the case the store already refuses: the
 * newest operation would put back a garment that has since left the Closet, and
 * restoring it would resurrect something the user does not own. Surfacing it as
 * state rather than as a post-tap failure is what lets the route disable the
 * control and say why.
 */
export type PrivateUndoAvailability =
  | 'available'
  | 'empty'
  | 'blocked_prior_item_missing'
  | 'busy';

/**
 * Resolve Undo availability from the NEWEST history operation only.
 *
 * Deliberately never inspects older operations: undo is strictly sequential, so
 * a blocked newest operation blocks the whole stack rather than silently
 * skipping to one that still works.
 *
 * A Closet that did not load is NOT evidence that the prior item is gone — with
 * no projections we cannot tell, so nothing is claimed and the control stays
 * enabled for the store to adjudicate. This is the same rule that keeps a
 * Closet fault from being reported as a missing swapped item.
 */
export function resolveUndoAvailability(input: {
  interactionsEnabled: boolean;
  busy: boolean;
  closetLoaded: boolean;
  historyLength: number;
  newestBeforeClosetItemId: string | null;
  availableClosetItemIds: readonly string[];
}): PrivateUndoAvailability {
  if (!input?.interactionsEnabled) return 'empty';
  if (!input.historyLength || input.historyLength <= 0) return 'empty';

  // A fill has no prior item to restore, so it can never be blocked this way.
  const before = input.newestBeforeClosetItemId ?? null;
  if (before !== null && input.closetLoaded) {
    const available = input.availableClosetItemIds ?? [];
    if (!available.includes(before)) return 'blocked_prior_item_missing';
  }

  // Checked last: a blocked undo stays blocked while an unrelated operation
  // runs, rather than briefly looking merely busy.
  if (input.busy) return 'busy';
  return 'available';
}

/** Copy for each workspace state. Kept here so both platforms read identically. */
export const PRIVATE_WORKSPACE_COPY = Object.freeze({
  actorLoading: 'Getting things ready…',
  actorUnavailable: 'Sign in to use your Dressing Room.',
  closetLoading: 'Loading your Closet…',
  closetFailed: "We couldn't open your Closet just now.",
  closetEmpty: 'Add something to your Closet to build an outfit around it.',
  noSession: 'Start a Dressing Room to build an outfit around a piece you own.',
  unrecoverable: "We couldn't restore your previous Dressing Room session.",
  futureSchema: 'This session was created by a newer version of K Scan.',
  recovered: 'We restored your Dressing Room session.',
  anchorMissing: "The piece you were building around isn't in your Closet anymore.",
  routeItemUnavailable: "That piece isn't in your Closet.",
  ready: 'Your Dressing Room is ready for outfit building.',
  reset: 'Reset session',
  discard: 'Discard session',
  // Phase 2 composition copy. Specific about a missing garment, general about a
  // system fault, and never blaming the user for their wardrobe.
  building: 'Putting outfits together…',
  compositionStale: 'Your Closet changed, so these outfits need to be rebuilt.',
  compositionCorrupt:
    "We couldn't restore your previous outfits. Reset and rebuild them from your current Closet.",
  compositionFailed: "We couldn't build outfits just now. Try again.",
  persistenceFailed: "We couldn't save that. Try again.",
  insufficient:
    'Your Closet does not have enough compatible pieces to complete an outfit around this yet.',
  unsupportedAnchor: "We can't build an outfit around this kind of item yet.",
  lookStale: 'One of these pieces is no longer in your Closet.',
  rebuild: 'Rebuild outfits',
  retry: 'Try again',
  returnToCloset: 'Return to Closet',
  noPurchaseNeeded: 'No purchase needed',
  // Phase 3 slot editing. States what happened, gives one action, blames nobody.
  anchorLocked: 'Change the anchor from the Dressing Room header.',
  noAlternatives: "We couldn't find another Closet item for this slot.",
  applyFailed: "We couldn't save this change. Try again.",
  interactionCorrupt:
    "We couldn't restore your outfit edits. Reset the edits to return to the generated outfits.",
  swappedItemMissing: 'This swapped item is no longer in your Closet.',
  stalePreview: 'That option is no longer selected. Choose it again.',
  priorItemUnavailable: "The item we'd put back is no longer in your Closet.",
  // Shown next to a DISABLED Undo, before the user taps it. States what is
  // unavailable, why, and that the outfit they are looking at has not changed.
  undoBlockedPriorItemMissing:
    'The previous item is no longer in your Closet, so this change cannot be undone. Your outfit has not changed.',
  swapAction: 'Swap',
  chooseItem: 'Choose item',
  anchorLockedLabel: 'Locked anchor',
  applySwap: 'Apply swap',
  cancelSwap: 'Cancel',
  undo: 'Undo last change',
  restoreOriginal: 'Restore original',
  resetEdits: 'Reset edits',
  chooseAnother: 'Choose another item',
  addToCloset: 'Add an item to your Closet',
  editsDiscardedAnchor: 'Changing the anchor will discard your current outfit edits. Continue?',
  editsDiscardedOccasion:
    'Changing the occasion will discard your current outfit edits. Continue?',
  keepEditing: 'Keep my edits',
  continueChange: 'Continue',
});

/** User-facing strings for the bounded look-label codes. */
export const PRIVATE_LOOK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  NO_PURCHASE_NEEDED: 'No purchase needed',
  PARTIAL_LOOK: 'Missing a piece',
  MORE_CASUAL: 'More casual',
  MORE_POLISHED: 'More polished',
  EVENING_OPTION: 'Evening option',
  NEUTRAL_OPTION: 'Neutral palette',
});

/** "Missing shoes", "Missing a top" — specific, never a generic apology. */
export function describeMissingSlots(slots: readonly PrivateDressingRoomSlot[]): string | null {
  if (!slots || slots.length === 0) return null;
  const names: Record<PrivateDressingRoomSlot, string> = {
    top: 'a top',
    bottom: 'a bottom',
    dress: 'a dress',
    outerwear: 'a layer',
    footwear: 'shoes',
    accessory: 'an accessory',
  };
  const listed = slots.map((slot) => names[slot]).filter(Boolean);
  if (listed.length === 0) return null;
  if (listed.length === 1) return `Missing ${listed[0]}`;
  if (listed.length === 2) return `Missing ${listed[0]} and ${listed[1]}`;
  return `Missing ${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
}
