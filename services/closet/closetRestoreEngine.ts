// Build 34 / Track B / Phase B2C — Closet cross-device restore engine.
//
// The orchestrator. Owns remote discovery, the reconciliation loop, the
// entitlement + flag gate, the anti-churn cooldown, single-flight, and the
// stale-completion guards that decide whether an async result may still
// become authoritative local state.
//
// PIPELINE (per pass):
//   flag + K+ gate + cooldown
//     -> paginated remote discovery (facts AND tombstones, keyset ordered)
//     -> per-row pure classification (closetRestoreContract.ts)
//     -> local materialize / update / delete / conflict-record / no-op
//     -> bounded-concurrency private media hydration for eligible rows
//
// THE LOCAL CLOSET NEVER WAITS FOR THIS. Every trigger call is fire-and-forget
// from the caller's perspective (see services/closetSyncCoordinator.ts's
// sibling functions for the same convention on the outbound side); this
// module's own return value exists for tests and any caller that genuinely
// wants to await a pass.
//
// THERE IS NO BACKGROUND SCHEDULER. A pass runs when the Closet gains focus.
// See hooks/useCloset.js.

import { CLOSET_CROSS_DEVICE_RESTORE_V1 } from '../../constants/featureFlags';
import { createActorRequest, isActorRequestCurrent } from '../actorContext';
import { getKPlusEntitlementSnapshot } from '../kplus/kplusEntitlementStore';
import {
  loadCloset,
  materializeRestoredClosetItem,
  applyRestoredClosetItemFacts,
  applyRestoredClosetItemMedia,
  deleteClosetItem,
  CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION,
} from '../closetLibrary';
import { supabase } from '../supabaseClient';
import { emitClosetCandidateEvent } from '../closetTelemetry';
import {
  classifySyncFailure,
  createSyncEntry,
  type ClosetSyncEntry,
  type ClosetSyncFailureClass,
} from './closetSyncContract';
import { getClosetSyncEntry, updateClosetSyncEntry } from './closetSyncStore';
import {
  classifyClosetRestoreAction,
  classifyClosetRestoreSchemaVersion,
  isClosetRestoreMediaCacheCurrent,
  isClosetRestoreMediaEligible,
  isClosetRestoreCooldownElapsed,
  isValidClosetRestoreMediaPath,
  isWellFormedClosetRestoreCursor,
  nextClosetRestoreCursor,
  projectClosetRestoreRowForLocal,
  CLOSET_RESTORE_MEDIA_CONCURRENCY,
  CLOSET_RESTORE_PAGE_SIZE,
  type ClosetRestoreCursor,
  type ClosetRestoreRemoteRow,
} from './closetRestoreContract';
import { deleteClosetRestoreMediaCacheEntry, hydrateClosetRestoreMedia } from './closetRestoreMedia';

const CLOSET_TABLE = 'user_closet_items';
const RESTORE_COLUMNS =
  'id,client_id,row_version,deleted_at,created_at,updated_at,schema_version,title,category,clothing_type,subtype,brand,primary_color,secondary_colors,material,size,notes,origin,storage_bucket,storage_path,thumbnail_storage_path,media_status,media_uploaded_at';

function mapRestoreRow(raw: Record<string, any>): ClosetRestoreRemoteRow {
  return {
    id: raw.id,
    clientId: raw.client_id,
    rowVersion: raw.row_version,
    deletedAt: raw.deleted_at ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    schemaVersion: raw.schema_version,
    title: raw.title,
    category: raw.category ?? null,
    clothingType: raw.clothing_type ?? null,
    subtype: raw.subtype ?? null,
    brand: raw.brand ?? null,
    primaryColor: raw.primary_color ?? null,
    secondaryColors: Array.isArray(raw.secondary_colors) ? raw.secondary_colors : [],
    material: Array.isArray(raw.material) ? raw.material : [],
    size: raw.size ?? null,
    notes: raw.notes ?? null,
    origin: raw.origin,
    storageBucket: raw.storage_bucket ?? null,
    storagePath: raw.storage_path ?? null,
    thumbnailStoragePath: raw.thumbnail_storage_path ?? null,
    mediaStatus: raw.media_status ?? null,
    mediaUploadedAt: raw.media_uploaded_at ?? null,
  };
}

function bucketCount(n: number): string {
  if (n <= 0) return '0';
  if (n >= 9) return '9_plus';
  return String(n);
}

/**
 * One paginated page of remote Closet rows, live AND tombstoned alike.
 *
 * NO `.is('deleted_at', null)` FILTER, deliberately (section 19/Addendum D):
 * the B1A RLS predicate is owner + active-K+ only, so an ordinary authenticated
 * select already returns tombstones. Adding that filter would make deletions
 * on other devices permanently invisible to this one.
 */
async function fetchClosetRestorePage(
  cursor: ClosetRestoreCursor | null,
): Promise<{ ok: boolean; rows: ClosetRestoreRemoteRow[]; failureClass?: ClosetSyncFailureClass }> {
  if (!isWellFormedClosetRestoreCursor(cursor)) {
    return { ok: false, rows: [], failureClass: 'permanent' };
  }
  let query = supabase
    .from(CLOSET_TABLE)
    .select(RESTORE_COLUMNS)
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(CLOSET_RESTORE_PAGE_SIZE);
  if (cursor) {
    // Keyset predicate: (updated_at, id) > (cursor.updatedAt, cursor.id).
    // Values are our own prior server-controlled results (timestamptz + uuid),
    // validated by isWellFormedClosetRestoreCursor above before being spliced
    // into the filter string.
    query = query.or(`updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`);
  }
  const { data, error } = await query;
  if (error) return { ok: false, rows: [], failureClass: classifySyncFailure(error) };
  return { ok: true, rows: (Array.isArray(data) ? data : []).map(mapRestoreRow) };
}

async function currentUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function writeSyncedEntry(userId: string, row: ClosetRestoreRemoteRow): Promise<ClosetSyncEntry | null> {
  return updateClosetSyncEntry(userId, row.clientId, (current) => ({
    ...(current ?? createSyncEntry()),
    state: 'synced',
    serverId: row.id,
    serverRowVersion: row.rowVersion,
    factsAttempted: true,
    syncedLocalUpdatedAt: row.updatedAt,
    attemptCount: 0,
    lastAttemptAt: new Date().toISOString(),
    lastFailureClass: null,
    conflictExpectedRowVersion: null,
    conflictKind: null,
  }));
}

interface MediaCandidate {
  clientId: string;
  serverItemId: string;
  primaryStoragePath: string;
  thumbnailStoragePath: string | null;
  mediaUploadedAt: string | null;
}

function buildMediaCandidate(
  userId: string,
  row: ClosetRestoreRemoteRow,
  entry: ClosetSyncEntry | null,
): MediaCandidate | null {
  if (!isClosetRestoreMediaEligible(userId, row)) {
    if (row.mediaStatus === 'ready') {
      // The server considers this ready, but the path this device derived
      // does not match — fail closed for media only; facts already landed.
      emitClosetCandidateEvent('closet_restore_media_missing', { errorCode: 'invalid_path' });
    }
    return null;
  }
  if (isClosetRestoreMediaCacheCurrent(entry, row.mediaUploadedAt)) return null;
  return {
    clientId: row.clientId,
    serverItemId: row.id,
    primaryStoragePath: row.storagePath as string,
    thumbnailStoragePath: isValidClosetRestoreMediaPath(userId, row.id, 'thumbnail', row.thumbnailStoragePath)
      ? (row.thumbnailStoragePath as string)
      : null,
    mediaUploadedAt: row.mediaUploadedAt,
  };
}

type RowOutcome =
  | 'noop'
  | 'materialized'
  | 'updated'
  | 'deleted'
  | 'conflict'
  | 'quarantined'
  | 'failed'
  | 'skipped';

async function processRestoreRow(input: {
  userId: string;
  row: ClosetRestoreRemoteRow;
  localItemsById: Map<string, Record<string, any>>;
  actorRequest: ReturnType<typeof createActorRequest>;
}): Promise<{ outcome: RowOutcome; mediaCandidate?: MediaCandidate | null }> {
  const { userId, row, localItemsById, actorRequest } = input;

  // Section 39: REMOTE > LOCAL is never guessed at. Quarantined before any
  // local lookup — an unsupported shape has nothing safe to compare against.
  if (classifyClosetRestoreSchemaVersion(row.schemaVersion, CLOSET_ITEM_MAX_SUPPORTED_SCHEMA_VERSION) === 'quarantine') {
    emitClosetCandidateEvent('closet_restore_failed', { errorCode: 'future_schema' });
    return { outcome: 'quarantined' };
  }

  const localItem = localItemsById.get(row.clientId) ?? null;
  const entry = await getClosetSyncEntry(userId, row.clientId);
  const action = classifyClosetRestoreAction({
    remote: row,
    hasLocalItem: !!localItem,
    entry,
    localUpdatedAt: localItem?.updatedAt ?? null,
  });

  // Stale-completion guard (section 27), re-checked immediately before any
  // authoritative local write below.
  if (!isActorRequestCurrent(actorRequest)) return { outcome: 'skipped' };
  if (getKPlusEntitlementSnapshot().state !== 'active') return { outcome: 'skipped' };

  switch (action.kind) {
    case 'skip_no_relationship':
    case 'skip_pending_delete':
    case 'skip_outbound_in_progress':
    case 'skip_goal_already_met':
    case 'local_outbound_authoritative':
    case 'noop':
      return { outcome: 'noop' };

    case 'clear_stale_entry': {
      await updateClosetSyncEntry(userId, row.clientId, () => null);
      await deleteClosetRestoreMediaCacheEntry(userId, row.id).catch(() => undefined);
      return { outcome: 'noop' };
    }

    case 'materialize': {
      const facts = projectClosetRestoreRowForLocal(row);
      const result = await materializeRestoredClosetItem({
        id: row.clientId,
        ownerId: userId,
        facts,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
      if (!result.ok && result.reason !== 'already_exists') {
        emitClosetCandidateEvent('closet_restore_failed', { errorCode: 'materialize_failed' });
        return { outcome: 'failed' };
      }
      const nextEntry = await writeSyncedEntry(userId, row);
      return { outcome: 'materialized', mediaCandidate: buildMediaCandidate(userId, row, nextEntry) };
    }

    case 'remote_wins': {
      const facts = projectClosetRestoreRowForLocal(row);
      const result = await applyRestoredClosetItemFacts(row.clientId, userId, facts, row.updatedAt);
      if (!result.ok) {
        emitClosetCandidateEvent('closet_restore_failed', { errorCode: 'update_failed' });
        return { outcome: 'failed' };
      }
      const nextEntry = await writeSyncedEntry(userId, row);
      return { outcome: 'updated', mediaCandidate: buildMediaCandidate(userId, row, nextEntry) };
    }

    case 'remote_delete_wins': {
      const deleted = await deleteClosetItem(row.clientId, { ownerId: userId });
      // Belt-and-suspenders: deleteClosetItem's own unlink already retires a
      // restored-cache file once it is referenced by imageUri/thumbnailUri,
      // but a prior pass may have downloaded media before ever attaching it.
      await deleteClosetRestoreMediaCacheEntry(userId, row.id).catch(() => undefined);
      if (!deleted) {
        emitClosetCandidateEvent('closet_restore_failed', { errorCode: 'delete_failed' });
        return { outcome: 'failed' };
      }
      await updateClosetSyncEntry(userId, row.clientId, () => null);
      return { outcome: 'deleted' };
    }

    case 'conflict_remote_newer':
    case 'conflict_remote_tombstone': {
      await updateClosetSyncEntry(userId, row.clientId, (current) => {
        const base = current ?? createSyncEntry();
        return {
          ...base,
          state: 'error',
          lastFailureClass: 'conflict',
          conflictExpectedRowVersion: row.rowVersion,
          conflictKind:
            action.kind === 'conflict_remote_newer' ? 'remote_newer_local_dirty' : 'remote_tombstone_local_dirty',
          lastAttemptAt: new Date().toISOString(),
        };
      });
      emitClosetCandidateEvent('closet_restore_conflict', { outcome: 'conflict' });
      return { outcome: 'conflict' };
    }

    default:
      return { outcome: 'noop' };
  }
}

async function hydrateMediaCandidates(
  userId: string,
  candidates: MediaCandidate[],
  actorRequest: ReturnType<typeof createActorRequest>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const my = candidates[cursor];
      cursor += 1;
      if (!my) return;
      if (!isActorRequestCurrent(actorRequest)) return;
      if (getKPlusEntitlementSnapshot().state !== 'active') return; // section 38

      const result = await hydrateClosetRestoreMedia({
        ownerId: userId,
        serverItemId: my.serverItemId,
        primaryStoragePath: my.primaryStoragePath,
        thumbnailStoragePath: my.thumbnailStoragePath,
      });
      if (!result.ok) {
        emitClosetCandidateEvent('closet_restore_media_missing', { errorCode: result.detail ?? 'download_failed' });
        continue;
      }

      // Re-check right before the authoritative local write (section 27):
      // the item may have been deleted or superseded while the download ran.
      if (!isActorRequestCurrent(actorRequest)) return;
      const liveEntry = await getClosetSyncEntry(userId, my.clientId);
      if (!liveEntry || liveEntry.state === 'pending_delete') continue;

      const attached = await applyRestoredClosetItemMedia(my.clientId, userId, {
        imageUri: result.primaryUri,
        thumbnailUri: result.thumbnailUri,
      });
      // Only record the cache as current when the local write actually landed.
      // Otherwise (e.g. a narrow race where the item vanished between the
      // liveEntry check above and this write) the sidecar would claim
      // cachedMediaUploadedAt matches the server while the local item never
      // received an imageUri — isClosetRestoreMediaCacheCurrent would then
      // skip re-downloading forever, permanently stranding this item without
      // a picture. Leaving the entry's cache fields untouched lets the very
      // next pass see the mismatch and retry.
      if (!attached.ok) {
        emitClosetCandidateEvent('closet_restore_media_missing', { errorCode: 'local_attach_failed' });
        continue;
      }
      await updateClosetSyncEntry(userId, my.clientId, (current) =>
        current ? { ...current, mediaState: 'ready', cachedMediaUploadedAt: my.mediaUploadedAt } : current,
      );
    }
  }

  const workerCount = Math.max(1, Math.min(CLOSET_RESTORE_MEDIA_CONCURRENCY, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

export interface ClosetRestorePassResult {
  ran: boolean;
  skippedReason?: 'flag_disabled' | 'not_kplus' | 'signed_out' | 'already_running' | 'cooldown';
  pages: number;
  discovered: number;
  materialized: number;
  updated: number;
  deleted: number;
  conflicts: number;
  failed: number;
}

function emptyRestoreResult(skippedReason: ClosetRestorePassResult['skippedReason']): ClosetRestorePassResult {
  return {
    ran: false,
    skippedReason,
    pages: 0,
    discovered: 0,
    materialized: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    failed: 0,
  };
}

/** Single-flight, like closetSyncEngine.ts's outbound pass. */
let inFlightRestorePass: Promise<ClosetRestorePassResult> | null = null;

/** In-memory only (Addendum C). Resets on account change (different actorId)
 *  and on app restart, by construction — never persisted. */
let lastRestoreAttempt: { actorId: string | null; atMs: number } | null = null;

export async function runClosetRestorePass(
  options: { reason?: string; nowMs?: number; bypassCooldown?: boolean } = {},
): Promise<ClosetRestorePassResult> {
  if (inFlightRestorePass) {
    await inFlightRestorePass.catch(() => null);
    return emptyRestoreResult('already_running');
  }
  const pass = executeRestorePass(options).catch(
    (): ClosetRestorePassResult => ({
      ran: true,
      pages: 0,
      discovered: 0,
      materialized: 0,
      updated: 0,
      deleted: 0,
      conflicts: 0,
      failed: 0,
    }),
  );
  inFlightRestorePass = pass;
  try {
    return await pass;
  } finally {
    inFlightRestorePass = null;
  }
}

async function executeRestorePass(options: {
  reason?: string;
  nowMs?: number;
  bypassCooldown?: boolean;
}): Promise<ClosetRestorePassResult> {
  if (!CLOSET_CROSS_DEVICE_RESTORE_V1) return emptyRestoreResult('flag_disabled');
  // Evaluated HERE, fresh, every attempt — the same "no special case for
  // reactivation" pattern closetSyncEngine.ts#isClosetCloudSyncEligible uses.
  if (getKPlusEntitlementSnapshot().state !== 'active') return emptyRestoreResult('not_kplus');

  const userId = await currentUserId();
  if (!userId) return emptyRestoreResult('signed_out');

  const actorRequest = createActorRequest();
  if (!isActorRequestCurrent(actorRequest)) return emptyRestoreResult('signed_out');

  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  if (!options.bypassCooldown && !isClosetRestoreCooldownElapsed(lastRestoreAttempt, userId, nowMs)) {
    return emptyRestoreResult('cooldown');
  }
  lastRestoreAttempt = { actorId: userId, atMs: nowMs };

  emitClosetCandidateEvent('closet_restore_started', {});

  const localItems = (await loadCloset(userId).catch(() => [])) as Array<Record<string, any>>;
  const localItemsById = new Map<string, Record<string, any>>();
  for (const item of localItems) {
    if (item && typeof item.id === 'string') localItemsById.set(item.id, item);
  }

  const result: ClosetRestorePassResult = {
    ran: true,
    pages: 0,
    discovered: 0,
    materialized: 0,
    updated: 0,
    deleted: 0,
    conflicts: 0,
    failed: 0,
  };
  const mediaCandidates: MediaCandidate[] = [];
  let cursor: ClosetRestoreCursor | null = null;

  for (;;) {
    // Section 38: stop BEGINNING new restore work once K+ lapses or the actor
    // changes mid-pass. Already-hydrated local state is never rolled back.
    if (!isActorRequestCurrent(actorRequest)) break;
    if (getKPlusEntitlementSnapshot().state !== 'active') break;

    const page = await fetchClosetRestorePage(cursor);
    if (!page.ok) {
      result.failed += 1;
      emitClosetCandidateEvent('closet_restore_failed', { errorCode: page.failureClass ?? 'unknown' });
      break;
    }
    result.pages += 1;
    result.discovered += page.rows.length;
    emitClosetCandidateEvent('closet_restore_page', { countBucket: bucketCount(page.rows.length) });

    for (const row of page.rows) {
      if (!isActorRequestCurrent(actorRequest)) break;
      const outcome = await processRestoreRow({ userId, row, localItemsById, actorRequest });
      if (outcome.outcome === 'materialized') result.materialized += 1;
      else if (outcome.outcome === 'updated') result.updated += 1;
      else if (outcome.outcome === 'deleted') result.deleted += 1;
      else if (outcome.outcome === 'conflict') result.conflicts += 1;
      else if (outcome.outcome === 'failed' || outcome.outcome === 'quarantined') result.failed += 1;
      if (outcome.mediaCandidate) mediaCandidates.push(outcome.mediaCandidate);
    }

    if (page.rows.length < CLOSET_RESTORE_PAGE_SIZE) break; // last page
    const next = nextClosetRestoreCursor(page.rows);
    if (!next) break;
    cursor = next;
  }

  if (mediaCandidates.length > 0 && isActorRequestCurrent(actorRequest)) {
    await hydrateMediaCandidates(userId, mediaCandidates, actorRequest);
  }

  emitClosetCandidateEvent('closet_restore_completed', { countBucket: bucketCount(result.discovered) });
  return result;
}

/**
 * Opportunistic trigger for Closet-open (and, by the same mechanism B2B
 * relies on, app foreground while the Closet screen is active). Safe to call
 * as often as a caller likes: single-flight plus the cooldown collapse
 * overlapping/rapid triggers into at most one real pass.
 */
export async function resumeClosetRestore(reason: string): Promise<void> {
  try {
    await runClosetRestorePass({ reason });
  } catch {
    /* cloud restore never affects the local Closet's own outcome */
  }
}

/** Test seam only. */
export const __closetRestoreEngineInternals = {
  resetInFlight: () => {
    inFlightRestorePass = null;
  },
  resetCooldown: () => {
    lastRestoreAttempt = null;
  },
};
