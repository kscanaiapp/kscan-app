/**
 * Actor-scoped persistence for the PRIVATE Dressing Room session.
 *
 * STORAGE DOMAIN. This store owns `kscan_private_dressing_room/` and nothing
 * else. It shares no directory, no filename and no manifest with the committed
 * Closet (`kscan_closet/`), Closet candidates (`kscan_closet_candidates/`),
 * Saved Looks, free-tier outfit records, receipts, or the collaborative cloud
 * Dressing Room product. Nothing here issues a network call.
 *
 * THE WRITE SEQUENCE IS NOT NEW. `persistSessions` is the write-verify-swap
 * already proven by services/closetCandidateLibrary.js#persistCandidates, step
 * for step, and `recoverManifestFromBackup` closes the same crash window on the
 * next read. No `fsync` is invented here because the repository does not have
 * one, and inventing a durability step that Expo's FileSystem does not expose
 * would be a claim this code cannot honour.
 *
 * ONE ACTIVE SESSION PER ACTOR. The manifest holds at most one record per actor
 * partition. A discarded session is RETAINED as `status: 'discarded'` rather
 * than deleted, which is what lets the Stylist entry distinguish "you ended your
 * session" from "you never had one" without a second bookkeeping field — and it
 * keeps the file bounded, because the next start replaces the record in place.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { resolveWriteAuthority } from './actorContext';
import {
  buildPrivateDressingRoomSession,
  migratePrivateDressingRoomSessionRecord,
  revisePrivateDressingRoomSession,
} from './privateDressingRoomSessionSchema';
import type {
  PrivateDressingRoomSession,
  PrivateDressingRoomSessionErrorCode,
} from '../types/privateDressingRoomSession';

// ── Storage namespace ────────────────────────────────────────────────────────

export const PRIVATE_SESSION_DIR =
  FileSystem.documentDirectory + 'kscan_private_dressing_room/';
export const PRIVATE_SESSION_MANIFEST_PATH =
  PRIVATE_SESSION_DIR + 'kscan_private_dressing_room_sessions.json';
export const PRIVATE_SESSION_MANIFEST_TEMP_PATH = PRIVATE_SESSION_MANIFEST_PATH + '.tmp';
export const PRIVATE_SESSION_MANIFEST_BACKUP_PATH = PRIVATE_SESSION_MANIFEST_PATH + '.bak';

// ── Result contracts ─────────────────────────────────────────────────────────

/** How the session that is being returned was obtained. */
export type PrivateSessionRecoveryKind = 'primary' | 'backup' | 'none';

/**
 * FLAT result shapes, for the reason documented on
 * PrivateDressingRoomSessionMigration: this project compiles without
 * `strictNullChecks`, and TypeScript will not narrow a union by a boolean
 * literal discriminant under that setting. A caller can therefore read
 * `errorCode` on a failed result without a cast, which is exactly what the
 * route-level UI needs in order to choose a recovery state.
 */
export type PrivateSessionResult = {
  ok: boolean;
  /** null means: this actor has no active session. Not an error when ok. */
  session: PrivateDressingRoomSession | null;
  recovered: PrivateSessionRecoveryKind;
  errorCode: PrivateDressingRoomSessionErrorCode | null;
  /** True when an explicit user-driven reset can clear the failure. */
  recoverable: boolean;
};

type AuthorityResult = {
  ok: boolean;
  actorId: string | null;
  errorCode: PrivateDressingRoomSessionErrorCode | null;
};

function sessionFailure(
  errorCode: PrivateDressingRoomSessionErrorCode,
  recoverable: boolean,
): PrivateSessionResult {
  return { ok: false, session: null, recovered: 'none', errorCode, recoverable };
}

function sessionSuccess(
  session: PrivateDressingRoomSession | null,
  recovered: PrivateSessionRecoveryKind,
): PrivateSessionResult {
  return { ok: true, session, recovered, errorCode: null, recoverable: false };
}

let sessionMutationQueue: Promise<unknown> = Promise.resolve();

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Serialize every mutation. Mirrors closetCandidateLibrary.js#enqueue. */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionMutationQueue.then(operation, operation);
  sessionMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Resolve write authority AND apply the established Android platform
 * divergence. Mirrors services/closetCandidateLibrary.js#resolveCandidateAuthority
 * and services/closetLibrary.js#createClosetItem: Android has never supported
 * signed-out durable writes, so an ownerless context is refused rather than
 * downgraded. iOS keeps its durable ownerless partition.
 *
 * This is the ONLY actor gate. A route parameter can never select an actor,
 * because no function in this module accepts an actor id — only a captured
 * request, which is validated against the LIVE context.
 */
function resolveSessionAuthority(actorRequest: unknown): AuthorityResult {
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

function belongsToActor(record: PrivateDressingRoomSession, actorId: string | null): boolean {
  return record.actorId === actorId;
}

/**
 * Atomically replace the manifest.
 *
 * Step for step this is services/closetCandidateLibrary.js#persistCandidates:
 *
 *   1. discard any stale temp from an earlier interrupted write
 *   2. write the replacement BESIDE the canonical file
 *   3. read it back and compare — an unverified replacement is never swapped in
 *   4. move the current manifest aside to `.bak` (still the last valid manifest)
 *   5. move the verified replacement into place
 *   6. drop the backup
 *
 * A crash between 4 and 5 is the one window that leaves no canonical manifest,
 * and `recoverManifestFromBackup` closes it on the next read.
 */
async function persistSessions(records: PrivateDressingRoomSession[]): Promise<void> {
  await FileSystem.makeDirectoryAsync(PRIVATE_SESSION_DIR, { intermediates: true }).catch(
    () => null,
  );
  const payload = JSON.stringify(records);

  await FileSystem.deleteAsync(PRIVATE_SESSION_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
    () => null,
  );
  await FileSystem.writeAsStringAsync(PRIVATE_SESSION_MANIFEST_TEMP_PATH, payload, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  let verified: string | null = null;
  try {
    verified = await FileSystem.readAsStringAsync(PRIVATE_SESSION_MANIFEST_TEMP_PATH, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    verified = null;
  }
  if (verified !== payload) {
    await FileSystem.deleteAsync(PRIVATE_SESSION_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
      () => null,
    );
    const error = new Error('private_dressing_room_manifest_unverified');
    (error as Error & { code?: string }).code = 'session_persist_failed';
    throw error;
  }

  const existing = await FileSystem.getInfoAsync(PRIVATE_SESSION_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (existing?.exists) {
    await FileSystem.deleteAsync(PRIVATE_SESSION_MANIFEST_BACKUP_PATH, {
      idempotent: true,
    }).catch(() => null);
    await FileSystem.moveAsync({
      from: PRIVATE_SESSION_MANIFEST_PATH,
      to: PRIVATE_SESSION_MANIFEST_BACKUP_PATH,
    });
  }

  try {
    await FileSystem.moveAsync({
      from: PRIVATE_SESSION_MANIFEST_TEMP_PATH,
      to: PRIVATE_SESSION_MANIFEST_PATH,
    });
  } catch (error) {
    const backup = await FileSystem.getInfoAsync(PRIVATE_SESSION_MANIFEST_BACKUP_PATH).catch(
      () => ({ exists: false }),
    );
    if (backup?.exists) {
      await FileSystem.moveAsync({
        from: PRIVATE_SESSION_MANIFEST_BACKUP_PATH,
        to: PRIVATE_SESSION_MANIFEST_PATH,
      }).catch(() => null);
    }
    throw error;
  }

  await FileSystem.deleteAsync(PRIVATE_SESSION_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
    () => null,
  );
}

/**
 * Close the crash window inside `persistSessions`: the manifest was moved aside
 * but the replacement had not landed. The backup IS the last valid manifest, so
 * it is restored rather than discarded. Mirrors
 * closetCandidateLibrary.js#recoverManifestFromBackup.
 */
async function recoverManifestFromBackup(): Promise<boolean> {
  const canonical = await FileSystem.getInfoAsync(PRIVATE_SESSION_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (canonical?.exists) return false;
  const backup = await FileSystem.getInfoAsync(PRIVATE_SESSION_MANIFEST_BACKUP_PATH).catch(() => ({
    exists: false,
  }));
  if (!backup?.exists) return false;
  try {
    await FileSystem.moveAsync({
      from: PRIVATE_SESSION_MANIFEST_BACKUP_PATH,
      to: PRIVATE_SESSION_MANIFEST_PATH,
    });
    return true;
  } catch {
    return false;
  }
}

type ParsedManifest = {
  ok: boolean;
  records: PrivateDressingRoomSession[];
  futureSchema: boolean;
  errorCode: PrivateDressingRoomSessionErrorCode | null;
};

function manifestFailure(errorCode: PrivateDressingRoomSessionErrorCode): ParsedManifest {
  return {
    ok: false,
    records: [],
    futureSchema: errorCode === 'session_store_future_schema',
    errorCode,
  };
}

async function parseManifestAt(uri: string): Promise<ParsedManifest | null> {
  const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }));
  if (!info?.exists) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await FileSystem.readAsStringAsync(uri));
  } catch {
    return manifestFailure('session_store_corrupt');
  }
  if (!Array.isArray(parsed)) return manifestFailure('session_store_corrupt');

  const records: PrivateDressingRoomSession[] = [];
  let futureSchema = false;
  for (const entry of parsed) {
    const migrated = migratePrivateDressingRoomSessionRecord(entry);
    if (migrated.ok && migrated.record) {
      records.push(migrated.record);
      continue;
    }
    if (migrated.errorCode === 'session_store_future_schema') futureSchema = true;
  }

  // A manifest whose every entry is unreadable is not "an empty store": reading
  // it as empty and then writing over it is exactly what would destroy the
  // user's session. Only report success when something survived, or when the
  // file genuinely held no entries.
  if (records.length === 0 && parsed.length > 0) {
    return manifestFailure(
      futureSchema ? 'session_store_future_schema' : 'session_store_corrupt',
    );
  }
  return { ok: true, records, futureSchema, errorCode: null };
}

type ManifestRead = {
  result: ParsedManifest;
  recovered: PrivateSessionRecoveryKind;
};

/**
 * Read the manifest across EVERY actor partition, with recovery.
 *
 * Order matters and follows the established store: first close the write crash
 * window (backup promoted only when the canonical file is MISSING), then parse.
 * If the canonical file is present but UNREADABLE, the backup is consulted as a
 * read-only fallback — the damaged primary is deliberately left on disk, because
 * overwriting it here would destroy the only other copy of the user's data
 * before they have chosen to reset.
 */
async function readManifest(): Promise<ManifestRead> {
  const promoted = await recoverManifestFromBackup();

  const primary = await parseManifestAt(PRIVATE_SESSION_MANIFEST_PATH);
  if (primary === null) {
    // No manifest at all: this device has never held a private session.
    return {
      result: { ok: true, records: [], futureSchema: false, errorCode: null },
      recovered: 'none',
    };
  }
  if (primary.ok) {
    return { result: primary, recovered: promoted ? 'backup' : 'primary' };
  }

  // A future-schema manifest is refused outright. Falling back to an older
  // backup would silently downgrade a newer build's session.
  if (primary.errorCode === 'session_store_future_schema') {
    return { result: primary, recovered: 'none' };
  }

  const backup = await parseManifestAt(PRIVATE_SESSION_MANIFEST_BACKUP_PATH);
  if (backup && backup.ok) {
    return { result: backup, recovered: 'backup' };
  }
  return { result: primary, recovered: 'none' };
}

function findActive(
  records: PrivateDressingRoomSession[],
  actorId: string | null,
): PrivateDressingRoomSession | null {
  for (const record of records) {
    if (belongsToActor(record, actorId) && record.status === 'active') return record;
  }
  return null;
}

/** Replace this actor's record, leaving every other partition byte-identical. */
function withActorRecord(
  records: PrivateDressingRoomSession[],
  actorId: string | null,
  next: PrivateDressingRoomSession | null,
): PrivateDressingRoomSession[] {
  const others = records.filter((record) => !belongsToActor(record, actorId));
  return next ? [...others, next] : others;
}

/**
 * The shared mutation body.
 *
 * The actor is validated THREE times: when the caller's request is captured
 * (by the caller), before the authoritative read, and again immediately before
 * the write commits. The last check is the one that matters — an actor can
 * change while the read is in flight, and a completion that loses that race
 * must never be allowed to write, nor to be reported back to the UI as success.
 */
async function mutate(
  actorRequest: unknown,
  apply: (
    current: PrivateDressingRoomSession | null,
    actorId: string | null,
  ) => PrivateDressingRoomSession | null,
): Promise<PrivateSessionResult> {
  const preAuthority = resolveSessionAuthority(actorRequest);
  if (!preAuthority.ok) return sessionFailure(preAuthority.errorCode, false);

  return enqueue(async () => {
    const { result } = await readManifest();
    if (!result.ok) return sessionFailure(result.errorCode, true);

    // Re-check AFTER the await: the actor may have changed while reading.
    const postAuthority = resolveSessionAuthority(actorRequest);
    if (!postAuthority.ok) return sessionFailure(postAuthority.errorCode, false);

    const actorId = postAuthority.actorId;
    const current = findActive(result.records, actorId);
    const next = apply(current, actorId);
    if (next === current) return sessionSuccess(current, 'primary');

    const records = withActorRecord(result.records, actorId, next);

    // Final gate, immediately before the bytes land.
    const commitAuthority = resolveSessionAuthority(actorRequest);
    if (!commitAuthority.ok || commitAuthority.actorId !== actorId) {
      return sessionFailure('stale_actor_context', false);
    }

    try {
      await persistSessions(records);
    } catch {
      return sessionFailure('session_persist_failed', true);
    }
    return sessionSuccess(next, 'primary');
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a session, or return the actor's existing active one.
 *
 * Phase 1 supports exactly one active session per actor, so this is idempotent
 * by design: starting again does not fork a second workspace. When the caller
 * supplies an anchor or occasion and a session is already active, the existing
 * session is UPDATED in place rather than replaced, which is what makes
 * "open from a Closet item while a session is running" coherent.
 */
export async function startActiveSession(
  actorRequest: unknown,
  input: { anchorClosetItemId?: string | null; occasion?: string | null } = {},
): Promise<PrivateSessionResult> {
  const hasAnchor = 'anchorClosetItemId' in input;
  const hasOccasion = 'occasion' in input;
  return mutate(actorRequest, (current, actorId) => {
    if (current) {
      if (!hasAnchor && !hasOccasion) return current;
      const patch: { anchorClosetItemId?: string | null; occasion?: string | null } = {};
      if (hasAnchor) patch.anchorClosetItemId = input.anchorClosetItemId ?? null;
      if (hasOccasion) patch.occasion = input.occasion ?? null;
      return revisePrivateDressingRoomSession(current, patch);
    }
    return buildPrivateDressingRoomSession({
      actorId,
      anchorClosetItemId: input.anchorClosetItemId ?? null,
      occasion: input.occasion ?? null,
    });
  });
}

/**
 * Load the actor's active session.
 *
 * A READ never writes. A corrupt or future-schema manifest is reported as a
 * typed failure so the workspace can explain it and offer a reset, rather than
 * being reported as "no session" — which would look identical to a fresh device
 * and would invite the next write to overwrite recoverable data.
 */
export async function loadActiveSession(actorRequest: unknown): Promise<PrivateSessionResult> {
  const authority = resolveSessionAuthority(actorRequest);
  if (!authority.ok) return sessionFailure(authority.errorCode, false);
  try {
    await sessionMutationQueue;
    const { result, recovered } = await readManifest();
    if (!result.ok) return sessionFailure(result.errorCode, true);

    const postAuthority = resolveSessionAuthority(actorRequest);
    if (!postAuthority.ok) return sessionFailure(postAuthority.errorCode, false);

    return sessionSuccess(findActive(result.records, postAuthority.actorId), recovered);
  } catch {
    return sessionFailure('session_store_unreadable', true);
  }
}

/**
 * Recovery-aware load used at route entry.
 *
 * Distinct from `loadActiveSession` only in intent: it is the call the workspace
 * makes when it is prepared to render a recovery state. It performs NO write, so
 * a recovery that changes nothing on disk cannot advance `updatedAt` — the
 * session the user gets back is byte-for-byte the one they left.
 */
export async function recoverActiveSession(actorRequest: unknown): Promise<PrivateSessionResult> {
  return loadActiveSession(actorRequest);
}

/** Update the active session in place. No active session is not an error. */
export async function updateActiveSession(
  actorRequest: unknown,
  patch: { anchorClosetItemId?: string | null; occasion?: string | null },
): Promise<PrivateSessionResult> {
  return mutate(actorRequest, (current) => {
    if (!current) return current;
    return revisePrivateDressingRoomSession(current, patch);
  });
}

/**
 * Discard the active session.
 *
 * A transition, not a delete: the record is retained as `discarded` so the next
 * start mints a NEW session id rather than resurrecting this one.
 */
export async function discardActiveSession(actorRequest: unknown): Promise<PrivateSessionResult> {
  return mutate(actorRequest, (current) => {
    if (!current) return current;
    return revisePrivateDressingRoomSession(current, { status: 'discarded' });
  });
}

/**
 * Explicit, user-driven reset after an unrecoverable read.
 *
 * This is the ONLY path that discards stored session bytes without being able to
 * read them first, and it exists precisely so that erasure is a decision the
 * user makes rather than something recovery does quietly on their behalf.
 *
 * When the manifest is readable, only this actor's partition is cleared. When it
 * is not, a fresh empty manifest is written: the unreadable bytes cannot be
 * partitioned, and leaving them would leave the workspace permanently stuck.
 */
export async function resetCorruptSession(actorRequest: unknown): Promise<PrivateSessionResult> {
  const preAuthority = resolveSessionAuthority(actorRequest);
  if (!preAuthority.ok) return sessionFailure(preAuthority.errorCode, false);

  return enqueue(async () => {
    const { result } = await readManifest();

    const commitAuthority = resolveSessionAuthority(actorRequest);
    if (!commitAuthority.ok) return sessionFailure(commitAuthority.errorCode, false);

    const records = result.ok
      ? withActorRecord(result.records, commitAuthority.actorId, null)
      : [];

    try {
      await persistSessions(records);
      await FileSystem.deleteAsync(PRIVATE_SESSION_MANIFEST_BACKUP_PATH, {
        idempotent: true,
      }).catch(() => null);
    } catch {
      return sessionFailure('session_persist_failed', true);
    }
    return sessionSuccess(null, 'none');
  });
}

/** Test seam only. Not used by production code. */
export const __privateSessionStoreInternals = {
  persistSessions,
  readManifest,
  recoverManifestFromBackup,
  findActive,
  withActorRecord,
  resolveSessionAuthority,
};
