// Private Dressing Room interaction state (Build 3: Dressing Rooms V1, Phase 3).
//
// THE SEPARATION THIS FILE EXISTS TO ENFORCE:
//
//     composition  = what the composer generated      (immutable)
//     interaction  = what the user did to it          (this domain)
//     effective    = composition + interaction        (derived, never stored)
//
// Phase 2's PrivateDressingRoomCompositionSet is a deterministic generated
// baseline. Editing it in place would destroy the property that makes it worth
// having: that the same inputs reproduce the same outfits. So user edits live
// here instead, as OVERRIDES layered on top, and the visible look is derived at
// render time. That is also what lets undo restore an exact prior state, lets a
// rebuild discard edits by simply dropping this record, and lets an auditor read
// generation and mutation separately.
//
// REFERENCES, NEVER COPIES — same rule as the composition domain. An override
// stores a slot and a closetItemId. Title, brand, colour, material and image
// stay in the Build 2 Closet.
//
// NOT IN THIS DOMAIN: Saved Looks, commerce, retailers, sharing, voting, Elise,
// and REDO. Undo is a stack, not a timeline: there is deliberately no forward
// history, no branching, and no way to replay a discarded edit.

import type { PrivateDressingRoomSlot } from './privateDressingRoomComposition';

export const PRIVATE_INTERACTION_SCHEMA_VERSION = 1 as const;
export const PRIVATE_INTERACTION_MAX_SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Hard bounds. An undo stack, not an audit log.
 *
 * 20 operations is the persisted ceiling; operation 21 drops the oldest and
 * keeps the newest 20. Comparison is exactly two looks or none — one selected
 * look is not a comparison and is never persisted as one.
 */
export const PRIVATE_INTERACTION_BOUNDS = Object.freeze({
  maxHistory: 20,
  maxCandidates: 20,
  comparedLooks: 2,
  /** One apply changes exactly one slot. This is the whole safety model. */
  slotsPerOperation: 1,
  interactionId: 200,
  operationId: 200,
  lookId: 200,
  sessionId: 200,
  compositionId: 200,
  actorId: 200,
  closetItemId: 200,
  inputFingerprint: 1200,
  /** A look cannot hold more overrides than it has slots. */
  overridesPerLook: 6,
});

/**
 * What a single operation did.
 *
 * The three kinds are distinguished because UNDO differs for each: undoing a
 * fill must return the slot to missing (not to an item that was never there),
 * and undoing a restore must reapply the override the user had chosen.
 */
export const PRIVATE_SWAP_KINDS = ['replace', 'fill', 'restore'] as const;
export type PrivateSwapKind = (typeof PRIVATE_SWAP_KINDS)[number];

export function isPrivateSwapKind(value: unknown): value is PrivateSwapKind {
  return typeof value === 'string' && (PRIVATE_SWAP_KINDS as readonly string[]).includes(value);
}

/**
 * One applied slot change.
 *
 * `beforeClosetItemId` is null ONLY for a fill, where the slot genuinely held
 * nothing. Every kind — including restore-original — appends one of these, so
 * the undo timeline has no special cases and no operation is invisible to it.
 */
export type PrivateDressingRoomSwapOperation = {
  operationId: string;
  lookId: string;
  slot: PrivateDressingRoomSlot;
  kind: PrivateSwapKind;
  /** null means the slot was missing before this operation. */
  beforeClosetItemId: string | null;
  /** The item the slot holds after this operation. Never null. */
  afterClosetItemId: string;
  appliedAt: string;
};

/** The current replacement for one slot of one look. At most one per slot. */
export type PrivateDressingRoomSlotOverride = {
  slot: PrivateDressingRoomSlot;
  closetItemId: string;
  /** The operation that produced this override, for traceability. */
  operationId: string;
  appliedAt: string;
};

export type PrivateDressingRoomLookOverrides = {
  lookId: string;
  slots: PrivateDressingRoomSlotOverride[];
};

/**
 * IDENTITY IS FOUR-PART, and all four are validated on load.
 *
 * actorId + sessionId + compositionId + inputFingerprint. A new session must
 * never inherit a discarded session's edits, and a replacement composition must
 * never inherit its predecessor's overrides — remapping edits by slot into
 * freshly generated looks would silently attach a user's decision to an outfit
 * they never saw.
 */
export type PrivateDressingRoomInteractionState = {
  interactionId: string;
  actorId: string | null;
  sessionId: string;
  compositionId: string;
  inputFingerprint: string;
  overrides: PrivateDressingRoomLookOverrides[];
  history: PrivateDressingRoomSwapOperation[];
  /** Exactly zero or two distinct base Phase 2 look ids. */
  comparedLookIds: string[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: typeof PRIVATE_INTERACTION_SCHEMA_VERSION;
};

/** The complete persisted key sets. Reconstruction is allowlisted against these. */
export const PRIVATE_INTERACTION_FIELDS = Object.freeze([
  'interactionId',
  'actorId',
  'sessionId',
  'compositionId',
  'inputFingerprint',
  'overrides',
  'history',
  'comparedLookIds',
  'createdAt',
  'updatedAt',
  'schemaVersion',
]);

export const PRIVATE_LOOK_OVERRIDES_FIELDS = Object.freeze(['lookId', 'slots']);

export const PRIVATE_SLOT_OVERRIDE_FIELDS = Object.freeze([
  'slot',
  'closetItemId',
  'operationId',
  'appliedAt',
]);

export const PRIVATE_SWAP_OPERATION_FIELDS = Object.freeze([
  'operationId',
  'lookId',
  'slot',
  'kind',
  'beforeClosetItemId',
  'afterClosetItemId',
  'appliedAt',
]);

/** Typed failures. Never an exception, never a filesystem path. */
export type PrivateInteractionErrorCode =
  | 'interaction_store_unreadable'
  | 'interaction_store_future_schema'
  | 'interaction_store_corrupt'
  | 'interaction_persist_failed'
  | 'interaction_stale'
  | 'missing_actor_context'
  | 'stale_actor_context';

/** Serializable outcomes of a slot operation. */
export const PRIVATE_SWAP_RESULT_CODES = [
  'APPLIED',
  'NOTHING_TO_UNDO',
  'NO_OP',
  'ANCHOR_LOCKED',
  'STALE_PREVIEW',
  'CANDIDATE_UNAVAILABLE',
  'CANDIDATE_INELIGIBLE',
  'PRIOR_ITEM_UNAVAILABLE',
  'STRUCTURAL_CONFLICT',
  'INTERACTION_STALE',
  'PERSIST_FAILED',
  'ACTOR_CHANGED',
  'INVALID_INPUT',
] as const;

export type PrivateSwapResultCode = (typeof PRIVATE_SWAP_RESULT_CODES)[number];

/** Why a slot cannot currently be edited, or a candidate list is empty. */
export const PRIVATE_SLOT_EDIT_CODES = [
  'READY',
  'ANCHOR_LOCKED',
  'NO_CANDIDATES',
  'SLOT_NOT_EDITABLE',
  'CLOSET_LOAD_FAILED',
  'ACTOR_CHANGED',
  'INVALID_INPUT',
] as const;

export type PrivateSlotEditCode = (typeof PRIVATE_SLOT_EDIT_CODES)[number];
