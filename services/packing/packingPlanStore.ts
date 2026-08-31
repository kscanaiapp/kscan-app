// K+ Packing Intelligence V1 — active plan state.
//
// PERSISTENCE DECISION (build plan section 18, Option A). Packing V1 creates NO
// new table and NO new durable personal-travel data class.
//
// V1 IS IN-MEMORY ONLY, AND THAT IS THE WHOLE STORY. The active plan lives in
// the actor-bound process state below and NOWHERE ELSE. Nothing in Packing
// writes style_chat_messages, ui_blocks, AsyncStorage or any other durable
// record, and there is no resume path that restores a plan.
//
// CONCRETELY, for anything built on top of this:
//   - a plan does NOT survive an app restart or a process kill
//   - a plan is NOT restored when a StyleChat session is resumed
//   - the trip (destination, dates, notes) is likewise never written down
//   - the ONLY durable consequence of generating a plan is the Elise quota
//     counter the backend increments
//
// This is a deliberate V1 scope decision, not an omission: durable trip history
// would be a new personal-data class and needs its own privacy, export and
// deletion story. Persisting a plan is therefore a FUTURE change with owner
// sign-off, not a gap to be quietly filled by a downstream feature.
//
// THE STORE IS ACTOR-BOUND, NOT JUST ACTOR-LABELLED. Every read requires the
// caller to name the actor it is reading for, and a snapshot stamped with a
// different actor is refused rather than returned. That is what makes "User A
// signs out, User B signs in" safe even if a reset were somehow missed --
// clearing on the auth boundary (resetPackingPlanState, wired into
// AuthSessionContext) is the primary mechanism, and this is the backstop.

import type { PackingGeneralGuide, PackingPlan, PackingTripDraft } from '../../types/packing';

export interface PackingSnapshot {
  /** null while signed out, or immediately after an actor boundary. */
  actorId: string | null;
  sessionId: string | null;
  trip: PackingTripDraft | null;
  plan: PackingPlan | null;
  generalGuide: PackingGeneralGuide | null;
  message: string | null;
  /** Item ids the traveller removed for this trip. Session intent, never a preference. */
  excludedItemIds: string[];
  /** Free-text refinements for this trip. Session intent, never a preference. */
  constraintNotes: string[];
  packLight: boolean;
  status: 'idle' | 'generating' | 'ready' | 'general' | 'failed';
  errorCode: string | null;
  retryable: boolean;
}

const EMPTY: PackingSnapshot = {
  actorId: null,
  sessionId: null,
  trip: null,
  plan: null,
  generalGuide: null,
  message: null,
  excludedItemIds: [],
  constraintNotes: [],
  packLight: false,
  status: 'idle',
  errorCode: null,
  retryable: false,
};

let snapshot: PackingSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeToPackingPlan(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The raw snapshot. Callers that render MUST use getPackingSnapshotFor so a
 * previous actor's plan can never reach the screen.
 */
export function getPackingSnapshot(): PackingSnapshot {
  return snapshot;
}

/** Returns the snapshot only when it belongs to `actorId`. Otherwise empty. */
export function getPackingSnapshotFor(actorId: string | null): PackingSnapshot {
  if (!actorId || snapshot.actorId !== actorId) return EMPTY;
  return snapshot;
}

function update(actorId: string, patch: Partial<PackingSnapshot>): void {
  // A write for a different actor than the one currently held resets first, so
  // a late completion from the previous account cannot merge into the new one.
  const base = snapshot.actorId === actorId ? snapshot : { ...EMPTY, actorId };
  snapshot = { ...base, ...patch, actorId };
  emit();
}

export function beginPackingRequest(input: {
  actorId: string;
  sessionId: string;
  trip: PackingTripDraft;
  excludedItemIds?: string[];
  constraintNotes?: string[];
  packLight?: boolean;
}): void {
  update(input.actorId, {
    sessionId: input.sessionId,
    trip: input.trip,
    status: 'generating',
    // The previous plan stays visible underneath a regeneration so the screen
    // does not blank out; it is replaced only when a new one actually arrives.
    errorCode: null,
    retryable: false,
    excludedItemIds: input.excludedItemIds ?? snapshot.excludedItemIds,
    constraintNotes: input.constraintNotes ?? snapshot.constraintNotes,
    packLight: input.packLight ?? snapshot.packLight,
  });
}

export function applyPackingPlan(input: {
  actorId: string;
  plan: PackingPlan;
  message: string;
}): void {
  update(input.actorId, {
    plan: input.plan,
    generalGuide: null,
    message: input.message,
    status: 'ready',
    errorCode: null,
    retryable: false,
    // The plan the server returned is now the authority for what is excluded.
    excludedItemIds: input.plan.constraints.excludedItemIds,
    constraintNotes: input.plan.constraints.notes,
    packLight: input.plan.constraints.packLight,
  });
}

export function applyPackingGeneralGuide(input: {
  actorId: string;
  guide: PackingGeneralGuide | null;
  message: string;
}): void {
  update(input.actorId, {
    plan: null,
    generalGuide: input.guide,
    message: input.message,
    status: 'general',
    errorCode: null,
    retryable: false,
  });
}

export function applyPackingFailure(input: {
  actorId: string;
  message: string;
  errorCode: string | null;
  retryable: boolean;
}): void {
  update(input.actorId, {
    message: input.message,
    status: 'failed',
    errorCode: input.errorCode,
    retryable: input.retryable,
  });
}

/**
 * Session-scoped exclusion. "Do not bring the boots on this trip" is a task
 * instruction, never a wardrobe preference and never a Signature Style edit --
 * it lives and dies with this plan (build plan section 51).
 */
export function excludePackingItem(actorId: string, itemId: string): string[] {
  const current = getPackingSnapshotFor(actorId);
  const next = current.excludedItemIds.includes(itemId)
    ? current.excludedItemIds
    : [...current.excludedItemIds, itemId];
  update(actorId, { excludedItemIds: next });
  return next;
}

export function addPackingConstraintNote(actorId: string, note: string): string[] {
  const trimmed = note.trim().slice(0, 300);
  if (!trimmed) return getPackingSnapshotFor(actorId).constraintNotes;
  const current = getPackingSnapshotFor(actorId);
  const next = [...current.constraintNotes, trimmed].slice(-8);
  update(actorId, { constraintNotes: next });
  return next;
}

export function setPackingPackLight(actorId: string, packLight: boolean): void {
  update(actorId, { packLight });
}

/**
 * Cleared on sign-out, sign-in and user change alike, from
 * AuthSessionContext.resetActorScopedRuntimeState -- the one place this project
 * resets actor-scoped runtime state. No second auth cache.
 */
export function resetPackingPlanState(): void {
  snapshot = EMPTY;
  emit();
}
