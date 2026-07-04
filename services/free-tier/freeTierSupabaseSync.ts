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
 * Full push/pull snapshots are intentionally stubbed; real network calls will
 * be wired once the remote table contracts are validated and flags are enabled.
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

  const direction = operation === 'upsert' ? 'push' : 'push';

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

/**
 * Pull a remote utility snapshot for the authenticated user.
 * Stub: returns not-implemented until the sync contract and conflict strategy
 * are reviewed. No network calls are made.
 */
export async function pullFreeTierUtilitySnapshot(): Promise<{
  success: boolean;
  data?: unknown;
  error?: FreeTierSyncError;
}> {
  if (!FREE_TIER_BACKEND_SYNC_ENABLED) {
    return { success: true };
  }

  if (!FREE_TIER_BACKEND_READ_ENABLED) {
    return {
      success: false,
      error: makeError('READ_DISABLED', 'Backend read flag is disabled.'),
    };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return {
      success: false,
      error: makeError('UNAUTHENTICATED', 'No authenticated user; pull skipped.'),
    };
  }

  // TODO: implement selective pull once conflict resolution and pagination
  // strategy are reviewed. For now this is a safe no-op stub.
  return {
    success: false,
    error: makeError('NOT_IMPLEMENTED', 'pullFreeTierUtilitySnapshot is a planned stub.'),
  };
}

/**
 * Push the entire local utility snapshot to the backend.
 * Stub: returns not-implemented until batching, conflict resolution, and
 * privacy review are complete. No network calls are made.
 */
export async function pushFreeTierUtilitySnapshot(): Promise<{
  success: boolean;
  results?: FreeTierSyncResult[];
  error?: FreeTierSyncError;
}> {
  if (!FREE_TIER_BACKEND_SYNC_ENABLED) {
    return { success: true };
  }

  if (!FREE_TIER_BACKEND_WRITE_ENABLED) {
    return {
      success: false,
      error: makeError('WRITE_DISABLED', 'Backend write flag is disabled.'),
    };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return {
      success: false,
      error: makeError('UNAUTHENTICATED', 'No authenticated user; push skipped.'),
    };
  }

  // TODO: implement batch push with mapping from local stores once table
  // contracts and conflict strategy are reviewed.
  return {
    success: false,
    error: makeError('NOT_IMPLEMENTED', 'pushFreeTierUtilitySnapshot is a planned stub.'),
  };
}
