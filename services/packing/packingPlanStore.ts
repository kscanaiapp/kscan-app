// K+ Packing Intelligence V1 — active plan state.
//
// PERSISTENCE DECISION (build plan section 18, Option A). Packing V1 creates NO
// new table and NO new durable personal-travel data class.
//
// THE SERVER STILL STORES NOTHING. No table, no style_chat_messages row, no
// ui_blocks, no trip history in Supabase. Generating a plan has exactly one
// durable server-side consequence: the Elise quota counter the backend
// increments.
//
// ON THE DEVICE, ONE PLAN IS NOW CACHED (UX-4). packingPlanCache.ts stores the
// most recent successful plan for the signed-in actor so someone can open their
// list on a plane. This CHANGED a previously absolute claim and the change is
// recorded here rather than left for a reader to discover:
//   - a plan DOES now survive an app restart, for the same actor, for 30 days
//   - it is device-local; it is never uploaded and never leaves the phone
//   - it is cleared on EVERY actor boundary, by resetPackingPlanState below
//   - a restored plan is marked `restoredFrom` and the screen says so; it is
//     never presented as freshly generated
//   - a plan is STILL not restored when a StyleChat session is resumed, and
//     the session id is still not a persistence handle
//
// This is a new device-local personal-data class and it carries the project's
// existing unbuilt-local-purge gap (services/accountDeletion.js), exactly as
// Recent Scans and Style DNA preferences already do. Server-side trip history
// remains a FUTURE change needing owner sign-off, not something a downstream
// feature may quietly add.
//
// THE STORE IS ACTOR-BOUND, NOT JUST ACTOR-LABELLED. Every read requires the
// caller to name the actor it is reading for, and a snapshot stamped with a
// different actor is refused rather than returned. That is what makes "User A
// signs out, User B signs in" safe even if a reset were somehow missed --
// clearing on the auth boundary (resetPackingPlanState, wired into
// AuthSessionContext) is the primary mechanism, and this is the backstop.

import type { PackingGeneralGuide, PackingPlan, PackingTripDraft } from '../../types/packing';
import { clearAllCachedPackingPlans } from './packingPlanCache';

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
  /**
   * Epoch ms when this plan was GENERATED, set only when it was restored from
   * the device cache rather than just returned by the server (UX-4). Null for a
   * live plan. The screen uses it to say plainly that the traveller is looking
   * at a stored plan and when it was made -- never to imply it is fresh.
   */
  restoredFrom: number | null;
  /** Item ids the traveller has ticked off. Device-local; never sent anywhere. */
  packedOff: string[];
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
  restoredFrom: null,
  packedOff: [],
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
    // A freshly generated plan is not a restored one, and its checklist starts
    // empty: ticks belonged to the plan they were made against, and this is a
    // different plan with different items.
    restoredFrom: null,
    packedOff: [],
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
 * Show a plan restored from the device cache (UX-4).
 *
 * Deliberately REFUSES to overwrite anything live. A cache read is async and
 * races an in-flight generation, and a stored plan silently replacing a newer
 * one is exactly the stale-state failure this feature must not have. It fills
 * an empty screen; it never competes for one.
 */
export function restoreCachedPackingPlan(input: {
  actorId: string;
  plan: PackingPlan;
  message: string | null;
  cachedAt: number;
  packedOff: string[];
}): boolean {
  const current = getPackingSnapshotFor(input.actorId);
  if (current.plan || current.generalGuide || current.status === 'generating') return false;
  update(input.actorId, {
    plan: input.plan,
    generalGuide: null,
    message: input.message,
    status: 'ready',
    errorCode: null,
    retryable: false,
    excludedItemIds: input.plan.constraints.excludedItemIds,
    constraintNotes: input.plan.constraints.notes,
    packLight: input.plan.constraints.packLight,
    restoredFrom: input.cachedAt,
    packedOff: input.packedOff,
  });
  return true;
}

/**
 * Tick or untick one packed item.
 *
 * PURELY LOCAL. This is the traveller marking their own suitcase, not an edit
 * to the plan and emphatically not an edit to the Closet: nothing here calls
 * the server, and no ticked item is added to, removed from or altered in
 * user_closet_items. Ownership state is not something a checkbox may change.
 */
export function togglePackedOff(actorId: string, itemId: string): string[] {
  const current = getPackingSnapshotFor(actorId);
  if (!current.plan) return current.packedOff;
  // Only an item the CURRENT plan actually packs may be ticked, so a stale id
  // cannot accumulate across regenerations.
  if (!current.plan.packedItems.some((item) => item.itemId === itemId)) return current.packedOff;
  const next = current.packedOff.includes(itemId)
    ? current.packedOff.filter((id) => id !== itemId)
    : [...current.packedOff, itemId];
  update(actorId, { packedOff: next });
  return next;
}

/**
 * Cleared on sign-out, sign-in and user change alike, from
 * AuthSessionContext.resetActorScopedRuntimeState -- the one place this project
 * resets actor-scoped runtime state. No second auth cache.
 */
export function resetPackingPlanState(): void {
  snapshot = EMPTY;
  emit();
  // UX-4. The in-memory snapshot and the device cache are one actor boundary,
  // not two. Fire-and-forget because this reset is synchronous and must not be
  // delayed by storage -- correctness does not depend on it completing, since
  // every cache read is scoped to the reading actor's own key and a survivor is
  // therefore unaddressable rather than merely pending deletion.
  void clearAllCachedPackingPlans();
}
