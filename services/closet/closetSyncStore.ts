// Build 34 / Track B / Phase B2B — durable Closet sync state.
//
// WHY A SIDECAR RATHER THAN FIELDS ON THE ITEM:
//
// services/closetLibrary.js#deleteClosetItem is a HARD delete — the record is
// removed from the manifest outright, there is no local tombstone. Sync state
// carried on the record would therefore be destroyed by exactly the operation
// whose evidence B2B most needs to keep (section 33: an offline delete must
// still tombstone the cloud row after a restart). Delete evidence cannot live
// on the thing being deleted.
//
// Putting SOME state on the item and delete evidence in a sidecar would mean
// two durable surfaces with two corruption/migration stories, so all of it
// lives here, in one account-partitioned file next to the Closet manifest.
//
// This is NOT a job queue. It records what each item's synchronization TRUTH
// is; the in-memory work list is reconstructed from it on demand (see
// closetSyncEngine#discoverPendingWork) and is itself disposable.
//
// ACCOUNT ISOLATION IS STRUCTURAL: entries are nested under ownerId, so a read
// for user B cannot return user A's entry even if the file is corrupt in some
// creative way — B's partition simply does not contain it. No auth token, no
// session, and no server id is ever stored outside its owner's partition.

import * as FileSystem from 'expo-file-system/legacy';
import {
  CLOSET_SYNC_STATE_SCHEMA_VERSION,
  createSyncEntry,
  type ClosetSyncEntry,
} from './closetSyncContract';

const CLOSET_DIR = FileSystem.documentDirectory + 'kscan_closet/';
const SYNC_PATH = CLOSET_DIR + 'kscan_closet_sync.json';

/** The signed-out device-local partition key. Mirrors actorContext's null actor. */
const OWNERLESS_KEY = '__ownerless__';

type SyncFile = {
  schemaVersion: number;
  owners: Record<string, Record<string, ClosetSyncEntry>>;
};

function emptyFile(): SyncFile {
  return { schemaVersion: CLOSET_SYNC_STATE_SCHEMA_VERSION, owners: {} };
}

function ownerKey(ownerId: string | null | undefined): string {
  return typeof ownerId === 'string' && ownerId.trim() ? ownerId.trim() : OWNERLESS_KEY;
}

/**
 * Serialize mutations. The Closet manifest uses the same single-promise-chain
 * discipline (closetLibrary#enqueueClosetMutation); two concurrent
 * read-modify-write cycles over one JSON file lose writes otherwise.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.catch(() => null);
  return next;
}

function coerceEntry(raw: unknown): ClosetSyncEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const state = value.state;
  if (
    state !== 'pending' &&
    state !== 'synced' &&
    state !== 'blocked' &&
    state !== 'error' &&
    state !== 'pending_delete'
  ) {
    return null;
  }
  // Rebuilt through createSyncEntry so an unknown or partial record can never
  // become an entry with missing invariants — same allowlist reasoning the
  // Closet record builder uses.
  return createSyncEntry({
    state,
    serverId: typeof value.serverId === 'string' && value.serverId ? value.serverId : null,
    serverRowVersion: Number.isFinite(value.serverRowVersion as number)
      ? (value.serverRowVersion as number)
      : null,
    factsAttempted: value.factsAttempted === true,
    syncedLocalUpdatedAt:
      typeof value.syncedLocalUpdatedAt === 'string' ? value.syncedLocalUpdatedAt : null,
    mediaState:
      value.mediaState === 'pending' || value.mediaState === 'ready' || value.mediaState === 'blocked'
        ? value.mediaState
        : 'none',
    blockedReason: typeof value.blockedReason === 'string' ? (value.blockedReason as any) : null,
    attemptCount: Number.isFinite(value.attemptCount as number) ? Math.max(0, value.attemptCount as number) : 0,
    lastAttemptAt: typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    lastFailureClass:
      value.lastFailureClass === 'retryable' ||
      value.lastFailureClass === 'permanent' ||
      value.lastFailureClass === 'conflict' ||
      value.lastFailureClass === 'unexpected_authorization'
        ? value.lastFailureClass
        : null,
    conflictExpectedRowVersion: Number.isFinite(value.conflictExpectedRowVersion as number)
      ? (value.conflictExpectedRowVersion as number)
      : null,
  });
}

/**
 * Best-effort preservation of an unreadable/malformed sidecar body.
 *
 * Section O: the sidecar now owns server ids, pending-delete evidence and row
 * versions, so silently discarding a corrupt file is not free — the very next
 * durable write (any save/edit/delete) would overwrite it with a fresh empty
 * one, destroying the only trace that anything was ever recorded, including a
 * pending_delete a cloud row is still waiting to be tombstoned by. This does
 * not attempt to RECOVER the corrupt state (a JSON parse failure has no
 * redundancy to recover from, and building one is a second persistence
 * database, explicitly out of scope for this pass) — it only keeps the raw
 * bytes somewhere a later investigation can find them, one snapshot deep.
 * Never throws; a failure here must not block the degraded read it guards.
 */
async function quarantineCorruptSidecar(raw: string | null): Promise<void> {
  if (raw === null) return;
  try {
    await FileSystem.writeAsStringAsync(`${SYNC_PATH}.corrupt`, raw, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    /* best effort only */
  }
}

async function readFile(): Promise<SyncFile> {
  let raw: string | null = null;
  try {
    const info = await FileSystem.getInfoAsync(SYNC_PATH);
    if (!info.exists) return emptyFile();
    raw = await FileSystem.readAsStringAsync(SYNC_PATH, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.owners || typeof parsed.owners !== 'object') {
      throw new Error('sidecar shape invalid');
    }
    const owners: SyncFile['owners'] = {};
    for (const [owner, entries] of Object.entries(parsed.owners as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      const kept: Record<string, ClosetSyncEntry> = {};
      for (const [clientId, entry] of Object.entries(entries as Record<string, unknown>)) {
        const coerced = coerceEntry(entry);
        if (coerced) kept[clientId] = coerced;
      }
      owners[owner] = kept;
    }
    return { schemaVersion: CLOSET_SYNC_STATE_SCHEMA_VERSION, owners };
  } catch {
    // A corrupt/unreadable sidecar degrades to "nothing is known about any
    // item", which is local_only for everything — the safe direction. It
    // never fails a local Closet operation and never invents a synced state.
    await quarantineCorruptSidecar(raw);
    return emptyFile();
  }
}

async function writeFile(file: SyncFile): Promise<void> {
  await FileSystem.makeDirectoryAsync(CLOSET_DIR, { intermediates: true }).catch(() => null);
  await FileSystem.writeAsStringAsync(SYNC_PATH, JSON.stringify(file), {
    encoding: FileSystem.EncodingType.UTF8,
  });
}

/** One item's entry, or null when the item is local-only. */
export async function getClosetSyncEntry(
  ownerId: string | null,
  clientId: string,
): Promise<ClosetSyncEntry | null> {
  const file = await readFile();
  return file.owners[ownerKey(ownerId)]?.[clientId] ?? null;
}

/** Every entry for one account. Never returns another account's partition. */
export async function listClosetSyncEntries(
  ownerId: string | null,
): Promise<Record<string, ClosetSyncEntry>> {
  const file = await readFile();
  return { ...(file.owners[ownerKey(ownerId)] ?? {}) };
}

/**
 * Read-modify-write one entry under the mutation queue.
 *
 * `mutate` receives the current entry (or null) and returns the next one, or
 * null to remove it. Removing is how a completed tombstone stops being work.
 */
export async function updateClosetSyncEntry(
  ownerId: string | null,
  clientId: string,
  mutate: (current: ClosetSyncEntry | null) => ClosetSyncEntry | null,
): Promise<ClosetSyncEntry | null> {
  return enqueue(async () => {
    const file = await readFile();
    const key = ownerKey(ownerId);
    const partition = { ...(file.owners[key] ?? {}) };
    const next = mutate(partition[clientId] ?? null);
    if (next === null) {
      delete partition[clientId];
    } else {
      partition[clientId] = next;
    }
    await writeFile({ ...file, owners: { ...file.owners, [key]: partition } });
    return next;
  }).catch(() => null);
}

/**
 * Result of attempting to durably record delete intent. A discriminated type
 * rather than a bare nullable — see the note on markClosetItemPendingDelete
 * for why `null` alone cannot be trusted here.
 */
export type ClosetDeleteMarkResult =
  /** No cloud row exists (never synced, or already fully released). Nothing to protect. */
  | { kind: 'no_evidence_needed' }
  /** pending_delete was durably written. Safe to proceed with the local delete. */
  | { kind: 'recorded'; entry: ClosetSyncEntry }
  /** The write itself could not be completed. The caller must NOT delete locally. */
  | { kind: 'persist_failed' };

/**
 * Record that a synced item has been deleted locally, so the cloud tombstone
 * survives the local hard delete and an app restart.
 *
 * Called BEFORE services/closetLibrary.js#deleteClosetItem removes the record.
 * An item that was never synced (no entry, or no serverId) needs no cloud work
 * at all, so its entry is simply dropped — writing a pending_delete for a row
 * that does not exist would create permanent, unsatisfiable work.
 *
 * DELIBERATELY DOES NOT GO THROUGH updateClosetSyncEntry. That helper's
 * `.catch(() => null)` makes "the mutate function legitimately returned null"
 * (no evidence needed) indistinguishable from "the filesystem write itself
 * threw" (evidence needed but LOST). For every other caller that ambiguity is
 * harmless — worst case, stale bookkeeping is retried later. Here it is not:
 * the caller uses this result to decide whether a HARD, irreversible local
 * delete may proceed, so the two outcomes must be told apart. This function
 * does its own read-decide-write atomically inside `enqueue` and reports
 * exactly one of the three outcomes above; any exception anywhere in that
 * sequence — including the internal read — becomes `persist_failed`, never a
 * silent `no_evidence_needed`, because a read failure means we genuinely do
 * not know whether a cloud row exists, and the safe direction when unsure is
 * to block the delete, not to assume nothing needs protecting.
 */
export async function markClosetItemPendingDelete(
  ownerId: string | null,
  clientId: string,
): Promise<ClosetDeleteMarkResult> {
  try {
    return await enqueue(async () => {
      const file = await readFile();
      const key = ownerKey(ownerId);
      const partition = { ...(file.owners[key] ?? {}) };
      const current = partition[clientId] ?? null;
      if (!current || !current.serverId) {
        // No disk write at all when there is nothing to change: a never-synced
        // item (no entry) must be deletable even while the sidecar file itself
        // is unwritable — there is genuinely nothing here for that failure to
        // put at risk, so a write attempt must not manufacture a false
        // persist_failed for it.
        if (current) {
          delete partition[clientId];
          await writeFile({ ...file, owners: { ...file.owners, [key]: partition } });
        }
        return { kind: 'no_evidence_needed' } as const;
      }
      const next: ClosetSyncEntry = {
        ...current,
        state: 'pending_delete',
        // A delete supersedes any prior failure: it is new work, eligible now,
        // not a continuation of the backoff the previous operation had earned.
        attemptCount: 0,
        lastAttemptAt: null,
        lastFailureClass: null,
        conflictExpectedRowVersion: null,
      };
      partition[clientId] = next;
      await writeFile({ ...file, owners: { ...file.owners, [key]: partition } });
      return { kind: 'recorded', entry: next } as const;
    });
  } catch {
    return { kind: 'persist_failed' };
  }
}

/** Drop one account's entire partition. For sign-out/account-deletion paths. */
export async function purgeClosetSyncStateForOwner(ownerId: string | null): Promise<void> {
  await enqueue(async () => {
    const file = await readFile();
    const owners = { ...file.owners };
    delete owners[ownerKey(ownerId)];
    await writeFile({ ...file, owners });
    return null;
  }).catch(() => null);
}

/** Test seam only. */
export const __closetSyncStoreInternals = {
  SYNC_PATH,
  OWNERLESS_KEY,
  ownerKey,
  coerceEntry,
  QUARANTINE_PATH: `${SYNC_PATH}.corrupt`,
};
