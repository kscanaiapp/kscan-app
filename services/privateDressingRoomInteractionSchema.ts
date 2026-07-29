/**
 * Private Dressing Room interaction identifiers, allowlisted reconstruction,
 * validation, and the pure override/history transitions.
 *
 * Every function is PURE and never mutates its input. Validation RECONSTRUCTS
 * through the allowlist, so an unknown key cannot ride forward on disk.
 *
 * THE TRANSITIONS LIVE HERE, not in the store, so the undo semantics that
 * actually matter are testable without a filesystem:
 *
 *     replace : occupied slot  -> different item        (before = old item)
 *     fill    : missing slot   -> item                  (before = null)
 *     restore : overridden slot-> generated base item   (before = override)
 *
 * All three append one reversible history operation. Restore-original is NOT
 * special-cased outside the timeline: if it were, undoing it would be
 * impossible and the user's "put it back" would be a one-way door.
 */

import * as ExpoCrypto from 'expo-crypto';
import {
  PRIVATE_INTERACTION_SCHEMA_VERSION,
  PRIVATE_INTERACTION_MAX_SUPPORTED_SCHEMA_VERSION,
  PRIVATE_INTERACTION_BOUNDS,
  isPrivateSwapKind,
} from '../types/privateDressingRoomInteraction';
import type {
  PrivateDressingRoomInteractionState,
  PrivateDressingRoomLookOverrides,
  PrivateDressingRoomSlotOverride,
  PrivateDressingRoomSwapOperation,
  PrivateInteractionErrorCode,
  PrivateSwapKind,
} from '../types/privateDressingRoomInteraction';
import { isPrivateSlot } from '../types/privateDressingRoomComposition';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';

let interactionIdCounter = 0;
let operationIdCounter = 0;

// ── Identifiers ──────────────────────────────────────────────────────────────

/** Mirrors privateDressingRoomCompositionSchema.ts#randomSuffix exactly. */
function randomSuffix(): string {
  try {
    const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
      .crypto;
    if (crypto && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  try {
    if (typeof ExpoCrypto.getRandomBytes === 'function') {
      const bytes = ExpoCrypto.getRandomBytes(8);
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // fall through
  }
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(36);
  return `${rand()}${rand()}`;
}

export function createInteractionId(): string {
  interactionIdCounter = (interactionIdCounter + 1) % 0x100000;
  return `drint_${Date.now().toString(36)}_${interactionIdCounter.toString(36)}_${randomSuffix()}`;
}

export function createOperationId(): string {
  operationIdCounter = (operationIdCounter + 1) % 0x100000;
  return `drop_${Date.now().toString(36)}_${operationIdCounter.toString(36)}_${randomSuffix()}`;
}

// ── Field hygiene ────────────────────────────────────────────────────────────

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function normalizeActorId(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, PRIVATE_INTERACTION_BOUNDS.actorId)
    : null;
}

function cleanTimestamp(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

// ── Validation ───────────────────────────────────────────────────────────────

export type PrivateInteractionValidation = {
  ok: boolean;
  record: PrivateDressingRoomInteractionState | null;
  errorCode: PrivateInteractionErrorCode | null;
};

function invalid(errorCode: PrivateInteractionErrorCode): PrivateInteractionValidation {
  return { ok: false, record: null, errorCode };
}

function validateOperation(raw: unknown): PrivateDressingRoomSwapOperation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const operationId = cleanText(entry.operationId, PRIVATE_INTERACTION_BOUNDS.operationId);
  const lookId = cleanText(entry.lookId, PRIVATE_INTERACTION_BOUNDS.lookId);
  const afterClosetItemId = cleanText(
    entry.afterClosetItemId,
    PRIVATE_INTERACTION_BOUNDS.closetItemId,
  );
  const appliedAt = cleanTimestamp(entry.appliedAt);
  if (!operationId || !lookId || !afterClosetItemId || !appliedAt) return null;
  if (!isPrivateSlot(entry.slot)) return null;
  if (!isPrivateSwapKind(entry.kind)) return null;

  const beforeClosetItemId = cleanText(
    entry.beforeClosetItemId,
    PRIVATE_INTERACTION_BOUNDS.closetItemId,
  );
  // A fill has no before-item by definition; the other kinds must have one, or
  // undo could not reverse them.
  if (entry.kind === 'fill') {
    if (beforeClosetItemId) return null;
  } else if (!beforeClosetItemId) {
    return null;
  }
  // An operation that changes nothing is not an operation.
  if (beforeClosetItemId === afterClosetItemId) return null;

  return {
    operationId,
    lookId,
    slot: entry.slot,
    kind: entry.kind,
    beforeClosetItemId: beforeClosetItemId ?? null,
    afterClosetItemId,
    appliedAt,
  };
}

function validateSlotOverride(raw: unknown): PrivateDressingRoomSlotOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (!isPrivateSlot(entry.slot)) return null;
  const closetItemId = cleanText(entry.closetItemId, PRIVATE_INTERACTION_BOUNDS.closetItemId);
  const operationId = cleanText(entry.operationId, PRIVATE_INTERACTION_BOUNDS.operationId);
  const appliedAt = cleanTimestamp(entry.appliedAt);
  if (!closetItemId || !operationId || !appliedAt) return null;
  return { slot: entry.slot, closetItemId, operationId, appliedAt };
}

function validateLookOverrides(raw: unknown): PrivateDressingRoomLookOverrides | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const lookId = cleanText(entry.lookId, PRIVATE_INTERACTION_BOUNDS.lookId);
  if (!lookId) return null;
  if (!Array.isArray(entry.slots)) return null;
  if (entry.slots.length > PRIVATE_INTERACTION_BOUNDS.overridesPerLook) return null;

  const slots: PrivateDressingRoomSlotOverride[] = [];
  const seen = new Set<string>();
  for (const rawSlot of entry.slots) {
    const slotOverride = validateSlotOverride(rawSlot);
    if (!slotOverride) return null;
    // ONE current override per look and slot.
    if (seen.has(slotOverride.slot)) return null;
    seen.add(slotOverride.slot);
    slots.push(slotOverride);
  }
  return { lookId, slots };
}

/**
 * Validate one raw persisted interaction record and RECONSTRUCT it.
 *
 * Fails CLOSED on every structural violation. An interaction record that has to
 * be guessed at would attach a user's edit to an outfit they never approved.
 */
export function validateInteractionRecord(raw: unknown): PrivateInteractionValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('interaction_store_corrupt');
  }
  const record = raw as Record<string, unknown>;

  const version = record.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
    return invalid('interaction_store_corrupt');
  }
  if (version > PRIVATE_INTERACTION_MAX_SUPPORTED_SCHEMA_VERSION) {
    return invalid('interaction_store_future_schema');
  }

  const interactionId = cleanText(record.interactionId, PRIVATE_INTERACTION_BOUNDS.interactionId);
  const sessionId = cleanText(record.sessionId, PRIVATE_INTERACTION_BOUNDS.sessionId);
  const compositionId = cleanText(record.compositionId, PRIVATE_INTERACTION_BOUNDS.compositionId);
  const inputFingerprint = cleanText(
    record.inputFingerprint,
    PRIVATE_INTERACTION_BOUNDS.inputFingerprint,
  );
  if (!interactionId || !sessionId || !compositionId || !inputFingerprint) {
    return invalid('interaction_store_corrupt');
  }

  const createdAt = cleanTimestamp(record.createdAt);
  const updatedAt = cleanTimestamp(record.updatedAt);
  if (!createdAt || !updatedAt) return invalid('interaction_store_corrupt');

  if (!Array.isArray(record.overrides)) return invalid('interaction_store_corrupt');
  const overrides: PrivateDressingRoomLookOverrides[] = [];
  const seenLooks = new Set<string>();
  for (const rawEntry of record.overrides) {
    const entry = validateLookOverrides(rawEntry);
    if (!entry) return invalid('interaction_store_corrupt');
    if (seenLooks.has(entry.lookId)) return invalid('interaction_store_corrupt');
    seenLooks.add(entry.lookId);
    overrides.push(entry);
  }

  if (!Array.isArray(record.history)) return invalid('interaction_store_corrupt');
  if (record.history.length > PRIVATE_INTERACTION_BOUNDS.maxHistory) {
    return invalid('interaction_store_corrupt');
  }
  const history: PrivateDressingRoomSwapOperation[] = [];
  const seenOperations = new Set<string>();
  for (const rawOperation of record.history) {
    const operation = validateOperation(rawOperation);
    if (!operation) return invalid('interaction_store_corrupt');
    if (seenOperations.has(operation.operationId)) return invalid('interaction_store_corrupt');
    seenOperations.add(operation.operationId);
    history.push(operation);
  }

  // Comparison is exactly zero or two DISTINCT looks. One is not a comparison.
  if (!Array.isArray(record.comparedLookIds)) return invalid('interaction_store_corrupt');
  const comparedLookIds: string[] = [];
  for (const rawId of record.comparedLookIds) {
    const id = cleanText(rawId, PRIVATE_INTERACTION_BOUNDS.lookId);
    if (!id) return invalid('interaction_store_corrupt');
    if (comparedLookIds.includes(id)) return invalid('interaction_store_corrupt');
    comparedLookIds.push(id);
  }
  if (
    comparedLookIds.length !== 0 &&
    comparedLookIds.length !== PRIVATE_INTERACTION_BOUNDS.comparedLooks
  ) {
    return invalid('interaction_store_corrupt');
  }

  return {
    ok: true,
    errorCode: null,
    record: {
      interactionId,
      actorId: normalizeActorId(record.actorId),
      sessionId,
      compositionId,
      inputFingerprint,
      overrides,
      history,
      comparedLookIds,
      createdAt,
      updatedAt,
      schemaVersion: PRIVATE_INTERACTION_SCHEMA_VERSION,
    },
  };
}

// ── Construction ─────────────────────────────────────────────────────────────

export function buildInteractionState(input: {
  actorId: string | null;
  sessionId: string;
  compositionId: string;
  inputFingerprint: string;
  now?: string;
}): PrivateDressingRoomInteractionState {
  const timestamp = cleanTimestamp(input.now) ?? new Date().toISOString();
  return {
    interactionId: createInteractionId(),
    actorId: normalizeActorId(input.actorId),
    sessionId: input.sessionId,
    compositionId: input.compositionId,
    inputFingerprint: input.inputFingerprint,
    overrides: [],
    history: [],
    comparedLookIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: PRIVATE_INTERACTION_SCHEMA_VERSION,
  };
}

/**
 * True when this interaction state still describes the given context.
 *
 * All FOUR identity parts must match. Session and composition are checked
 * separately from the fingerprint because a rebuild produces a new
 * compositionId under an UNCHANGED fingerprint — and edits must not survive it.
 */
export function isInteractionCurrent(
  state: PrivateDressingRoomInteractionState | null | undefined,
  context: {
    actorId: string | null;
    sessionId: string;
    compositionId: string;
    inputFingerprint: string;
  },
): boolean {
  if (!state) return false;
  return (
    state.actorId === (normalizeActorId(context.actorId) ?? null) &&
    state.sessionId === context.sessionId &&
    state.compositionId === context.compositionId &&
    state.inputFingerprint === context.inputFingerprint
  );
}

// ── Pure transitions ─────────────────────────────────────────────────────────

function overridesForLook(
  state: PrivateDressingRoomInteractionState,
  lookId: string,
): PrivateDressingRoomSlotOverride[] {
  for (const entry of state.overrides) {
    if (entry.lookId === lookId) return entry.slots;
  }
  return [];
}

export function findSlotOverride(
  state: PrivateDressingRoomInteractionState | null | undefined,
  lookId: string,
  slot: PrivateDressingRoomSlot,
): PrivateDressingRoomSlotOverride | null {
  if (!state) return null;
  for (const override of overridesForLook(state, lookId)) {
    if (override.slot === slot) return override;
  }
  return null;
}

/** Replace this look's override list, leaving every other look untouched. */
function withLookOverrides(
  state: PrivateDressingRoomInteractionState,
  lookId: string,
  slots: PrivateDressingRoomSlotOverride[],
): PrivateDressingRoomLookOverrides[] {
  const others = state.overrides.filter((entry) => entry.lookId !== lookId);
  return slots.length > 0 ? [...others, { lookId, slots }] : others;
}

/**
 * Append one operation, dropping only the OLDEST when the cap is exceeded.
 *
 * Dropping the oldest never touches current overrides or comparison: falling
 * off the undo stack means "you can no longer step back past here", not "that
 * edit was reverted".
 */
function withHistory(
  state: PrivateDressingRoomInteractionState,
  operation: PrivateDressingRoomSwapOperation,
): PrivateDressingRoomSwapOperation[] {
  const next = [...state.history, operation];
  return next.length > PRIVATE_INTERACTION_BOUNDS.maxHistory
    ? next.slice(next.length - PRIVATE_INTERACTION_BOUNDS.maxHistory)
    : next;
}

export type InteractionTransition = {
  ok: boolean;
  state: PrivateDressingRoomInteractionState | null;
  operation: PrivateDressingRoomSwapOperation | null;
  errorCode: 'NO_OP' | 'NOTHING_TO_UNDO' | 'PRIOR_ITEM_UNAVAILABLE' | 'INVALID_INPUT' | null;
};

/**
 * Apply one slot change.
 *
 * `beforeClosetItemId` is what the slot shows RIGHT NOW (its effective item),
 * not what the composer generated — otherwise undoing the second of two swaps
 * on the same slot would jump back to the baseline and silently discard the
 * first.
 */
export function applySlotChange(
  state: PrivateDressingRoomInteractionState,
  input: {
    lookId: string;
    slot: PrivateDressingRoomSlot;
    kind: PrivateSwapKind;
    beforeClosetItemId: string | null;
    afterClosetItemId: string;
    baseClosetItemId: string | null;
    now?: string;
  },
): InteractionTransition {
  const lookId = cleanText(input.lookId, PRIVATE_INTERACTION_BOUNDS.lookId);
  const after = cleanText(input.afterClosetItemId, PRIVATE_INTERACTION_BOUNDS.closetItemId);
  if (!lookId || !after || !isPrivateSlot(input.slot) || !isPrivateSwapKind(input.kind)) {
    return { ok: false, state: null, operation: null, errorCode: 'INVALID_INPUT' };
  }
  const before = cleanText(input.beforeClosetItemId, PRIVATE_INTERACTION_BOUNDS.closetItemId);
  if (before === after) {
    return { ok: false, state: null, operation: null, errorCode: 'NO_OP' };
  }

  const now = cleanTimestamp(input.now) ?? new Date().toISOString();
  const operation: PrivateDressingRoomSwapOperation = {
    operationId: createOperationId(),
    lookId,
    slot: input.slot,
    kind: input.kind,
    beforeClosetItemId: input.kind === 'fill' ? null : before,
    afterClosetItemId: after,
    appliedAt: now,
  };

  const existing = overridesForLook(state, lookId).filter(
    (override) => override.slot !== input.slot,
  );
  const base = cleanText(input.baseClosetItemId, PRIVATE_INTERACTION_BOUNDS.closetItemId);
  // Landing back on the generated item is not an override — it is the ABSENCE
  // of one. Storing it would make "is this edited?" permanently true.
  const slots =
    base !== null && after === base
      ? existing
      : [
          ...existing,
          { slot: input.slot, closetItemId: after, operationId: operation.operationId, appliedAt: now },
        ];

  return {
    ok: true,
    errorCode: null,
    operation,
    state: {
      ...state,
      overrides: withLookOverrides(state, lookId, slots),
      history: withHistory(state, operation),
      updatedAt: now,
    },
  };
}

/**
 * Undo the newest operation.
 *
 * Reverses by KIND: a replace restores its before-item, a fill removes the
 * override entirely and returns the slot to missing, and a restore reapplies
 * the override the user had before they put the generated item back.
 */
export function undoLastOperation(
  state: PrivateDressingRoomInteractionState,
  options: {
    availableClosetItemIds?: readonly string[];
    /**
     * The GENERATED item for the slot being reverted, when known. Reverting
     * onto it removes the override rather than storing one that overrides
     * nothing — the same rule `applySlotChange` applies, so "is this edited?"
     * cannot become permanently true after an undo.
     */
    baseClosetItemId?: string | null;
    now?: string;
  } = {},
): InteractionTransition {
  if (state.history.length === 0) {
    return { ok: false, state: null, operation: null, errorCode: 'NOTHING_TO_UNDO' };
  }
  const operation = state.history[state.history.length - 1];
  const now = cleanTimestamp(options.now) ?? new Date().toISOString();

  // Reversing to an item the Closet no longer has would resurrect a garment the
  // user does not own. Refuse rather than restore stale metadata.
  if (operation.beforeClosetItemId && options.availableClosetItemIds) {
    if (!options.availableClosetItemIds.includes(operation.beforeClosetItemId)) {
      return { ok: false, state: null, operation, errorCode: 'PRIOR_ITEM_UNAVAILABLE' };
    }
  }

  const existing = overridesForLook(state, operation.lookId).filter(
    (override) => override.slot !== operation.slot,
  );
  const base = cleanText(options.baseClosetItemId, PRIVATE_INTERACTION_BOUNDS.closetItemId);
  const revertsToBase = base !== null && operation.beforeClosetItemId === base;
  const slots =
    operation.beforeClosetItemId === null || revertsToBase
      ? existing
      : [
          ...existing,
          {
            slot: operation.slot,
            closetItemId: operation.beforeClosetItemId,
            operationId: operation.operationId,
            appliedAt: now,
          },
        ];

  return {
    ok: true,
    errorCode: null,
    operation,
    state: {
      ...state,
      overrides: withLookOverrides(state, operation.lookId, slots),
      history: state.history.slice(0, -1),
      updatedAt: now,
    },
  };
}

/** Set or clear the compared pair. Exactly two distinct looks, or none. */
export function withComparedLooks(
  state: PrivateDressingRoomInteractionState,
  lookIds: readonly string[],
  now?: string,
): InteractionTransition {
  const cleaned: string[] = [];
  for (const rawId of lookIds ?? []) {
    const id = cleanText(rawId, PRIVATE_INTERACTION_BOUNDS.lookId);
    if (!id || cleaned.includes(id)) {
      return { ok: false, state: null, operation: null, errorCode: 'INVALID_INPUT' };
    }
    cleaned.push(id);
  }
  if (cleaned.length !== 0 && cleaned.length !== PRIVATE_INTERACTION_BOUNDS.comparedLooks) {
    return { ok: false, state: null, operation: null, errorCode: 'INVALID_INPUT' };
  }
  return {
    ok: true,
    errorCode: null,
    operation: null,
    state: {
      ...state,
      comparedLookIds: cleaned,
      updatedAt: cleanTimestamp(now) ?? new Date().toISOString(),
    },
  };
}

/** Every distinct Closet item this interaction depends on, for reconciliation. */
export function collectInteractionItemIds(
  state: PrivateDressingRoomInteractionState | null | undefined,
): string[] {
  if (!state) return [];
  const ids = new Set<string>();
  for (const entry of state.overrides) {
    for (const override of entry.slots) ids.add(override.closetItemId);
  }
  return [...ids];
}
