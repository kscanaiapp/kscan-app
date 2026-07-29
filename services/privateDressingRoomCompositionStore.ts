/**
 * Actor-scoped persistence for private Dressing Room outfit compositions.
 *
 * STORAGE DOMAIN. This store owns `kscan_private_dressing_room_looks/` and
 * nothing else. It shares no directory, filename or manifest with the private
 * SESSION store (`kscan_private_dressing_room/`), the committed Closet, Closet
 * candidates, Saved Looks, receipts, commerce, or the collaborative cloud
 * Dressing Room. Nothing here issues a network call.
 *
 * THE WRITE SEQUENCE IS NOT NEW. `persistCompositions` is the write-verify-swap
 * already proven by services/privateDressingRoomSessionStore.ts, which in turn
 * mirrors services/closetCandidateLibrary.js, step for step. No second
 * durability design is invented and no `fsync` is claimed, because Expo's
 * FileSystem does not expose one.
 *
 * ONE COMPOSITION PER ACTOR, keyed to a session by fingerprint. Older
 * compositions are replaced rather than accumulated: a superseded set has no
 * reader, and keeping it would only widen the window in which stale outfits
 * could be surfaced.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { resolveWriteAuthority } from './actorContext';
import {
  buildCompositionSet,
  reviseCompositionSet,
  validateCompositionRecord,
  isCompositionCurrent,
} from './privateDressingRoomCompositionSchema';
import type {
  PrivateDressingRoomCompositionSet,
  PrivateDressingRoomLookOption,
  PrivateCompositionErrorCode,
} from '../types/privateDressingRoomComposition';

// ── Storage namespace ────────────────────────────────────────────────────────

export const COMPOSITION_DIR =
  FileSystem.documentDirectory + 'kscan_private_dressing_room_looks/';
export const COMPOSITION_MANIFEST_PATH =
  COMPOSITION_DIR + 'kscan_private_dressing_room_looks.json';
export const COMPOSITION_MANIFEST_TEMP_PATH = COMPOSITION_MANIFEST_PATH + '.tmp';
export const COMPOSITION_MANIFEST_BACKUP_PATH = COMPOSITION_MANIFEST_PATH + '.bak';

// ── Result contract ──────────────────────────────────────────────────────────

export type CompositionRecoveryKind = 'primary' | 'backup' | 'none';

/**
 * FLAT, for the reason documented on PrivateDressingRoomSessionMigration: this
 * project compiles without `strictNullChecks`, under which TypeScript will not
 * narrow a union by a boolean literal discriminant.
 */
export type CompositionResult = {
  ok: boolean;
  /** null means: no composition for this actor. Not an error when ok. */
  composition: PrivateDressingRoomCompositionSet | null;
  recovered: CompositionRecoveryKind;
  errorCode: PrivateCompositionErrorCode | null;
  recoverable: boolean;
  /** True when a stored composition was refused because its context moved on. */
  stale: boolean;
};

type AuthorityResult = {
  ok: boolean;
  actorId: string | null;
  errorCode: PrivateCompositionErrorCode | null;
};

let compositionMutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = compositionMutationQueue.then(operation, operation);
  compositionMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function failure(
  errorCode: PrivateCompositionErrorCode,
  recoverable: boolean,
  stale = false,
): CompositionResult {
  return { ok: false, composition: null, recovered: 'none', errorCode, recoverable, stale };
}

function success(
  composition: PrivateDressingRoomCompositionSet | null,
  recovered: CompositionRecoveryKind,
): CompositionResult {
  return { ok: true, composition, recovered, errorCode: null, recoverable: false, stale: false };
}

/**
 * The ONLY actor gate. No exported function accepts an actor id, so a route
 * parameter can never select a partition. Mirrors the session store, including
 * the established Android divergence on signed-out durable writes.
 */
function resolveCompositionAuthority(actorRequest: unknown): AuthorityResult {
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

/** Step for step services/privateDressingRoomSessionStore.ts#persistSessions. */
async function persistCompositions(
  records: PrivateDressingRoomCompositionSet[],
): Promise<void> {
  await FileSystem.makeDirectoryAsync(COMPOSITION_DIR, { intermediates: true }).catch(() => null);
  const payload = JSON.stringify(records);

  await FileSystem.deleteAsync(COMPOSITION_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
    () => null,
  );
  await FileSystem.writeAsStringAsync(COMPOSITION_MANIFEST_TEMP_PATH, payload, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  let verified: string | null = null;
  try {
    verified = await FileSystem.readAsStringAsync(COMPOSITION_MANIFEST_TEMP_PATH, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    verified = null;
  }
  if (verified !== payload) {
    await FileSystem.deleteAsync(COMPOSITION_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
      () => null,
    );
    const error = new Error('private_composition_manifest_unverified');
    (error as Error & { code?: string }).code = 'composition_persist_failed';
    throw error;
  }

  const existing = await FileSystem.getInfoAsync(COMPOSITION_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (existing?.exists) {
    await FileSystem.deleteAsync(COMPOSITION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
      () => null,
    );
    await FileSystem.moveAsync({
      from: COMPOSITION_MANIFEST_PATH,
      to: COMPOSITION_MANIFEST_BACKUP_PATH,
    });
  }

  try {
    await FileSystem.moveAsync({
      from: COMPOSITION_MANIFEST_TEMP_PATH,
      to: COMPOSITION_MANIFEST_PATH,
    });
  } catch (error) {
    const backup = await FileSystem.getInfoAsync(COMPOSITION_MANIFEST_BACKUP_PATH).catch(() => ({
      exists: false,
    }));
    if (backup?.exists) {
      await FileSystem.moveAsync({
        from: COMPOSITION_MANIFEST_BACKUP_PATH,
        to: COMPOSITION_MANIFEST_PATH,
      }).catch(() => null);
    }
    throw error;
  }

  await FileSystem.deleteAsync(COMPOSITION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
    () => null,
  );
}

async function recoverManifestFromBackup(): Promise<boolean> {
  const canonical = await FileSystem.getInfoAsync(COMPOSITION_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (canonical?.exists) return false;
  const backup = await FileSystem.getInfoAsync(COMPOSITION_MANIFEST_BACKUP_PATH).catch(() => ({
    exists: false,
  }));
  if (!backup?.exists) return false;
  try {
    await FileSystem.moveAsync({
      from: COMPOSITION_MANIFEST_BACKUP_PATH,
      to: COMPOSITION_MANIFEST_PATH,
    });
    return true;
  } catch {
    return false;
  }
}

type ParsedManifest = {
  ok: boolean;
  records: PrivateDressingRoomCompositionSet[];
  errorCode: PrivateCompositionErrorCode | null;
};

async function parseManifestAt(uri: string): Promise<ParsedManifest | null> {
  const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }));
  if (!info?.exists) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await FileSystem.readAsStringAsync(uri));
  } catch {
    return { ok: false, records: [], errorCode: 'composition_store_corrupt' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, records: [], errorCode: 'composition_store_corrupt' };
  }

  const records: PrivateDressingRoomCompositionSet[] = [];
  let futureSchema = false;
  for (const entry of parsed) {
    const validated = validateCompositionRecord(entry);
    if (validated.ok && validated.record) {
      records.push(validated.record);
      continue;
    }
    if (validated.errorCode === 'composition_store_future_schema') futureSchema = true;
  }

  if (records.length === 0 && parsed.length > 0) {
    return {
      ok: false,
      records: [],
      errorCode: futureSchema ? 'composition_store_future_schema' : 'composition_store_corrupt',
    };
  }
  return { ok: true, records, errorCode: null };
}

/**
 * Read with recovery. Backup promotion only when the canonical file is MISSING
 * (the established pattern); a present-but-unreadable primary falls back to the
 * backup for READING while the damaged bytes stay on disk, because overwriting
 * them here would destroy the only other copy before the user chose to reset.
 */
async function readManifest(): Promise<{
  result: ParsedManifest;
  recovered: CompositionRecoveryKind;
}> {
  const promoted = await recoverManifestFromBackup();

  const primary = await parseManifestAt(COMPOSITION_MANIFEST_PATH);
  if (primary === null) {
    return { result: { ok: true, records: [], errorCode: null }, recovered: 'none' };
  }
  if (primary.ok) {
    return { result: primary, recovered: promoted ? 'backup' : 'primary' };
  }
  // A newer build's composition is refused outright rather than replaced by an
  // older backup, which would be a silent downgrade.
  if (primary.errorCode === 'composition_store_future_schema') {
    return { result: primary, recovered: 'none' };
  }
  const backup = await parseManifestAt(COMPOSITION_MANIFEST_BACKUP_PATH);
  if (backup && backup.ok) return { result: backup, recovered: 'backup' };
  return { result: primary, recovered: 'none' };
}

function findForActor(
  records: PrivateDressingRoomCompositionSet[],
  actorId: string | null,
): PrivateDressingRoomCompositionSet | null {
  for (const record of records) {
    if (record.actorId === actorId) return record;
  }
  return null;
}

function withActorRecord(
  records: PrivateDressingRoomCompositionSet[],
  actorId: string | null,
  next: PrivateDressingRoomCompositionSet | null,
): PrivateDressingRoomCompositionSet[] {
  const others = records.filter((record) => record.actorId !== actorId);
  return next ? [...others, next] : others;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load this actor's composition, validated against the CURRENT session context.
 *
 * A stored set whose fingerprint no longer matches is reported as `stale` with
 * no composition rather than returned — which is what makes an anchor or
 * occasion change safe without a cross-file transaction. A stale file that
 * survived a failed cleanup simply has no context to be current for.
 */
export async function loadCompositionSet(
  actorRequest: unknown,
  expectedFingerprint: string,
): Promise<CompositionResult> {
  const authority = resolveCompositionAuthority(actorRequest);
  if (!authority.ok) return failure(authority.errorCode, false);

  try {
    await compositionMutationQueue;
    const { result, recovered } = await readManifest();
    if (!result.ok) return failure(result.errorCode, true);

    const post = resolveCompositionAuthority(actorRequest);
    if (!post.ok) return failure(post.errorCode, false);

    const composition = findForActor(result.records, post.actorId);
    if (!composition) return success(null, recovered);

    if (!isCompositionCurrent(composition, expectedFingerprint)) {
      return { ...failure('composition_stale', false, true), ok: true };
    }
    return success(composition, recovered);
  } catch {
    return failure('composition_store_unreadable', true);
  }
}

/** Recovery-aware load. Performs NO write, so restoring cannot bump updatedAt. */
export async function recoverCompositionSet(
  actorRequest: unknown,
  expectedFingerprint: string,
): Promise<CompositionResult> {
  return loadCompositionSet(actorRequest, expectedFingerprint);
}

/**
 * Replace this actor's composition with a freshly composed set.
 *
 * The caller has already persisted the session mutation and recalculated the
 * fingerprint; publishing to the UI happens only after this resolves ok.
 */
export async function replaceCompositionSet(
  actorRequest: unknown,
  input: {
    sessionId: string;
    inputFingerprint: string;
    looks: PrivateDressingRoomLookOption[];
    activeLookId?: string | null;
  },
): Promise<CompositionResult> {
  const pre = resolveCompositionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false);

  return enqueue(async () => {
    const { result } = await readManifest();
    // A damaged manifest must not block a replacement: the new set is
    // authoritative and the unreadable bytes have no reader.
    const existing = result.ok ? result.records : [];

    const post = resolveCompositionAuthority(actorRequest);
    if (!post.ok) return failure(post.errorCode, false);

    const next = buildCompositionSet({
      actorId: post.actorId,
      sessionId: input.sessionId,
      inputFingerprint: input.inputFingerprint,
      looks: input.looks,
      activeLookId: input.activeLookId ?? null,
    });

    const commit = resolveCompositionAuthority(actorRequest);
    if (!commit.ok || commit.actorId !== post.actorId) {
      return failure('stale_actor_context', false);
    }

    try {
      await persistCompositions(withActorRecord(existing, commit.actorId, next));
    } catch {
      return failure('composition_persist_failed', true);
    }
    return success(next, 'primary');
  });
}

/**
 * Persist the active look selection.
 *
 * Selection is NOT a Saved Look: it changes which of the already-composed
 * options is current and leaves every look's contents untouched.
 */
export async function setActiveLook(
  actorRequest: unknown,
  input: { lookId: string; expectedFingerprint: string },
): Promise<CompositionResult> {
  const pre = resolveCompositionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false);

  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return failure(result.errorCode, true);

    const post = resolveCompositionAuthority(actorRequest);
    if (!post.ok) return failure(post.errorCode, false);

    const current = findForActor(result.records, post.actorId);
    if (!current) return failure('composition_store_corrupt', true);

    // Selecting inside a composition whose context has moved on would persist a
    // choice the user never saw under the outfits they are actually looking at.
    if (!isCompositionCurrent(current, input.expectedFingerprint)) {
      return { ...failure('composition_stale', false, true), ok: true };
    }
    if (!current.looks.some((look) => look.lookId === input.lookId)) {
      return failure('composition_store_corrupt', true);
    }

    const next = reviseCompositionSet(current, { activeLookId: input.lookId });

    const commit = resolveCompositionAuthority(actorRequest);
    if (!commit.ok || commit.actorId !== post.actorId) {
      return failure('stale_actor_context', false);
    }

    try {
      await persistCompositions(withActorRecord(result.records, commit.actorId, next));
    } catch {
      return failure('composition_persist_failed', true);
    }
    return success(next, 'primary');
  });
}

/**
 * Remove this actor's composition.
 *
 * Best-effort cleanup after a session discard or context change. The caller
 * must NOT depend on it: fingerprint validation already makes a surviving file
 * unusable, which is exactly why cleanup failing is not an error worth
 * surfacing.
 */
export async function discardCompositionSet(actorRequest: unknown): Promise<CompositionResult> {
  const pre = resolveCompositionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false);

  return enqueue(async () => {
    const { result } = await readManifest();
    const commit = resolveCompositionAuthority(actorRequest);
    if (!commit.ok) return failure(commit.errorCode, false);

    const records = result.ok ? withActorRecord(result.records, commit.actorId, null) : [];
    try {
      await persistCompositions(records);
    } catch {
      return failure('composition_persist_failed', true);
    }
    return success(null, 'none');
  });
}

/**
 * Explicit, user-driven reset after an unrecoverable read.
 *
 * The ONLY path that discards composition bytes it could not read, and it
 * exists so erasure is the user's decision. The private SESSION is untouched —
 * a damaged outfit list must never cost the user their anchor and occasion.
 */
export async function resetCorruptComposition(
  actorRequest: unknown,
): Promise<CompositionResult> {
  const pre = resolveCompositionAuthority(actorRequest);
  if (!pre.ok) return failure(pre.errorCode, false);

  return enqueue(async () => {
    const { result } = await readManifest();
    const commit = resolveCompositionAuthority(actorRequest);
    if (!commit.ok) return failure(commit.errorCode, false);

    const records = result.ok ? withActorRecord(result.records, commit.actorId, null) : [];
    try {
      await persistCompositions(records);
      await FileSystem.deleteAsync(COMPOSITION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
        () => null,
      );
    } catch {
      return failure('composition_persist_failed', true);
    }
    return success(null, 'none');
  });
}

/**
 * Reconcile a loaded composition against the Closet the user has RIGHT NOW.
 *
 * PURE — no write. A look whose supporting garment has been deleted is reported
 * stale rather than silently repaired, because substituting a replacement would
 * present the user an outfit they never chose. Nothing is reconstructed from
 * the missing item, and a NEWLY ADDED Closet item never invalidates a still
 * valid composition.
 */
export function reconcileCompositionSet(
  composition: PrivateDressingRoomCompositionSet | null | undefined,
  availableClosetItemIds: readonly string[],
  anchorClosetItemId?: string | null,
): {
  anchorMissing: boolean;
  staleLookIds: string[];
  usableLooks: PrivateDressingRoomLookOption[];
} {
  if (!composition) {
    return { anchorMissing: false, staleLookIds: [], usableLooks: [] };
  }
  const available = new Set(availableClosetItemIds ?? []);
  const anchorMissing =
    typeof anchorClosetItemId === 'string' &&
    !!anchorClosetItemId &&
    !available.has(anchorClosetItemId);

  const staleLookIds: string[] = [];
  const usableLooks: PrivateDressingRoomLookOption[] = [];
  for (const look of composition.looks) {
    const intact = look.items.every((item) => available.has(item.closetItemId));
    if (intact) usableLooks.push(look);
    else staleLookIds.push(look.lookId);
  }
  return { anchorMissing, staleLookIds, usableLooks };
}

/** Test seam only. Not used by production code. */
export const __privateCompositionStoreInternals = {
  persistCompositions,
  readManifest,
  findForActor,
  withActorRecord,
  resolveCompositionAuthority,
};
