/**
 * Actor-scoped persistence for private Dressing Room interaction state.
 *
 * STORAGE DOMAIN. This store owns `kscan_private_dressing_room_edits/` and
 * nothing else — distinct from the private SESSION store, the private
 * COMPOSITION store, the committed Closet, Closet candidates, Saved Looks,
 * commerce and the collaborative cloud Dressing Room. No network call is made.
 *
 * THE WRITE SEQUENCE IS NOT NEW. `persistInteractions` is the write-verify-swap
 * proven by the session and composition stores, step for step.
 *
 * ONE SERIALIZED QUEUE, AND CONTEXT IS REVALIDATED WHEN A TURN BEGINS.
 * Every mutation — apply, restore, undo, comparison, reset, reconciliation
 * repair, discard cleanup — goes through `enqueue`. Validating only on ENTRY to
 * the queue would be a real bug: an operation can sit behind another that
 * changes the anchor, and by the time it runs its context is gone. So each
 * operation re-reads and re-validates identity at the moment it executes, and
 * rejects without writing if anything moved.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { resolveWriteAuthority } from './actorContext';
import {
  applySlotChange,
  buildInteractionState,
  isInteractionCurrent,
  undoLastOperation,
  validateInteractionRecord,
  withComparedLooks,
} from './privateDressingRoomInteractionSchema';
import type {
  PrivateDressingRoomInteractionState,
  PrivateInteractionErrorCode,
  PrivateSwapKind,
} from '../types/privateDressingRoomInteraction';
import type { PrivateDressingRoomSlot } from '../types/privateDressingRoomComposition';

// ── Storage namespace ────────────────────────────────────────────────────────

export const INTERACTION_DIR =
  FileSystem.documentDirectory + 'kscan_private_dressing_room_edits/';
export const INTERACTION_MANIFEST_PATH =
  INTERACTION_DIR + 'kscan_private_dressing_room_edits.json';
export const INTERACTION_MANIFEST_TEMP_PATH = INTERACTION_MANIFEST_PATH + '.tmp';
export const INTERACTION_MANIFEST_BACKUP_PATH = INTERACTION_MANIFEST_PATH + '.bak';

// ── Result contract ──────────────────────────────────────────────────────────

export type InteractionRecoveryKind = 'primary' | 'backup' | 'none';

/** FLAT, for the strictNullChecks reason documented in the sibling stores. */
export type InteractionResult = {
  ok: boolean;
  interaction: PrivateDressingRoomInteractionState | null;
  recovered: InteractionRecoveryKind;
  errorCode: PrivateInteractionErrorCode | null;
  recoverable: boolean;
  /** The stored state exists but describes a context that has moved on. */
  stale: boolean;
  /** A typed outcome for the caller's UI, e.g. NOTHING_TO_UNDO. */
  resultCode: string | null;
};

/** The four-part identity every operation validates against. */
export type InteractionContext = {
  sessionId: string;
  compositionId: string;
  inputFingerprint: string;
};

type AuthorityResult = {
  ok: boolean;
  actorId: string | null;
  errorCode: PrivateInteractionErrorCode | null;
};

let interactionMutationQueue: Promise<unknown> = Promise.resolve();

/**
 * THE single serialized queue for this store. Only one interaction-manifest
 * write may be in flight; a later operation waits for the earlier one.
 */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = interactionMutationQueue.then(operation, operation);
  interactionMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function failure(
  errorCode: PrivateInteractionErrorCode,
  recoverable: boolean,
  resultCode: string | null = null,
): InteractionResult {
  return {
    ok: false,
    interaction: null,
    recovered: 'none',
    errorCode,
    recoverable,
    stale: false,
    resultCode,
  };
}

function staleResult(resultCode = 'INTERACTION_STALE'): InteractionResult {
  return {
    ok: true,
    interaction: null,
    recovered: 'none',
    errorCode: 'interaction_stale',
    recoverable: false,
    stale: true,
    resultCode,
  };
}

function success(
  interaction: PrivateDressingRoomInteractionState | null,
  recovered: InteractionRecoveryKind,
  resultCode: string | null = null,
): InteractionResult {
  return {
    ok: true,
    interaction,
    recovered,
    errorCode: null,
    recoverable: false,
    stale: false,
    resultCode,
  };
}

/** The ONLY actor gate. No exported function accepts an actor id. */
function resolveInteractionAuthority(actorRequest: unknown): AuthorityResult {
  const authority = resolveWriteAuthority(actorRequest, undefined) as {
    ok: boolean;
    ownerId?: string | null;
    reason?: string;
  };
  if (!authority.ok) {
    return {
      ok: false,
      actorId: null,
      errorCode:
        authority.reason === 'missing_actor_context'
          ? 'missing_actor_context'
          : 'stale_actor_context',
    };
  }
  const actorId = authority.ownerId ?? null;
  if (Platform.OS === 'android' && actorId === null) {
    return { ok: false, actorId: null, errorCode: 'missing_actor_context' };
  }
  return { ok: true, actorId, errorCode: null };
}

// ── Atomic write ─────────────────────────────────────────────────────────────

async function persistInteractions(
  records: PrivateDressingRoomInteractionState[],
): Promise<void> {
  await FileSystem.makeDirectoryAsync(INTERACTION_DIR, { intermediates: true }).catch(() => null);
  const payload = JSON.stringify(records);

  await FileSystem.deleteAsync(INTERACTION_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
    () => null,
  );
  await FileSystem.writeAsStringAsync(INTERACTION_MANIFEST_TEMP_PATH, payload, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  let verified: string | null = null;
  try {
    verified = await FileSystem.readAsStringAsync(INTERACTION_MANIFEST_TEMP_PATH, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    verified = null;
  }
  if (verified !== payload) {
    await FileSystem.deleteAsync(INTERACTION_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
      () => null,
    );
    const error = new Error('private_interaction_manifest_unverified');
    (error as Error & { code?: string }).code = 'interaction_persist_failed';
    throw error;
  }

  const existing = await FileSystem.getInfoAsync(INTERACTION_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (existing?.exists) {
    await FileSystem.deleteAsync(INTERACTION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
      () => null,
    );
    await FileSystem.moveAsync({
      from: INTERACTION_MANIFEST_PATH,
      to: INTERACTION_MANIFEST_BACKUP_PATH,
    });
  }

  try {
    await FileSystem.moveAsync({
      from: INTERACTION_MANIFEST_TEMP_PATH,
      to: INTERACTION_MANIFEST_PATH,
    });
  } catch (error) {
    const backup = await FileSystem.getInfoAsync(INTERACTION_MANIFEST_BACKUP_PATH).catch(() => ({
      exists: false,
    }));
    if (backup?.exists) {
      await FileSystem.moveAsync({
        from: INTERACTION_MANIFEST_BACKUP_PATH,
        to: INTERACTION_MANIFEST_PATH,
      }).catch(() => null);
    }
    throw error;
  }

  await FileSystem.deleteAsync(INTERACTION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
    () => null,
  );
}

async function recoverManifestFromBackup(): Promise<boolean> {
  const canonical = await FileSystem.getInfoAsync(INTERACTION_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (canonical?.exists) return false;
  const backup = await FileSystem.getInfoAsync(INTERACTION_MANIFEST_BACKUP_PATH).catch(() => ({
    exists: false,
  }));
  if (!backup?.exists) return false;
  try {
    await FileSystem.moveAsync({
      from: INTERACTION_MANIFEST_BACKUP_PATH,
      to: INTERACTION_MANIFEST_PATH,
    });
    return true;
  } catch {
    return false;
  }
}

type ParsedManifest = {
  ok: boolean;
  records: PrivateDressingRoomInteractionState[];
  errorCode: PrivateInteractionErrorCode | null;
};

async function parseManifestAt(uri: string): Promise<ParsedManifest | null> {
  const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }));
  if (!info?.exists) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await FileSystem.readAsStringAsync(uri));
  } catch {
    return { ok: false, records: [], errorCode: 'interaction_store_corrupt' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, records: [], errorCode: 'interaction_store_corrupt' };
  }

  const records: PrivateDressingRoomInteractionState[] = [];
  let futureSchema = false;
  for (const entry of parsed) {
    const validated = validateInteractionRecord(entry);
    if (validated.ok && validated.record) {
      records.push(validated.record);
      continue;
    }
    if (validated.errorCode === 'interaction_store_future_schema') futureSchema = true;
  }
  if (records.length === 0 && parsed.length > 0) {
    return {
      ok: false,
      records: [],
      errorCode: futureSchema ? 'interaction_store_future_schema' : 'interaction_store_corrupt',
    };
  }
  return { ok: true, records, errorCode: null };
}

async function readManifest(): Promise<{
  result: ParsedManifest;
  recovered: InteractionRecoveryKind;
}> {
  const promoted = await recoverManifestFromBackup();
  const primary = await parseManifestAt(INTERACTION_MANIFEST_PATH);
  if (primary === null) {
    return { result: { ok: true, records: [], errorCode: null }, recovered: 'none' };
  }
  if (primary.ok) return { result: primary, recovered: promoted ? 'backup' : 'primary' };
  if (primary.errorCode === 'interaction_store_future_schema') {
    return { result: primary, recovered: 'none' };
  }
  const backup = await parseManifestAt(INTERACTION_MANIFEST_BACKUP_PATH);
  if (backup && backup.ok) return { result: backup, recovered: 'backup' };
  return { result: primary, recovered: 'none' };
}

function findForActor(
  records: PrivateDressingRoomInteractionState[],
  actorId: string | null,
): PrivateDressingRoomInteractionState | null {
  for (const record of records) {
    if (record.actorId === actorId) return record;
  }
  return null;
}

function withActorRecord(
  records: PrivateDressingRoomInteractionState[],
  actorId: string | null,
  next: PrivateDressingRoomInteractionState | null,
): PrivateDressingRoomInteractionState[] {
  const others = records.filter((record) => record.actorId !== actorId);
  return next ? [...others, next] : others;
}

// ── The shared mutation body ─────────────────────────────────────────────────

type MutationOutcome = {
  next: PrivateDressingRoomInteractionState | null;
  resultCode: string | null;
  failed: boolean;
};

/**
 * Serialized mutation with turn-time revalidation.
 *
 * The four-part identity is checked when this operation's TURN BEGINS, not when
 * it was queued — an operation waiting behind an anchor change must reject
 * rather than write into a context that no longer exists.
 */
async function mutate(
  actorRequest: unknown,
  context: InteractionContext,
  apply: (
    current: PrivateDressingRoomInteractionState,
    actorId: string | null,
  ) => MutationOutcome,
  options: { createWhenMissing?: boolean } = {},
): Promise<InteractionResult> {
  const pre = resolveInteractionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false, 'ACTOR_CHANGED');

  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return failure(result.errorCode, true, 'INTERACTION_STALE');

    // Turn-time revalidation.
    const post = resolveInteractionAuthority(actorRequest);
    if (!post.ok) return failure(post.errorCode, false, 'ACTOR_CHANGED');

    const existing = findForActor(result.records, post.actorId);
    let current = existing;
    if (!current || !isInteractionCurrent(current, { actorId: post.actorId, ...context })) {
      if (!options.createWhenMissing) return staleResult();
      current = buildInteractionState({
        actorId: post.actorId,
        sessionId: context.sessionId,
        compositionId: context.compositionId,
        inputFingerprint: context.inputFingerprint,
      });
    }

    const outcome = apply(current, post.actorId);
    if (outcome.failed || !outcome.next) {
      return {
        ...failure('interaction_persist_failed', false, outcome.resultCode),
        ok: true,
        errorCode: null,
        interaction: current === existing ? current : null,
      };
    }

    const commit = resolveInteractionAuthority(actorRequest);
    if (!commit.ok || commit.actorId !== post.actorId) {
      return failure('stale_actor_context', false, 'ACTOR_CHANGED');
    }

    try {
      await persistInteractions(withActorRecord(result.records, commit.actorId, outcome.next));
    } catch {
      return failure('interaction_persist_failed', true, 'PERSIST_FAILED');
    }
    return success(outcome.next, 'primary', outcome.resultCode ?? 'APPLIED');
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load this actor's interaction state for the CURRENT context.
 *
 * A stored record whose four-part identity no longer matches is reported stale
 * with NO interaction attached. This is what stops a discarded session's edits
 * from reappearing under a new session, and a predecessor composition's
 * overrides from being applied to its replacement — without any cleanup having
 * to have run.
 */
export async function loadInteractionState(
  actorRequest: unknown,
  context: InteractionContext,
): Promise<InteractionResult> {
  const authority = resolveInteractionAuthority(actorRequest);
  if (!authority.ok) return failure(authority.errorCode, false, 'ACTOR_CHANGED');

  try {
    await interactionMutationQueue;
    const { result, recovered } = await readManifest();
    if (!result.ok) return failure(result.errorCode, true, 'INTERACTION_CORRUPT');

    const post = resolveInteractionAuthority(actorRequest);
    if (!post.ok) return failure(post.errorCode, false, 'ACTOR_CHANGED');

    const record = findForActor(result.records, post.actorId);
    if (!record) return success(null, recovered);
    if (!isInteractionCurrent(record, { actorId: post.actorId, ...context })) {
      return staleResult();
    }
    return success(record, recovered);
  } catch {
    return failure('interaction_store_unreadable', true, 'INTERACTION_CORRUPT');
  }
}

/** Recovery-aware load. Performs NO write. */
export async function recoverInteractionState(
  actorRequest: unknown,
  context: InteractionContext,
): Promise<InteractionResult> {
  return loadInteractionState(actorRequest, context);
}

/** Create an empty interaction state for the current context. */
export async function createInteractionState(
  actorRequest: unknown,
  context: InteractionContext,
): Promise<InteractionResult> {
  return mutate(
    actorRequest,
    context,
    (current) => ({ next: current, resultCode: 'APPLIED', failed: false }),
    { createWhenMissing: true },
  );
}

/**
 * Apply exactly ONE slot change.
 *
 * The caller has already re-proved candidate eligibility and computed the
 * before/base items from the CURRENT effective look; this layer owns identity,
 * serialization and durability.
 */
export async function applySlotOverride(
  actorRequest: unknown,
  context: InteractionContext,
  input: {
    lookId: string;
    slot: PrivateDressingRoomSlot;
    kind: PrivateSwapKind;
    beforeClosetItemId: string | null;
    afterClosetItemId: string;
    baseClosetItemId: string | null;
  },
): Promise<InteractionResult> {
  return mutate(
    actorRequest,
    context,
    (current) => {
      const transition = applySlotChange(current, input);
      return {
        next: transition.state,
        resultCode: transition.ok ? 'APPLIED' : transition.errorCode,
        failed: !transition.ok,
      };
    },
    { createWhenMissing: true },
  );
}

/**
 * Return one slot to its generated item.
 *
 * A NORMAL reversible operation, not a special case: it appends history exactly
 * like any other change, so undo can put the user's edit back.
 */
export async function restoreBaseSlot(
  actorRequest: unknown,
  context: InteractionContext,
  input: {
    lookId: string;
    slot: PrivateDressingRoomSlot;
    currentClosetItemId: string;
    baseClosetItemId: string;
  },
): Promise<InteractionResult> {
  return mutate(actorRequest, context, (current) => {
    const transition = applySlotChange(current, {
      lookId: input.lookId,
      slot: input.slot,
      kind: 'restore',
      beforeClosetItemId: input.currentClosetItemId,
      afterClosetItemId: input.baseClosetItemId,
      baseClosetItemId: input.baseClosetItemId,
    });
    return {
      next: transition.state,
      resultCode: transition.ok ? 'APPLIED' : transition.errorCode,
      failed: !transition.ok,
    };
  });
}

/** Undo the newest operation. Never writes when there is nothing to undo. */
export async function undoLastSwap(
  actorRequest: unknown,
  context: InteractionContext,
  options: {
    availableClosetItemIds?: readonly string[];
    /**
     * Resolves the GENERATED item for a look/slot, so reverting onto the
     * baseline removes the override instead of storing a redundant one. The
     * caller owns the base composition; this store deliberately does not read it.
     */
    resolveBaseClosetItemId?: (
      lookId: string,
      slot: PrivateDressingRoomSlot,
    ) => string | null | undefined;
  } = {},
): Promise<InteractionResult> {
  return mutate(actorRequest, context, (current) => {
    const newest = current.history[current.history.length - 1] ?? null;
    const baseClosetItemId =
      newest && typeof options.resolveBaseClosetItemId === 'function'
        ? options.resolveBaseClosetItemId(newest.lookId, newest.slot) ?? null
        : null;
    const transition = undoLastOperation(current, {
      availableClosetItemIds: options.availableClosetItemIds,
      baseClosetItemId,
    });
    return {
      next: transition.state,
      resultCode: transition.ok ? 'APPLIED' : transition.errorCode,
      failed: !transition.ok,
    };
  });
}

/** Persist the compared pair. Exactly two distinct looks. */
export async function setComparedLooks(
  actorRequest: unknown,
  context: InteractionContext,
  lookIds: readonly string[],
): Promise<InteractionResult> {
  return mutate(
    actorRequest,
    context,
    (current) => {
      const transition = withComparedLooks(current, lookIds);
      return {
        next: transition.state,
        resultCode: transition.ok ? 'APPLIED' : transition.errorCode,
        failed: !transition.ok,
      };
    },
    { createWhenMissing: true },
  );
}

export async function clearComparedLooks(
  actorRequest: unknown,
  context: InteractionContext,
): Promise<InteractionResult> {
  return setComparedLooks(actorRequest, context, []);
}

/**
 * Remove this actor's interaction record.
 *
 * Best-effort cleanup after a session discard or context change. Identity
 * validation already makes a surviving record unusable, which is exactly why a
 * cleanup failure must not block or reverse an authoritative session discard.
 */
export async function discardInteractionState(actorRequest: unknown): Promise<InteractionResult> {
  const pre = resolveInteractionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false, 'ACTOR_CHANGED');

  return enqueue(async () => {
    const { result } = await readManifest();
    const commit = resolveInteractionAuthority(actorRequest);
    if (!commit.ok) return failure(commit.errorCode, false, 'ACTOR_CHANGED');

    const records = result.ok ? withActorRecord(result.records, commit.actorId, null) : [];
    try {
      await persistInteractions(records);
    } catch {
      return failure('interaction_persist_failed', true, 'PERSIST_FAILED');
    }
    return success(null, 'none', 'APPLIED');
  });
}

/**
 * Explicit, user-driven reset of unreadable edits.
 *
 * Clears ONLY the interaction record. The private session and the Phase 2
 * composition are untouched, so a damaged edit history costs the user their
 * edits and nothing else — they do not have to rebuild their outfits.
 */
export async function resetCorruptInteractionState(
  actorRequest: unknown,
): Promise<InteractionResult> {
  const pre = resolveInteractionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false, 'ACTOR_CHANGED');

  return enqueue(async () => {
    const { result } = await readManifest();
    const commit = resolveInteractionAuthority(actorRequest);
    if (!commit.ok) return failure(commit.errorCode, false, 'ACTOR_CHANGED');

    const records = result.ok ? withActorRecord(result.records, commit.actorId, null) : [];
    try {
      await persistInteractions(records);
      await FileSystem.deleteAsync(INTERACTION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
        () => null,
      );
    } catch {
      return failure('interaction_persist_failed', true, 'PERSIST_FAILED');
    }
    return success(null, 'none', 'APPLIED');
  });
}

/**
 * Reconcile interaction state against the Closet and composition RIGHT NOW.
 *
 * PURE — no write. An override whose garment has left the Closet is reported,
 * never silently replaced: choosing a substitute would put a garment in the
 * user's outfit that they did not pick.
 */
export function reconcileInteractionState(
  state: PrivateDressingRoomInteractionState | null | undefined,
  availableClosetItemIds: readonly string[],
  currentLookIds: readonly string[],
): {
  missingOverrides: { lookId: string; slot: PrivateDressingRoomSlot; closetItemId: string }[];
  unknownLookIds: string[];
  comparedLookIdsValid: boolean;
} {
  if (!state) {
    return { missingOverrides: [], unknownLookIds: [], comparedLookIdsValid: false };
  }
  const available = new Set(availableClosetItemIds ?? []);
  const looks = new Set(currentLookIds ?? []);

  const missingOverrides: {
    lookId: string;
    slot: PrivateDressingRoomSlot;
    closetItemId: string;
  }[] = [];
  const unknownLookIds: string[] = [];

  for (const entry of state.overrides) {
    if (!looks.has(entry.lookId)) {
      unknownLookIds.push(entry.lookId);
      continue;
    }
    for (const override of entry.slots) {
      if (!available.has(override.closetItemId)) {
        missingOverrides.push({
          lookId: entry.lookId,
          slot: override.slot,
          closetItemId: override.closetItemId,
        });
      }
    }
  }

  const comparedLookIdsValid =
    state.comparedLookIds.length === 2 &&
    state.comparedLookIds.every((lookId) => looks.has(lookId));

  return { missingOverrides, unknownLookIds, comparedLookIdsValid };
}

/** Test seam only. Not used by production code. */
export const __privateInteractionStoreInternals = {
  persistInteractions,
  readManifest,
  findForActor,
  withActorRecord,
  resolveInteractionAuthority,
};
