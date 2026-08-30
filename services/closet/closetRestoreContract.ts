// Build 34 / Track B / Phase B2C — Closet cross-device restore contract.
//
// PURE MODULE. No react-native, no expo, no Supabase, no filesystem. Same
// discipline as closetSyncContract.ts: every decision that can be expressed as
// a function of data lives here so it is testable without a device.
//
// THE GOVERNING RULE OF B2C:
//   The LOCAL Closet remains the immediate user experience. Cloud restore is
//   an enhancement layered on top, never a prerequisite: nothing in this file
//   may make a local Closet operation fail, wait, or become conditional on
//   cloud state.
//
// THIS IS INBOUND ONLY. B2C reconciles cloud truth INTO the local Closet. It
// never re-decides what B2B already pushed, and it never merges — a conflict
// is recorded as evidence, never resolved by guessing.

import type { ClosetSyncEntry } from './closetSyncContract';
import { buildClosetPrimaryPath, buildClosetThumbnailPath } from './closetSyncContract';

// ── Tunables ─────────────────────────────────────────────────────────────

/** Facts page size. Never an unbounded Closet listing. */
export const CLOSET_RESTORE_PAGE_SIZE = 20;

/** Bounded concurrent media downloads per pass. Mirrors B2B's "one item at a
 *  time" caution for the sanitizer, scaled up slightly because a download has
 *  no comparable decode/mask/re-encode memory cost. */
export const CLOSET_RESTORE_MEDIA_CONCURRENCY = 2;

/** Anti-churn guard: the Closet-focus trigger must not repeat a network round
 *  trip on rapid re-focus. Not a synchronization schedule — see the engine. */
export const CLOSET_RESTORE_COOLDOWN_MS = 30_000;

// ── Remote row shape B2C reasons about ──────────────────────────────────────

export interface ClosetRestoreRemoteRow {
  id: string;
  clientId: string;
  rowVersion: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  title: string;
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
  size: string | null;
  notes: string | null;
  origin: string;
  storageBucket: string | null;
  storagePath: string | null;
  thumbnailStoragePath: string | null;
  mediaStatus: 'pending' | 'ready' | 'failed' | null;
  mediaUploadedAt: string | null;
}

/** Local -> draft field projection, the inverse of closetSyncContract.ts's
 *  projectClosetItemForCloud. Fed through closetLibrary.js's own allowlist
 *  builder, which re-bounds and re-validates every field independently —
 *  this function does not need to duplicate those bounds. */
export function projectClosetRestoreRowForLocal(row: ClosetRestoreRemoteRow): Record<string, any> {
  return {
    title: row.title,
    category: row.category,
    clothingType: row.clothingType,
    subtype: row.subtype,
    brand: row.brand,
    primaryColor: row.primaryColor,
    secondaryColors: Array.isArray(row.secondaryColors) ? row.secondaryColors : [],
    material: Array.isArray(row.material) ? row.material : [],
    size: row.size,
    notes: row.notes,
    origin: row.origin === 'recent_scan' ? 'recent_scan' : 'direct_intake',
    schemaVersion: Number.isFinite(row.schemaVersion) ? row.schemaVersion : 2,
  };
}

// ── Storage path validation ─────────────────────────────────────────────────

/**
 * FAIL CLOSED FOR MEDIA (section 31). The only two paths a remote row may
 * legitimately carry are the deterministic ones this user's id and this
 * item's server id derive — identical to the check Postgres itself already
 * enforces on write (user_closet_items_media_*_path_derived). Re-deriving and
 * comparing here, rather than trusting the row's own claim, is what makes a
 * corrupted or forged path fail the DOWNLOAD rather than merely the INSERT.
 */
export function isValidClosetRestoreMediaPath(
  userId: string,
  serverItemId: string,
  kind: 'primary' | 'thumbnail',
  path: string | null | undefined,
): boolean {
  if (typeof path !== 'string' || !path) return false;
  const expected =
    kind === 'primary' ? buildClosetPrimaryPath(userId, serverItemId) : buildClosetThumbnailPath(userId, serverItemId);
  return path === expected;
}

// ── Schema version handling (section 39) ────────────────────────────────────

export type ClosetRestoreSchemaDecision = 'proceed' | 'quarantine';

/** REMOTE > LOCAL is never guessed at, downgraded, or migrated on the fly. */
export function classifyClosetRestoreSchemaVersion(
  remoteSchemaVersion: number,
  localMaxSupportedSchemaVersion: number,
): ClosetRestoreSchemaDecision {
  if (!Number.isFinite(remoteSchemaVersion)) return 'quarantine';
  return remoteSchemaVersion > localMaxSupportedSchemaVersion ? 'quarantine' : 'proceed';
}

// ── Dirty-state determination (Addendum H) ──────────────────────────────────

export type ClosetRestoreDirtiness = 'clean' | 'dirty';

/**
 * Whether THIS device has unsynced local intent for an item that also has a
 * B2B sidecar relationship.
 *
 * Deliberately NOT `entry.state === 'error'` or `lastFailureClass` alone: a
 * media-only retry failure (facts already synced, only the upload attempt
 * failed) must not block a safe inbound facts reconciliation. What actually
 * makes local work "dirty" is either a durable delete intent, or local facts
 * that have changed since the last confirmed sync.
 */
export function classifyClosetLocalDirtiness(
  entry: ClosetSyncEntry | null,
  localUpdatedAt: string | null,
): ClosetRestoreDirtiness {
  if (!entry) return 'clean';
  if (entry.state === 'pending_delete') return 'dirty';
  if (localUpdatedAt !== entry.syncedLocalUpdatedAt) return 'dirty';
  return 'clean';
}

// ── The reconciliation matrix (section 24), as one pure classifier ─────────

export type ClosetRestoreAction =
  /** Local item exists with no B2B relationship. B3's territory, never B2C's. */
  | { kind: 'skip_no_relationship' }
  /** A local delete is durably recorded. Never resurrect it. */
  | { kind: 'skip_pending_delete' }
  /**
   * The sidecar entry has no confirmed serverId yet — B2B's own outbound
   * crash-recovery (closetFactsSync.ts#findCloudClosetItemByClientId) owns
   * this window exclusively. Recording a B2C conflict here would set
   * lastFailureClass: 'conflict', which closetSyncContract.ts#needsSyncWork
   * treats as "wait for B2C" — silently freezing the very outbound attempt
   * that would otherwise resolve it on its own next pass.
   */
  | { kind: 'skip_outbound_in_progress' }
  /** No local item, remote tombstoned, nothing to reconcile. */
  | { kind: 'skip_goal_already_met' }
  /** No local item, remote tombstoned, but a stale entry still references it. */
  | { kind: 'clear_stale_entry' }
  /** No local item (new device, or a restart-recovery re-materialization). */
  | { kind: 'materialize' }
  /** Clean and already current. No write of any kind. */
  | { kind: 'noop' }
  /** Clean, remote moved on. Facts overwrite the local record. */
  | { kind: 'remote_wins' }
  /** Clean, remote tombstoned. Local item is hard-deleted. */
  | { kind: 'remote_delete_wins' }
  /** Dirty, remote unchanged. Local outbound work remains authoritative. */
  | { kind: 'local_outbound_authoritative' }
  /** Dirty, remote also moved on. Evidence recorded, nothing overwritten. */
  | { kind: 'conflict_remote_newer' }
  /** Dirty, remote tombstoned. Evidence recorded, nothing deleted. */
  | { kind: 'conflict_remote_tombstone' };

export function classifyClosetRestoreAction(input: {
  remote: ClosetRestoreRemoteRow;
  hasLocalItem: boolean;
  entry: ClosetSyncEntry | null;
  localUpdatedAt: string | null;
}): ClosetRestoreAction {
  const { remote, hasLocalItem, entry, localUpdatedAt } = input;
  const remoteTombstoned = remote.deletedAt !== null;

  // PRE-B2B RULE (Addendum B), checked first and unconditionally: a local
  // item with no sidecar entry is never adopted, overwritten, or migrated.
  if (hasLocalItem && !entry) return { kind: 'skip_no_relationship' };

  // A durable local delete always wins, before anything else is considered.
  if (entry && entry.state === 'pending_delete') return { kind: 'skip_pending_delete' };

  // B2B's own crash-recovery window. See the variant's doc comment.
  if (entry && !entry.serverId) return { kind: 'skip_outbound_in_progress' };

  if (!hasLocalItem) {
    if (remoteTombstoned) {
      return entry ? { kind: 'clear_stale_entry' } : { kind: 'skip_goal_already_met' };
    }
    return { kind: 'materialize' };
  }

  // Local item exists AND a confirmed sidecar relationship exists.
  const dirtiness = classifyClosetLocalDirtiness(entry, localUpdatedAt);
  const syncedRowVersion = entry ? entry.serverRowVersion : null;
  const remoteIsNewer = syncedRowVersion === null || remote.rowVersion > syncedRowVersion;

  if (dirtiness === 'dirty') {
    if (remoteTombstoned) return { kind: 'conflict_remote_tombstone' };
    if (remoteIsNewer) return { kind: 'conflict_remote_newer' };
    return { kind: 'local_outbound_authoritative' };
  }

  if (remoteTombstoned) return { kind: 'remote_delete_wins' };
  if (remoteIsNewer) return { kind: 'remote_wins' };
  return { kind: 'noop' };
}

// ── Media eligibility and cache invalidation (Addendum J) ──────────────────

/** Whether a remote row's media is even worth attempting to hydrate. */
export function isClosetRestoreMediaEligible(
  userId: string,
  remote: Pick<ClosetRestoreRemoteRow, 'id' | 'mediaStatus' | 'storagePath' | 'storageBucket'>,
): boolean {
  if (remote.mediaStatus !== 'ready') return false;
  if (!remote.storageBucket) return false;
  return isValidClosetRestoreMediaPath(userId, remote.id, 'primary', remote.storagePath);
}

/**
 * True when the cache this device already holds is still current, so the
 * engine must not redownload it. Only `media_uploaded_at` can change identity
 * at an otherwise-invariant deterministic path — see the field's doc comment
 * on ClosetSyncEntry.
 */
export function isClosetRestoreMediaCacheCurrent(
  entry: ClosetSyncEntry | null,
  remoteMediaUploadedAt: string | null,
): boolean {
  if (!entry) return false;
  if (entry.mediaState !== 'ready') return false;
  if (!remoteMediaUploadedAt) return false;
  return entry.cachedMediaUploadedAt === remoteMediaUploadedAt;
}

// ── Pagination ordering (section 21) ────────────────────────────────────────

export interface ClosetRestoreCursor {
  updatedAt: string;
  id: string;
}

/** Stable keyset cursor advance: (updated_at, id), both ascending. */
export function nextClosetRestoreCursor(
  rows: Array<Pick<ClosetRestoreRemoteRow, 'id' | 'updatedAt'>>,
): ClosetRestoreCursor | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { updatedAt: last.updatedAt, id: last.id };
}

/** Cursor values are always our own prior query results (server-controlled
 *  UUID + timestamptz), never user input — but a malformed value must still
 *  abort pagination rather than build an unpredictable filter. */
const UUID_SHAPE = /^[0-9a-fA-F-]{1,64}$/;
const TIMESTAMP_SHAPE = /^[0-9TZ:+.\-]{1,40}$/;

export function isWellFormedClosetRestoreCursor(cursor: ClosetRestoreCursor | null): boolean {
  if (!cursor) return true;
  return (
    typeof cursor.id === 'string' &&
    UUID_SHAPE.test(cursor.id) &&
    typeof cursor.updatedAt === 'string' &&
    TIMESTAMP_SHAPE.test(cursor.updatedAt)
  );
}

// ── Anti-churn cooldown (Addendum C) ────────────────────────────────────────

export function isClosetRestoreCooldownElapsed(
  lastAttempt: { actorId: string | null; atMs: number } | null,
  actorId: string | null,
  nowMs: number,
): boolean {
  if (!lastAttempt) return true;
  if (lastAttempt.actorId !== actorId) return true; // account change resets it
  return nowMs - lastAttempt.atMs >= CLOSET_RESTORE_COOLDOWN_MS;
}
