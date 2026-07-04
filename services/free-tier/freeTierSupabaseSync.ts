/**
 * Free Tier Utility Expansion — optional Supabase sync service.
 *
 * Provides optional backend sync functions for the free-tier utility layer.
 * The service is fully gated by feature flags and is safe to import anywhere:
 * - returns early/no-op when backend sync is disabled
 * - returns a safe unauthenticated status when no user session exists
 * - never throws to callers
 * - never runs on app startup
 * - never performs background polling
 * - never uses service-role keys
 * - never uploads raw images
 *
 * Pull and push snapshots are implemented behind the backend sync flags.
 * Network calls only run when flags are enabled and an authenticated session
 * exists; otherwise the functions return safe skipped results.
 */

import { supabase } from '../supabaseClient';
import {
  FREE_TIER_BACKEND_SYNC_ENABLED,
  FREE_TIER_BACKEND_READ_ENABLED,
  FREE_TIER_BACKEND_WRITE_ENABLED,
  FREE_TIER_BACKEND_QUEUE_ENABLED,
} from '../../constants/freeTierBackendFlags';
import {
  getFreeTierPendingWriteCount,
  getPendingFreeTierWrites,
  clearFreeTierWrite,
  markFreeTierWriteRetry,
} from './freeTierSyncQueue';
import type {
  FreeTierSyncEntityName,
  FreeTierSyncOperation,
  FreeTierSyncResult,
  FreeTierSyncStatus,
  FreeTierSyncError,
  FreeTierSyncDirection,
} from './freeTierSyncTypes';
import { FREE_TIER_STORAGE_KEYS } from './wardrobeUtilityTypes';
import type {
  CareNoteEntry,
  BrandSizingEntry,
  OutfitFeedbackEntry,
  WishlistIntentEntry,
  OutfitCollection,
  WearTrackingEntry,
  ActivityEvent,
  ActivityEventType,
  WishlistIntentKind,
} from './wardrobeUtilityTypes';
import { writeStore } from './freeTierStorage';
import { loadCareNotes } from './careNotes';
import { loadBrandSizing, normalizeBrandKey } from './brandSizingMemory';
import { loadOutfitFeedback } from './outfitFeedback';
import { loadWishlistIntent } from './wishlistIntent';
import { loadCollections } from './outfitCollections';
import { loadWearTracking } from './costPerWear';
import { loadActivityLog } from './activityLog';
import {
  mapCareNoteEntryToRemote,
  mapBrandSizingEntryToRemote,
  mapOutfitFeedbackEntryToRemote,
  mapWishlistIntentEntryToRemote,
  mapWearTrackingEntryToRemoteWearEvent,
  mapActivityEventToRemote,
  mapOutfitCollectionToRemote,
} from './freeTierBackendMapper';

const ENTITY_TABLE_MAP: Record<FreeTierSyncEntityName, string> = {
  utility_item: 'wardrobe_utility_items',
  brand_sizing_note: 'wardrobe_brand_sizing_notes',
  outfit_feedback: 'wardrobe_outfit_feedback',
  care_note: 'wardrobe_care_notes',
  wishlist_intent: 'wardrobe_wishlist_intents',
  collection: 'wardrobe_collections',
  collection_item: 'wardrobe_collection_items',
  wear_event: 'wardrobe_wear_events',
  activity_log: 'wardrobe_activity_log',
};

async function getCurrentUserId(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return null;
    return data.session.user?.id ?? null;
  } catch {
    return null;
  }
}

function makeError(code: string, message: string, entity?: FreeTierSyncEntityName): FreeTierSyncError {
  return { code, message, entity };
}

function makeResult(
  success: boolean,
  entity: FreeTierSyncEntityName,
  operation: FreeTierSyncOperation,
  direction: FreeTierSyncDirection,
  recordsAffected = 0,
  error?: FreeTierSyncError
): FreeTierSyncResult {
  return { success, entity, operation, direction, recordsAffected, error };
}

/** Returns the current sync status without performing network calls. */
export async function getFreeTierSyncStatus(): Promise<FreeTierSyncStatus> {
  try {
    const userId = await getCurrentUserId();
    const pendingWrites = FREE_TIER_BACKEND_QUEUE_ENABLED
      ? await getFreeTierPendingWriteCount()
      : 0;

    return {
      enabled: FREE_TIER_BACKEND_SYNC_ENABLED,
      authenticated: !!userId,
      readEnabled: FREE_TIER_BACKEND_READ_ENABLED,
      writeEnabled: FREE_TIER_BACKEND_WRITE_ENABLED,
      queueEnabled: FREE_TIER_BACKEND_QUEUE_ENABLED,
      pendingWrites,
    };
  } catch {
    return {
      enabled: false,
      authenticated: false,
      readEnabled: false,
      writeEnabled: false,
      queueEnabled: false,
      pendingWrites: 0,
      lastError: 'getFreeTierSyncStatus failed',
    };
  }
}

/**
 * Sync a single entity operation. Returns a safe result when flags are disabled
 * or the user is unauthenticated. Real network calls are only made when both
 * the master sync flag and the read/write direction flag are enabled.
 */
export async function syncFreeTierEntity(
  entity: FreeTierSyncEntityName,
  operation: FreeTierSyncOperation,
  payload: unknown
): Promise<FreeTierSyncResult> {
  if (!FREE_TIER_BACKEND_SYNC_ENABLED) {
    return makeResult(true, entity, operation, operation === 'delete' ? 'push' : 'push', 0);
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return makeResult(
      false,
      entity,
      operation,
      'push',
      0,
      makeError('UNAUTHENTICATED', 'No authenticated user; sync skipped.', entity)
    );
  }

  const direction: FreeTierSyncDirection = 'push';

  if (operation === 'upsert' && !FREE_TIER_BACKEND_WRITE_ENABLED) {
    return makeResult(
      false,
      entity,
      operation,
      direction,
      0,
      makeError('WRITE_DISABLED', 'Backend write flag is disabled.', entity)
    );
  }

  if (operation === 'delete' && !FREE_TIER_BACKEND_WRITE_ENABLED) {
    return makeResult(
      false,
      entity,
      operation,
      direction,
      0,
      makeError('WRITE_DISABLED', 'Backend write flag is disabled.', entity)
    );
  }

  const tableName = ENTITY_TABLE_MAP[entity];
  if (!tableName) {
    return makeResult(
      false,
      entity,
      operation,
      direction,
      0,
      makeError('UNKNOWN_ENTITY', `No table mapping for entity ${entity}.`, entity)
    );
  }

  try {
    const record = typeof payload === 'object' && payload !== null
      ? { ...(payload as Record<string, unknown>), user_id: userId }
      : { user_id: userId };

    if (operation === 'delete') {
      // Soft delete path: requires a client_id or source_item_id to target.
      const clientId = (record as Record<string, unknown>).client_id as string | undefined;
      const sourceItemId = (record as Record<string, unknown>).source_item_id as string | undefined;

      if (!clientId && !sourceItemId) {
        return makeResult(
          false,
          entity,
          operation,
          direction,
          0,
          makeError('MISSING_TARGET', 'Delete requires client_id or source_item_id.', entity)
        );
      }

      const query = supabase.from(tableName).update({ deleted_at: new Date().toISOString() });
      let scoped = query.eq('user_id', userId);
      if (clientId) scoped = scoped.eq('client_id', clientId);
      else if (sourceItemId) scoped = scoped.eq('source_item_id', sourceItemId);

      const { error } = await scoped;
      if (error) throw error;
      return makeResult(true, entity, operation, direction, 1);
    }

    // Upsert path. We use client_id + user_id as the conflict identity so
    // repeated local writes converge to the same remote row.
    const conflictKeys = ['user_id', 'client_id'];
    const { error } = await supabase.from(tableName).upsert(record, {
      onConflict: conflictKeys.join(','),
    });

    if (error) throw error;
    return makeResult(true, entity, operation, direction, 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult(
      false,
      entity,
      operation,
      direction,
      0,
      makeError('SYNC_FAILED', message, entity)
    );
  }
}

/**
 * Drain the local pending-write queue. Each item is attempted once.
 * Failed items are marked with retry count and lastError; they are not
 * removed so a future sync attempt can retry (up to caller policy).
 */
export async function syncPendingFreeTierWrites(): Promise<FreeTierSyncResult[]> {
  if (!FREE_TIER_BACKEND_SYNC_ENABLED || !FREE_TIER_BACKEND_WRITE_ENABLED) {
    return [];
  }

  const pending = await getPendingFreeTierWrites();
  const results: FreeTierSyncResult[] = [];

  for (const write of pending) {
    const result = await syncFreeTierEntity(write.entity, write.operation, write.payload);
    results.push(result);

    if (result.success) {
      await clearFreeTierWrite(write.id);
    } else {
      await markFreeTierWriteRetry(write.id, result.error?.message);
    }
  }

  return results;
}

// ── Conflict helpers ─────────────────────────────────────────────────────────

/** Parse an ISO/timestamptz string to epoch ms; NaN-safe (0 when unparseable). */
function toEpoch(value?: string | null): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

/** Remote row wins only when strictly newer than the local record. */
function remoteIsNewer(remoteUpdatedAt?: string | null, localUpdatedAt?: string | null): boolean {
  return toEpoch(remoteUpdatedAt) > toEpoch(localUpdatedAt);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Fetch the caller's non-deleted rows for a table. RLS also scopes by user. */
async function fetchRemoteRows(
  table: string,
  userId: string
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('user_id', userId)
    .is('deleted_at', null);
  if (error) throw error;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

interface PullCounts {
  careNotes: number;
  brandSizing: number;
  outfitFeedback: number;
  wishlistIntent: number;
  wearTracking: number;
  activityLog: number;
  collections: number;
}

/**
 * Pull a remote utility snapshot for the authenticated user and merge it into
 * the local stores. Local-first and non-destructive:
 * - returns a safe skipped result when flags are off or unauthenticated
 * - only overwrites a local record when the remote copy is strictly newer
 * - never deletes local-only records (remote is additive/refreshing only)
 * - each entity merge is isolated; one failing table never aborts the others
 *   and never leaves local data in a partial state
 */
export async function pullFreeTierUtilitySnapshot(): Promise<{
  success: boolean;
  skipped?: boolean;
  counts?: PullCounts;
  error?: FreeTierSyncError;
}> {
  if (!FREE_TIER_BACKEND_SYNC_ENABLED) {
    return { success: true, skipped: true };
  }
  if (!FREE_TIER_BACKEND_READ_ENABLED) {
    return { success: true, skipped: true, error: makeError('READ_DISABLED', 'Backend read flag is disabled.') };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: true, skipped: true, error: makeError('UNAUTHENTICATED', 'No authenticated user; pull skipped.') };
  }

  const counts: PullCounts = {
    careNotes: 0,
    brandSizing: 0,
    outfitFeedback: 0,
    wishlistIntent: 0,
    wearTracking: 0,
    activityLog: 0,
    collections: 0,
  };
  let anyError: FreeTierSyncError | undefined;

  // Care notes: Record<itemId, CareNoteEntry> keyed by source_item_id.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.care_note, userId);
    const local = await loadCareNotes();
    const next = { ...local };
    for (const row of rows) {
      const itemId = asString(row.source_item_id);
      const updatedAt = asString(row.updated_at);
      if (!itemId) continue;
      if (remoteIsNewer(updatedAt, next[itemId]?.updatedAt)) {
        next[itemId] = {
          itemId,
          tags: asStringArray(row.tags),
          note: asString(row.note),
          updatedAt: updatedAt ?? new Date().toISOString(),
        } as CareNoteEntry;
        counts.careNotes++;
      }
    }
    if (counts.careNotes > 0) await writeStore(FREE_TIER_STORAGE_KEYS.careNotes, next, userId);
  } catch (err) {
    anyError = makeError('PULL_CARE_FAILED', err instanceof Error ? err.message : String(err), 'care_note');
  }

  // Brand sizing: Record<normalizedBrandKey, BrandSizingEntry>.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.brand_sizing_note, userId);
    const local = await loadBrandSizing();
    const next = { ...local };
    for (const row of rows) {
      const brand = asString(row.brand);
      const key = normalizeBrandKey(brand);
      const updatedAt = asString(row.updated_at);
      if (!key || !brand) continue;
      if (remoteIsNewer(updatedAt, next[key]?.lastUpdatedAt)) {
        next[key] = {
          brand,
          usualSize: asString(row.usual_size),
          fitNote: asString(row.fit_note),
          runsSmall: typeof row.runs_small === 'boolean' ? row.runs_small : undefined,
          runsLarge: typeof row.runs_large === 'boolean' ? row.runs_large : undefined,
          lastUpdatedAt: updatedAt ?? new Date().toISOString(),
        } as BrandSizingEntry;
        counts.brandSizing++;
      }
    }
    if (counts.brandSizing > 0) await writeStore(FREE_TIER_STORAGE_KEYS.brandSizing, next, userId);
  } catch (err) {
    anyError = makeError('PULL_SIZING_FAILED', err instanceof Error ? err.message : String(err), 'brand_sizing_note');
  }

  // Outfit feedback: Record<targetId, OutfitFeedbackEntry>.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.outfit_feedback, userId);
    const local = await loadOutfitFeedback();
    const next = { ...local };
    for (const row of rows) {
      const targetId = asString(row.target_id);
      const updatedAt = asString(row.updated_at);
      if (!targetId) continue;
      if (remoteIsNewer(updatedAt, next[targetId]?.updatedAt)) {
        next[targetId] = {
          targetId,
          rating: asNumber(row.rating),
          tags: asStringArray(row.tags),
          updatedAt: updatedAt ?? new Date().toISOString(),
        } as OutfitFeedbackEntry;
        counts.outfitFeedback++;
      }
    }
    if (counts.outfitFeedback > 0) await writeStore(FREE_TIER_STORAGE_KEYS.outfitFeedback, next, userId);
  } catch (err) {
    anyError = makeError('PULL_FEEDBACK_FAILED', err instanceof Error ? err.message : String(err), 'outfit_feedback');
  }

  // Wishlist intent: Record<itemId, WishlistIntentEntry> keyed by source_item_id.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.wishlist_intent, userId);
    const local = await loadWishlistIntent();
    const next = { ...local };
    for (const row of rows) {
      const itemId = asString(row.source_item_id);
      const intent = asString(row.intent) as WishlistIntentKind | undefined;
      const updatedAt = asString(row.updated_at);
      if (!itemId || !intent) continue;
      if (remoteIsNewer(updatedAt, next[itemId]?.updatedAt)) {
        next[itemId] = {
          itemId,
          intent,
          titleSnapshot: asString(row.title_snapshot),
          updatedAt: updatedAt ?? new Date().toISOString(),
        } as WishlistIntentEntry;
        counts.wishlistIntent++;
      }
    }
    if (counts.wishlistIntent > 0) await writeStore(FREE_TIER_STORAGE_KEYS.wishlistIntent, next, userId);
  } catch (err) {
    anyError = makeError('PULL_WISHLIST_FAILED', err instanceof Error ? err.message : String(err), 'wishlist_intent');
  }

  // Wear tracking: Record<itemId, WearTrackingEntry>. Remote holds one
  // aggregate row per item (pushed via upsert); rebuild from metadata.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.wear_event, userId);
    const local = await loadWearTracking();
    const next = { ...local };
    for (const row of rows) {
      const itemId = asString(row.source_item_id);
      if (!itemId) continue;
      const meta = asRecord(row.metadata);
      const localUpdatedAt = asString(meta.localUpdatedAt) ?? asString(row.updated_at);
      if (remoteIsNewer(localUpdatedAt, next[itemId]?.updatedAt)) {
        next[itemId] = {
          itemId,
          wearCount: asNumber(meta.localWearCount) ?? next[itemId]?.wearCount ?? 0,
          lastWornAt: asString(row.worn_at) ?? next[itemId]?.lastWornAt,
          estimatedPrice: asNumber(row.estimated_price) ?? next[itemId]?.estimatedPrice,
          updatedAt: localUpdatedAt ?? new Date().toISOString(),
        } as WearTrackingEntry;
        counts.wearTracking++;
      }
    }
    if (counts.wearTracking > 0) await writeStore(FREE_TIER_STORAGE_KEYS.wearTracking, next, userId);
  } catch (err) {
    anyError = makeError('PULL_WEAR_FAILED', err instanceof Error ? err.message : String(err), 'wear_event');
  }

  // Activity log: ActivityEvent[] merged by client-stable id; additive only,
  // capped to the newest 50, newest first.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.activity_log, userId);
    const local = await loadActivityLog();
    const seen = new Set(local.map((e) => e.id));
    const incoming: ActivityEvent[] = [];
    for (const row of rows) {
      const clientId = asString(row.client_id);
      const id = clientId?.startsWith('activity:') ? clientId.slice('activity:'.length) : asString(row.id);
      if (!id || seen.has(id)) continue;
      const meta = asRecord(row.metadata);
      incoming.push({
        id,
        type: (asString(row.event_type) ?? 'saved_item') as ActivityEventType,
        label: asString(row.label) ?? '',
        createdAt: asString(meta.localCreatedAt) ?? asString(row.created_at) ?? new Date().toISOString(),
      });
      seen.add(id);
    }
    if (incoming.length > 0) {
      const merged = [...local, ...incoming]
        .sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt))
        .slice(0, 50);
      counts.activityLog = incoming.length;
      await writeStore(FREE_TIER_STORAGE_KEYS.activityLog, merged, userId);
    }
  } catch (err) {
    anyError = makeError('PULL_ACTIVITY_FAILED', err instanceof Error ? err.message : String(err), 'activity_log');
  }

  // Collections: OutfitCollection[]. Metadata-only merge (name/cover). Nested
  // item membership is NOT synced yet (see push note), so local itemIds are
  // always preserved and never overwritten from remote.
  try {
    const rows = await fetchRemoteRows(ENTITY_TABLE_MAP.collection, userId);
    const local = await loadCollections();
    const byId = new Map(local.map((c) => [c.id, c]));
    let changed = false;
    for (const row of rows) {
      const clientId = asString(row.client_id);
      const id = clientId?.startsWith('collection:') ? clientId.slice('collection:'.length) : asString(row.id);
      const name = asString(row.name);
      const updatedAt = asString(row.updated_at);
      if (!id || !name) continue;
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, {
          id,
          name,
          itemIds: [],
          coverItemId: asString(row.cover_item_id),
          createdAt: updatedAt ?? new Date().toISOString(),
          updatedAt: updatedAt ?? new Date().toISOString(),
        });
        changed = true;
        counts.collections++;
      } else if (remoteIsNewer(updatedAt, existing.updatedAt)) {
        byId.set(id, {
          ...existing, // preserve local itemIds
          name,
          coverItemId: asString(row.cover_item_id) ?? existing.coverItemId,
          updatedAt: updatedAt ?? existing.updatedAt,
        });
        changed = true;
        counts.collections++;
      }
    }
    if (changed) await writeStore(FREE_TIER_STORAGE_KEYS.collections, Array.from(byId.values()), userId);
  } catch (err) {
    anyError = makeError('PULL_COLLECTIONS_FAILED', err instanceof Error ? err.message : String(err), 'collection');
  }

  return { success: !anyError, counts, error: anyError };
}

interface PushCounts {
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * Push the local utility snapshot to the backend for the authenticated user.
 * Local-first and non-destructive:
 * - returns a safe skipped result when flags are off or unauthenticated
 * - upserts each local record via syncFreeTierEntity (RLS-scoped, user-owned)
 * - never mutates or deletes local data
 * - a failed upsert is captured per-record; it does not abort the batch
 *
 * Note: nested collection membership (collection_item rows) is intentionally
 * NOT pushed here. That table keys membership by a uuid FK to the remote
 * collection id, which is not resolvable from local string ids without a
 * post-insert lookup; deferring it avoids guaranteed FK failures. Collection
 * name/cover metadata still syncs.
 */
export async function pushFreeTierUtilitySnapshot(): Promise<{
  success: boolean;
  skipped?: boolean;
  counts?: PushCounts;
  results?: FreeTierSyncResult[];
  error?: FreeTierSyncError;
}> {
  if (!FREE_TIER_BACKEND_SYNC_ENABLED) {
    return { success: true, skipped: true };
  }
  if (!FREE_TIER_BACKEND_WRITE_ENABLED) {
    return { success: true, skipped: true, error: makeError('WRITE_DISABLED', 'Backend write flag is disabled.') };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: true, skipped: true, error: makeError('UNAUTHENTICATED', 'No authenticated user; push skipped.') };
  }

  const results: FreeTierSyncResult[] = [];
  try {
    const [care, sizing, feedback, wishlist, collections, wear, activity] = await Promise.all([
      loadCareNotes(),
      loadBrandSizing(),
      loadOutfitFeedback(),
      loadWishlistIntent(),
      loadCollections(),
      loadWearTracking(),
      loadActivityLog(),
    ]);

    for (const entry of Object.values(care) as CareNoteEntry[]) {
      results.push(await syncFreeTierEntity('care_note', 'upsert', mapCareNoteEntryToRemote(entry)));
    }
    for (const entry of Object.values(sizing) as BrandSizingEntry[]) {
      results.push(await syncFreeTierEntity('brand_sizing_note', 'upsert', mapBrandSizingEntryToRemote(entry)));
    }
    for (const entry of Object.values(feedback) as OutfitFeedbackEntry[]) {
      results.push(await syncFreeTierEntity('outfit_feedback', 'upsert', mapOutfitFeedbackEntryToRemote(entry)));
    }
    for (const entry of Object.values(wishlist) as WishlistIntentEntry[]) {
      results.push(await syncFreeTierEntity('wishlist_intent', 'upsert', mapWishlistIntentEntryToRemote(entry)));
    }
    for (const entry of Object.values(wear) as WearTrackingEntry[]) {
      results.push(await syncFreeTierEntity('wear_event', 'upsert', mapWearTrackingEntryToRemoteWearEvent(entry)));
    }
    for (const event of activity as ActivityEvent[]) {
      results.push(await syncFreeTierEntity('activity_log', 'upsert', mapActivityEventToRemote(event)));
    }
    for (const collection of collections as OutfitCollection[]) {
      results.push(await syncFreeTierEntity('collection', 'upsert', mapOutfitCollectionToRemote(collection)));
    }

    // Drain any queued writes (e.g. from prior offline sessions) if enabled.
    if (FREE_TIER_BACKEND_QUEUE_ENABLED) {
      const queued = await syncPendingFreeTierWrites();
      results.push(...queued);
    }
  } catch (err) {
    return {
      success: false,
      results,
      error: makeError('PUSH_FAILED', err instanceof Error ? err.message : String(err)),
    };
  }

  const succeeded = results.filter((r) => r.success).length;
  const counts: PushCounts = {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
  return { success: counts.failed === 0, counts, results };
}
