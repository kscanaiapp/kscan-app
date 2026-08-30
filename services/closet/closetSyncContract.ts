// Build 34 / Track B / Phase B2B — Closet cloud sync contract.
//
// PURE MODULE. No react-native, no expo, no Supabase, no filesystem. Every
// decision the sync engine makes that can be expressed as a function of data
// lives here so it is testable without a device, a network, or a bundler.
//
// THE GOVERNING RULE OF B2B:
//   The LOCAL Closet is the immediate user experience. Cloud sync is an
//   enhancement, never a prerequisite. Nothing in this file may make a local
//   Closet operation fail, wait, or become conditional on cloud state.
//
// This is OUTBOUND ONLY. B2B pushes local truth to the cloud. It never
// materializes a remote item locally, never downloads media, and never
// reconciles a remote deletion — those are B2C.

import type { ClosetMediaBlockedReason } from '../closetMediaPrivacy';

/** Sidecar schema version. Bumped only for a breaking durable-shape change. */
export const CLOSET_SYNC_STATE_SCHEMA_VERSION = 1;

/**
 * Durable, externally meaningful sync states.
 *
 * `local_only` is DERIVED, never stored: an item with no sidecar entry is
 * local-only by definition. That is what keeps B2B out of B3's territory —
 * a pre-existing local item acquires an entry only when the user edits it or
 * explicitly retries it, never from a bulk scan (see needsSyncWork).
 */
export type ClosetSyncState =
  | 'local_only'
  | 'pending'
  | 'synced'
  | 'blocked'
  | 'error'
  | 'pending_delete';

/** Cloud media backing state. Mirrors B1C's media_status plus a local-only
 *  `blocked` for "B2A refused this image", which the cloud never sees. */
export type ClosetSyncMediaState = 'none' | 'pending' | 'ready' | 'blocked';

/** Why an attempt failed, and therefore whether it may be retried. */
export type ClosetSyncFailureClass =
  /** Network/server/transient. Retry with backoff. */
  | 'retryable'
  /** Deterministic refusal (privacy block, contract violation). Never auto-retries. */
  | 'permanent'
  /** Server row moved on under us. Local wins; wait for B2C. */
  | 'conflict';

/**
 * One item's durable sync record. Account-bound by its position in the
 * sidecar (entries are keyed by ownerId first), never by a field inside it.
 */
export interface ClosetSyncEntry {
  state: Exclude<ClosetSyncState, 'local_only'>;
  /** Authoritative server id (user_closet_items.id). Null until facts land. */
  serverId: string | null;
  /** Last server row_version this client observed. Drives stale-write detection. */
  serverRowVersion: number | null;
  /**
   * CRASH-RECOVERY MARKER. Written BEFORE the first facts INSERT and never
   * cleared. Its whole purpose is the window in section 17: facts upsert
   * succeeded, the app died before serverId could be persisted. On restart
   * `factsAttempted && !serverId` is the signal to recover the existing row by
   * client_id instead of creating a second one.
   */
  factsAttempted: boolean;
  /** The local item's updatedAt at the moment facts last synced successfully. */
  syncedLocalUpdatedAt: string | null;
  mediaState: ClosetSyncMediaState;
  /** Set only when mediaState === 'blocked'. B2A's closed vocabulary. */
  blockedReason: ClosetMediaBlockedReason | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastFailureClass: ClosetSyncFailureClass | null;
  /** Conflict evidence handed to B2C. Never used to merge here. */
  conflictExpectedRowVersion: number | null;
}

export function createSyncEntry(overrides: Partial<ClosetSyncEntry> = {}): ClosetSyncEntry {
  return {
    state: 'pending',
    serverId: null,
    serverRowVersion: null,
    factsAttempted: false,
    syncedLocalUpdatedAt: null,
    mediaState: 'none',
    blockedReason: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastFailureClass: null,
    conflictExpectedRowVersion: null,
    ...overrides,
  };
}

// ── Retry policy ────────────────────────────────────────────────────────────
//
// Deliberately the SAME convention services/closetCandidateClassification.js
// already uses for Closet candidate retries: exponential growth from a 2s base
// to a 60s ceiling with bounded +/-25% jitter, eligibility computed from
// lastAttemptAt rather than scheduled by a timer. __tests__ asserts numerical
// parity with that function so the two can never silently diverge.
//
// NO ATTEMPT CAP. A cap would permanently strand an item whose failure was a
// week of bad connectivity, and the 60s ceiling plus "only runs when the app is
// foregrounded and something triggers a pass" already bounds the request rate
// far below a retry storm. Permanent failures do not reach the backoff path at
// all — they are classified `permanent` and stop retrying outright.

export const CLOSET_SYNC_RETRY_BASE_DELAY_MS = 2_000;
export const CLOSET_SYNC_RETRY_MAX_DELAY_MS = 60_000;

export function closetSyncBackoffMs(attemptCount: number, random: () => number = Math.random): number {
  const attempt = Math.max(0, Math.floor(attemptCount ?? 0));
  const base = Math.min(CLOSET_SYNC_RETRY_BASE_DELAY_MS * 2 ** attempt, CLOSET_SYNC_RETRY_MAX_DELAY_MS);
  const jitter = base * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * True when an entry's backoff has elapsed.
 *
 * A never-attempted entry runs immediately; every RE-attempt waits. The delay
 * is derived from the attempt count, so it grows per failure.
 */
export function isSyncRetryEligible(
  entry: ClosetSyncEntry,
  nowMs: number,
  random: () => number = Math.random,
): boolean {
  if (!entry) return false;
  if ((entry.attemptCount ?? 0) <= 0) return true;
  const last = Date.parse(entry.lastAttemptAt ?? '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= closetSyncBackoffMs(entry.attemptCount - 1, random);
}

/**
 * Does this item need outbound work right now?
 *
 * THE B2B/B3 BOUNDARY LIVES HERE. An item with no sidecar entry returns false:
 * B2B never systematically uploads pre-existing local items. An entry exists
 * only because the user created/edited/deleted the item while cloud sync was
 * available, or explicitly retried it — that is opportunistic sync, not bulk
 * migration.
 */
export function needsSyncWork(
  entry: ClosetSyncEntry | null | undefined,
  localUpdatedAt: string | null,
  nowMs: number,
  random: () => number = Math.random,
): boolean {
  if (!entry) return false;
  if (entry.state === 'pending_delete') return isSyncRetryEligible(entry, nowMs, random);
  // A deterministic block is not work: retrying it would just re-block.
  if (entry.state === 'blocked') return false;
  if (entry.lastFailureClass === 'permanent') return false;
  // A conflict waits for B2C, not for a retry that would overwrite the server.
  if (entry.lastFailureClass === 'conflict') return false;
  if (entry.state === 'pending' || entry.state === 'error') {
    return isSyncRetryEligible(entry, nowMs, random);
  }
  if (entry.state === 'synced') {
    // Facts drifted since the last successful push?
    if (localUpdatedAt && entry.syncedLocalUpdatedAt !== localUpdatedAt) {
      return isSyncRetryEligible(entry, nowMs, random);
    }
    // Facts are current but media never finished.
    if (entry.mediaState === 'pending') return isSyncRetryEligible(entry, nowMs, random);
  }
  return false;
}

// ── Failure classification ──────────────────────────────────────────────────

/**
 * Map a PostgREST/Storage failure to a retry class.
 *
 * Fails toward `retryable` for anything unrecognized: wrongly retrying a
 * permanent failure costs one bounded, backed-off request, while wrongly
 * classifying a transient network blip as permanent strands the item forever.
 */
export function classifySyncFailure(error: { code?: string; message?: string; status?: number } | null): ClosetSyncFailureClass {
  if (!error) return 'retryable';
  const code = String(error.code ?? '');
  const status = Number(error.status ?? NaN);
  const message = String(error.message ?? '').toLowerCase();

  // RLS refusal. On this table that means "not owned, or K+ is not active" —
  // both resolve on their own (re-subscribe, re-auth), so this waits rather
  // than permanently failing.
  if (code === '42501' || status === 401 || status === 403) return 'retryable';
  // Contract violation: a CHECK/length/enum the client would produce again.
  if (code.startsWith('23') && code !== '23505') return 'permanent';
  if (status === 400 || status === 422) return 'permanent';
  if (message.includes('violates check constraint')) return 'permanent';
  return 'retryable';
}

/** Unique-violation on (user_id, client_id) — the signal to recover the row. */
export function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (String(error.code ?? '') === '23505') return true;
  return String(error.message ?? '').toLowerCase().includes('duplicate key value');
}

// ── Local → cloud field mapping ─────────────────────────────────────────────

/**
 * Project a local Closet record onto B1A's column set.
 *
 * ONLY the taxonomy/facts columns. Never id, user_id, row_version, created_at,
 * updated_at or any media column: those are server-controlled (B1A's insert/
 * update authority triggers re-stamp them regardless of what a client sends),
 * and media columns are owned by the media saga, not the facts write.
 */
export function projectClosetItemForCloud(item: Record<string, any>): Record<string, any> {
  const arrayOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v).slice(0, 8) : [];
  return {
    title: typeof item.title === 'string' && item.title ? item.title : 'Closet item',
    category: item.category ?? null,
    clothing_type: item.clothingType ?? null,
    subtype: item.subtype ?? null,
    brand: item.brand ?? null,
    primary_color: item.primaryColor ?? null,
    secondary_colors: arrayOf(item.secondaryColors),
    material: arrayOf(item.material),
    size: item.size ?? null,
    notes: item.notes ?? null,
    origin: item.origin === 'recent_scan' ? 'recent_scan' : 'direct_intake',
    schema_version: Number.isFinite(item.schemaVersion) ? item.schemaVersion : 2,
  };
}

// ── Deterministic Storage identity ──────────────────────────────────────────
//
// Must match B1C's CHECK constraints byte for byte:
//   storage_path           = user_id || '/closet/' || id || '-primary.jpg'
//   thumbnail_storage_path = user_id || '/closet/' || id || '-thumb.jpg'
// A mismatch is rejected by Postgres before RLS is even consulted, so these
// are the single source of the path in the client too. FLAT, one level under
// {userId}/closet — a nested layout would make the account-deletion
// enumerator orphan the objects (see the B1C migration comment).

export const CLOSET_MEDIA_BUCKET = 'style-library-images';

export function buildClosetPrimaryPath(userId: string, serverItemId: string): string {
  return `${userId}/closet/${serverItemId}-primary.jpg`;
}

export function buildClosetThumbnailPath(userId: string, serverItemId: string): string {
  return `${userId}/closet/${serverItemId}-thumb.jpg`;
}
