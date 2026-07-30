import * as FileSystem from 'expo-file-system/legacy';
import { resolveWriteAuthority } from './actorContext';
import type { ClosetItemProjection } from './closetItemProjection';
import type { EffectiveLook } from './privateDressingRoomEffectiveLook';
import {
  buildPrivateSavedLook,
  renamePrivateSavedLook,
  savedLookIdempotencyKey,
  validatePrivateSavedLook,
} from './privateSavedLookSchema';
import type {
  PrivateSavedLookErrorCode,
  PrivateSavedLookV1,
} from '../types/privateSavedLook';

export const SAVED_LOOKS_DIR =
  FileSystem.documentDirectory + 'kscan_private_dressing_room_saved_looks/';
export const SAVED_LOOKS_MANIFEST_PATH =
  SAVED_LOOKS_DIR + 'kscan_private_dressing_room_saved_looks.json';
export const SAVED_LOOKS_TEMP_PATH = SAVED_LOOKS_MANIFEST_PATH + '.tmp';
export const SAVED_LOOKS_BACKUP_PATH = SAVED_LOOKS_MANIFEST_PATH + '.bak';

export type SavedLooksRecoveryKind = 'primary' | 'backup' | 'none';

export type SavedLooksResult = {
  ok: boolean;
  looks: PrivateSavedLookV1[];
  look: PrivateSavedLookV1 | null;
  recovered: SavedLooksRecoveryKind;
  errorCode: PrivateSavedLookErrorCode | null;
  recoverable: boolean;
  created: boolean;
  wrote: boolean;
};

type Authority = {
  ok: boolean;
  actorId: string | null;
  errorCode: PrivateSavedLookErrorCode | null;
};

let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function failure(
  errorCode: PrivateSavedLookErrorCode,
  recoverable: boolean,
): SavedLooksResult {
  return {
    ok: false,
    looks: [],
    look: null,
    recovered: 'none',
    errorCode,
    recoverable,
    created: false,
    wrote: false,
  };
}

function success(input: {
  looks?: PrivateSavedLookV1[];
  look?: PrivateSavedLookV1 | null;
  recovered?: SavedLooksRecoveryKind;
  created?: boolean;
  wrote?: boolean;
} = {}): SavedLooksResult {
  return {
    ok: true,
    looks: input.looks ?? [],
    look: input.look ?? null,
    recovered: input.recovered ?? 'primary',
    errorCode: null,
    recoverable: false,
    created: input.created ?? false,
    wrote: input.wrote ?? false,
  };
}

function authorityFor(actorRequest: unknown): Authority {
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
  if (!actorId) return { ok: false, actorId: null, errorCode: 'missing_actor_context' };
  return { ok: true, actorId, errorCode: null };
}

async function persist(records: PrivateSavedLookV1[]): Promise<void> {
  await FileSystem.makeDirectoryAsync(SAVED_LOOKS_DIR, { intermediates: true }).catch(() => null);
  const payload = JSON.stringify(records);
  await FileSystem.deleteAsync(SAVED_LOOKS_TEMP_PATH, { idempotent: true }).catch(() => null);
  await FileSystem.writeAsStringAsync(SAVED_LOOKS_TEMP_PATH, payload, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  const verified = await FileSystem.readAsStringAsync(SAVED_LOOKS_TEMP_PATH, {
    encoding: FileSystem.EncodingType.UTF8,
  }).catch(() => null);
  if (verified !== payload) {
    await FileSystem.deleteAsync(SAVED_LOOKS_TEMP_PATH, { idempotent: true }).catch(() => null);
    throw new Error('saved_look_manifest_unverified');
  }

  const current = await FileSystem.getInfoAsync(SAVED_LOOKS_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (current?.exists) {
    await FileSystem.deleteAsync(SAVED_LOOKS_BACKUP_PATH, { idempotent: true }).catch(() => null);
    await FileSystem.moveAsync({
      from: SAVED_LOOKS_MANIFEST_PATH,
      to: SAVED_LOOKS_BACKUP_PATH,
    });
  }
  try {
    await FileSystem.moveAsync({ from: SAVED_LOOKS_TEMP_PATH, to: SAVED_LOOKS_MANIFEST_PATH });
  } catch (error) {
    const backup = await FileSystem.getInfoAsync(SAVED_LOOKS_BACKUP_PATH).catch(() => ({
      exists: false,
    }));
    if (backup?.exists) {
      await FileSystem.moveAsync({
        from: SAVED_LOOKS_BACKUP_PATH,
        to: SAVED_LOOKS_MANIFEST_PATH,
      }).catch(() => null);
    }
    throw error;
  }
  // Retain the previous verified primary as the recovery copy. The next
  // mutation replaces it immediately before the next atomic swap.
}

type ParsedManifest = {
  ok: boolean;
  records: PrivateSavedLookV1[];
  errorCode: PrivateSavedLookErrorCode | null;
};

async function parseAt(path: string): Promise<ParsedManifest | null> {
  const info = await FileSystem.getInfoAsync(path).catch(() => ({ exists: false }));
  if (!info?.exists) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await FileSystem.readAsStringAsync(path));
  } catch {
    return { ok: false, records: [], errorCode: 'saved_look_store_corrupt' };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, records: [], errorCode: 'saved_look_store_corrupt' };
  }
  const records: PrivateSavedLookV1[] = [];
  let futureSchema = false;
  let malformed = false;
  for (const value of raw) {
    const parsed = validatePrivateSavedLook(value);
    if (parsed.ok && parsed.record) records.push(parsed.record);
    else if (parsed.futureSchema) futureSchema = true;
    else malformed = true;
  }
  // A manifest is one atomic unit. Silently dropping even one unknown or
  // malformed record would turn a read into unreported data loss.
  if (futureSchema || malformed) {
    return {
      ok: false,
      records: [],
      errorCode: futureSchema ? 'saved_look_store_future_schema' : 'saved_look_store_corrupt',
    };
  }
  return { ok: true, records, errorCode: null };
}

async function recoverMissingPrimary(): Promise<boolean> {
  const primary = await FileSystem.getInfoAsync(SAVED_LOOKS_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (primary?.exists) return false;
  const temp = await parseAt(SAVED_LOOKS_TEMP_PATH);
  if (temp?.ok) {
    try {
      await FileSystem.moveAsync({
        from: SAVED_LOOKS_TEMP_PATH,
        to: SAVED_LOOKS_MANIFEST_PATH,
      });
      return true;
    } catch {
      // Fall through to the last verified backup.
    }
  }
  const backup = await FileSystem.getInfoAsync(SAVED_LOOKS_BACKUP_PATH).catch(() => ({
    exists: false,
  }));
  if (!backup?.exists) return false;
  try {
    await FileSystem.moveAsync({
      from: SAVED_LOOKS_BACKUP_PATH,
      to: SAVED_LOOKS_MANIFEST_PATH,
    });
    return true;
  } catch {
    return false;
  }
}

async function readManifest(): Promise<{
  result: ParsedManifest;
  recovered: SavedLooksRecoveryKind;
}> {
  const promoted = await recoverMissingPrimary();
  const primary = await parseAt(SAVED_LOOKS_MANIFEST_PATH);
  if (primary === null) {
    return { result: { ok: true, records: [], errorCode: null }, recovered: 'none' };
  }
  if (primary.ok) return { result: primary, recovered: promoted ? 'backup' : 'primary' };
  if (primary.errorCode === 'saved_look_store_future_schema') {
    return { result: primary, recovered: 'none' };
  }
  const backup = await parseAt(SAVED_LOOKS_BACKUP_PATH);
  if (backup?.ok) return { result: backup, recovered: 'backup' };
  return { result: primary, recovered: 'none' };
}

function createSavedLookId(now: number = Date.now()): string {
  return `saved-look-${now.toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

function forActor(records: PrivateSavedLookV1[], actorId: string): PrivateSavedLookV1[] {
  return records
    .filter((record) => record.actorId === actorId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadPrivateSavedLooks(actorRequest: unknown): Promise<SavedLooksResult> {
  const before = authorityFor(actorRequest);
  if (!before.ok || !before.actorId) return failure(before.errorCode!, false);
  try {
    // ENQUEUED, not merely awaited. `await mutationQueue` only waits for the
    // tail that existed at that instant; a mutation enqueued immediately after
    // runs CONCURRENTLY with the read below. That matters because persist()
    // deliberately leaves the primary absent between its two moves, and
    // recoverMissingPrimary() treats an absent primary as a crash to recover
    // from — so an overlapping read would promote the in-flight temp file out
    // from under the write, making the write fail on a file the reader took.
    // Sharing the queue makes a read never observe a half-completed swap.
    const { result, recovered } = await enqueue(() => readManifest());
    if (!result.ok) return failure(result.errorCode!, true);
    const after = authorityFor(actorRequest);
    if (!after.ok || after.actorId !== before.actorId) return failure('stale_actor_context', false);
    return success({ looks: forActor(result.records, after.actorId), recovered });
  } catch {
    return failure('saved_look_store_unreadable', true);
  }
}

export async function loadPrivateSavedLook(
  actorRequest: unknown,
  savedLookId: string,
): Promise<SavedLooksResult> {
  const loaded = await loadPrivateSavedLooks(actorRequest);
  if (!loaded.ok) return loaded;
  const look = loaded.looks.find((record) => record.id === savedLookId) ?? null;
  return look
    ? success({ look, looks: loaded.looks, recovered: loaded.recovered })
    : failure('saved_look_not_found', false);
}

export async function savePrivateSavedLook(
  actorRequest: unknown,
  input: {
    sourceSessionId: string;
    sourceCompositionId: string;
    sourceInputFingerprint: string;
    look: EffectiveLook;
    closetItems: readonly ClosetItemProjection[];
    occasion?: string | null;
    anchorClosetItemId?: string | null;
    name?: string | null;
  },
): Promise<SavedLooksResult> {
  const before = authorityFor(actorRequest);
  if (!before.ok || !before.actorId) return failure(before.errorCode!, false);

  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return failure(result.errorCode!, true);
    const turn = authorityFor(actorRequest);
    if (!turn.ok || turn.actorId !== before.actorId) return failure('stale_actor_context', false);

    const key = savedLookIdempotencyKey({
      sourceSessionId: input.sourceSessionId,
      sourceCompositionId: input.sourceCompositionId,
      sourceLookId: input.look?.lookId ?? '',
      sourceInputFingerprint: input.sourceInputFingerprint,
    });
    const existing = result.records.find(
      (record) => record.actorId === turn.actorId && savedLookIdempotencyKey(record) === key,
    );
    if (existing) {
      return success({ look: existing, looks: forActor(result.records, turn.actorId), wrote: false });
    }

    const now = new Date().toISOString();
    const next = buildPrivateSavedLook({
      ...input,
      id: createSavedLookId(),
      actorId: turn.actorId,
      now,
    });
    if (!next) return failure('saved_look_invalid_input', false);

    const commit = authorityFor(actorRequest);
    if (!commit.ok || commit.actorId !== turn.actorId) return failure('stale_actor_context', false);
    try {
      await persist([...result.records, next]);
    } catch {
      return failure('saved_look_persist_failed', true);
    }
    const after = authorityFor(actorRequest);
    if (!after.ok || after.actorId !== commit.actorId) {
      return failure('stale_actor_context', false);
    }
    return success({
      look: next,
      looks: forActor([...result.records, next], after.actorId),
      created: true,
      wrote: true,
    });
  });
}

export async function renameSavedLook(
  actorRequest: unknown,
  savedLookId: string,
  name: string | null,
): Promise<SavedLooksResult> {
  const before = authorityFor(actorRequest);
  if (!before.ok || !before.actorId) return failure(before.errorCode!, false);
  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return failure(result.errorCode!, true);
    const turn = authorityFor(actorRequest);
    if (!turn.ok || turn.actorId !== before.actorId) return failure('stale_actor_context', false);
    const index = result.records.findIndex(
      (record) => record.actorId === turn.actorId && record.id === savedLookId,
    );
    if (index < 0) return failure('saved_look_not_found', false);
    const next = renamePrivateSavedLook(result.records[index], name, new Date().toISOString());
    if (!next) return failure('saved_look_invalid_input', false);
    const records = result.records.slice();
    records[index] = next;
    const commit = authorityFor(actorRequest);
    if (!commit.ok || commit.actorId !== turn.actorId) return failure('stale_actor_context', false);
    try {
      await persist(records);
    } catch {
      return failure('saved_look_persist_failed', true);
    }
    const after = authorityFor(actorRequest);
    if (!after.ok || after.actorId !== commit.actorId) {
      return failure('stale_actor_context', false);
    }
    return success({ look: next, looks: forActor(records, after.actorId), wrote: true });
  });
}

export async function deleteSavedLook(
  actorRequest: unknown,
  savedLookId: string,
): Promise<SavedLooksResult> {
  const before = authorityFor(actorRequest);
  if (!before.ok || !before.actorId) return failure(before.errorCode!, false);
  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return failure(result.errorCode!, true);
    const turn = authorityFor(actorRequest);
    if (!turn.ok || turn.actorId !== before.actorId) return failure('stale_actor_context', false);
    const found = result.records.some(
      (record) => record.actorId === turn.actorId && record.id === savedLookId,
    );
    if (!found) return failure('saved_look_not_found', false);
    const records = result.records.filter(
      (record) => !(record.actorId === turn.actorId && record.id === savedLookId),
    );
    const commit = authorityFor(actorRequest);
    if (!commit.ok || commit.actorId !== turn.actorId) return failure('stale_actor_context', false);
    try {
      await persist(records);
    } catch {
      return failure('saved_look_persist_failed', true);
    }
    const after = authorityFor(actorRequest);
    if (!after.ok || after.actorId !== commit.actorId) {
      return failure('stale_actor_context', false);
    }
    return success({ looks: forActor(records, after.actorId), wrote: true });
  });
}

/**
 * Narrow future account-deletion primitive. It removes only records whose
 * stored actorId equals the supplied actor and is intentionally not wired to
 * any production deletion caller in Phase 5.
 */
export async function purgeSavedLooksForActor(actorId: string): Promise<SavedLooksResult> {
  const target = typeof actorId === 'string' ? actorId.trim() : '';
  if (!target) return failure('saved_look_invalid_input', false);
  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return failure(result.errorCode!, true);
    const records = result.records.filter((record) => record.actorId !== target);
    if (records.length === result.records.length) return success({ looks: [], wrote: false });
    try {
      await persist(records);
    } catch {
      return failure('saved_look_persist_failed', true);
    }
    return success({ looks: [], wrote: true });
  });
}

export const __privateSavedLookStoreInternals = {
  authorityFor,
  createSavedLookId,
  forActor,
  parseAt,
  persist,
  readManifest,
};
