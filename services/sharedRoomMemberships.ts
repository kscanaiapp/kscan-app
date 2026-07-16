// Shared Dressing Room membership client (Phase 2A.2).
//
// Account-anchored "Shared with Me" discovery via SECURITY DEFINER RPCs only.
// Never logs share tokens, membership IDs, or raw Supabase errors to UI code.

import { supabase } from './supabaseClient';
import { normalizeRoomShareToken } from './roomDeepLinks';

export type SaveSharedRoomStatus =
  | 'saved'
  | 'already_saved'
  | 'restored'
  | 'owner'
  | 'unavailable'
  | 'unauthenticated'
  | 'malformed'
  | 'temporary_failure';

export type TouchSharedRoomStatus =
  | 'touched'
  | 'unavailable'
  | 'unauthenticated'
  | 'malformed'
  | 'temporary_failure';

export type RemoveSharedRoomStatus =
  | 'removed'
  | 'unavailable'
  | 'unauthenticated'
  | 'malformed'
  | 'temporary_failure';

export type SharedRoomMembershipAvailability = 'available' | 'empty' | 'unavailable';

export type SharedRoomMembershipSummary = {
  shareToken: string;
  title: string | null;
  itemCount: number;
  firstOpenedAt: string;
  lastAccessedAt: string;
  availability: SharedRoomMembershipAvailability;
  updatedAt: string | null;
};

export type SaveSharedRoomResult = { status: SaveSharedRoomStatus };
export type TouchSharedRoomResult = { status: TouchSharedRoomStatus };
export type RemoveSharedRoomResult = { status: RemoveSharedRoomStatus };

export type ListSharedRoomsResult =
  | { ok: true; rooms: SharedRoomMembershipSummary[] }
  | { ok: false; reason: 'unauthenticated' | 'temporary_failure' };

const SAVE_STATUSES = new Set<SaveSharedRoomStatus>([
  'saved',
  'already_saved',
  'restored',
  'owner',
  'unavailable',
  'unauthenticated',
  'malformed',
]);

const TOUCH_STATUSES = new Set<TouchSharedRoomStatus>([
  'touched',
  'unavailable',
  'unauthenticated',
  'malformed',
]);

const REMOVE_STATUSES = new Set<RemoveSharedRoomStatus>([
  'removed',
  'unavailable',
  'unauthenticated',
  'malformed',
]);

const LIST_AVAILABILITY = new Set<SharedRoomMembershipAvailability>([
  'available',
  'empty',
  'unavailable',
]);

const saveInFlight = new Map<string, Promise<SaveSharedRoomResult>>();

function devLog(event: string, code?: string | number | null) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info('[sharedRoomMemberships]', event, code ? { code } : undefined);
  }
}

function isMissingRpcError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === 'PGRST202' || code === '42883') return true;
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('could not find the function') || message.includes('does not exist');
}

function isAuthRequiredError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === '28000' || code === 'PGRST301') return true;
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('authentication required');
}

function isNetworkLikeError(error: { message?: string } | null | undefined) {
  if (!error) return false;
  const message = String(error.message ?? '').toLowerCase();
  return (
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('failed to fetch') ||
    message.includes('timeout')
  );
}

async function getCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

function normalizeTokenInput(shareToken: string): string | null {
  return normalizeRoomShareToken(shareToken);
}

function readRpcStatus<T extends string>(
  data: unknown,
  allowed: Set<T>,
  fallback: T,
): T {
  if (!data || typeof data !== 'object') return fallback;
  const status = String((data as { status?: unknown }).status ?? '').trim();
  return allowed.has(status as T) ? (status as T) : fallback;
}

function normalizeListRow(raw: unknown): SharedRoomMembershipSummary | null {
  if (!raw || typeof raw !== 'object') return null;

  const row = raw as Record<string, unknown>;
  const shareToken = normalizeRoomShareToken(String(row.share_token ?? row.shareToken ?? ''));
  if (!shareToken) return null;

  const availabilityRaw = String(row.status ?? row.availability ?? '').trim();
  if (!LIST_AVAILABILITY.has(availabilityRaw as SharedRoomMembershipAvailability)) {
    return null;
  }

  const firstOpenedAt = String(row.first_opened_at ?? row.firstOpenedAt ?? '').trim();
  const lastAccessedAt = String(row.last_accessed_at ?? row.lastAccessedAt ?? '').trim();
  if (!firstOpenedAt || !lastAccessedAt) return null;

  const itemCountRaw = row.item_count ?? row.itemCount;
  const itemCount =
    typeof itemCountRaw === 'number' && Number.isFinite(itemCountRaw)
      ? Math.max(0, Math.trunc(itemCountRaw))
      : typeof itemCountRaw === 'string' && itemCountRaw.trim() !== '' && Number.isFinite(Number(itemCountRaw))
        ? Math.max(0, Math.trunc(Number(itemCountRaw)))
        : null;
  if (itemCount === null) return null;

  const titleRaw = row.title;
  const title =
    titleRaw == null || titleRaw === ''
      ? null
      : typeof titleRaw === 'string'
        ? titleRaw
        : null;

  const updatedAtRaw = row.room_updated_at ?? row.updatedAt ?? row.updated_at ?? null;
  const updatedAt =
    updatedAtRaw == null || updatedAtRaw === ''
      ? null
      : typeof updatedAtRaw === 'string'
        ? updatedAtRaw
        : null;

  return {
    shareToken,
    title,
    itemCount,
    firstOpenedAt,
    lastAccessedAt,
    availability: availabilityRaw as SharedRoomMembershipAvailability,
    updatedAt,
  };
}

export function normalizeSharedRoomMembershipListRows(rows: unknown[]): SharedRoomMembershipSummary[] {
  const normalized: SharedRoomMembershipSummary[] = [];
  for (const row of rows) {
    const summary = normalizeListRow(row);
    if (summary) normalized.push(summary);
  }
  return normalized;
}

async function invokeSaveRpc(normalizedToken: string): Promise<SaveSharedRoomResult> {
  const { data, error } = await supabase.rpc('save_shared_room_for_me', {
    p_share_token: normalizedToken,
  });

  if (error) {
    devLog('save rpc failed', error.code);
    if (isMissingRpcError(error) || isNetworkLikeError(error)) {
      return { status: 'temporary_failure' };
    }
    return { status: 'temporary_failure' };
  }

  const status = readRpcStatus(data, SAVE_STATUSES, 'temporary_failure');
  return { status };
}

export function saveSharedRoomForCurrentUser(shareToken: string): Promise<SaveSharedRoomResult> {
  const normalizedToken = normalizeTokenInput(shareToken);
  if (!normalizedToken) {
    return Promise.resolve({ status: 'malformed' });
  }

  const existing = saveInFlight.get(normalizedToken);
  if (existing) {
    return existing;
  }

  const request = (async (): Promise<SaveSharedRoomResult> => {
    const userId = await getCurrentUserId();
    if (!userId) {
      return { status: 'unauthenticated' };
    }
    return invokeSaveRpc(normalizedToken);
  })().finally(() => {
    if (saveInFlight.get(normalizedToken) === request) {
      saveInFlight.delete(normalizedToken);
    }
  });

  saveInFlight.set(normalizedToken, request);
  return request;
}

export async function listSharedRoomsForCurrentUser(): Promise<ListSharedRoomsResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { ok: false, reason: 'unauthenticated' };
  }

  const { data, error } = await supabase.rpc('list_shared_rooms_for_me');

  if (error) {
    devLog('list rpc failed', error.code);
    if (isAuthRequiredError(error)) {
      return { ok: false, reason: 'unauthenticated' };
    }
    return { ok: false, reason: 'temporary_failure' };
  }

  const rows = Array.isArray(data) ? data : [];
  return { ok: true, rooms: normalizeSharedRoomMembershipListRows(rows) };
}

async function invokeStatusRpc<T extends string>(
  rpcName: 'touch_shared_room_for_me' | 'remove_shared_room_for_me',
  normalizedToken: string,
  allowed: Set<T>,
): Promise<{ status: T | 'temporary_failure' }> {
  const { data, error } = await supabase.rpc(rpcName, {
    p_share_token: normalizedToken,
  });

  if (error) {
    devLog(`${rpcName} rpc failed`, error.code);
    if (isMissingRpcError(error) || isNetworkLikeError(error)) {
      return { status: 'temporary_failure' };
    }
    return { status: 'temporary_failure' };
  }

  const status = readRpcStatus(data, allowed, 'temporary_failure' as T);
  return { status: status as T | 'temporary_failure' };
}

export async function touchSharedRoomForCurrentUser(shareToken: string): Promise<TouchSharedRoomResult> {
  const normalizedToken = normalizeTokenInput(shareToken);
  if (!normalizedToken) {
    return { status: 'malformed' };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return { status: 'unauthenticated' };
  }

  return invokeStatusRpc('touch_shared_room_for_me', normalizedToken, TOUCH_STATUSES);
}

export async function removeSharedRoomForCurrentUser(shareToken: string): Promise<RemoveSharedRoomResult> {
  const normalizedToken = normalizeTokenInput(shareToken);
  if (!normalizedToken) {
    return { status: 'malformed' };
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return { status: 'unauthenticated' };
  }

  return invokeStatusRpc('remove_shared_room_for_me', normalizedToken, REMOVE_STATUSES);
}

/** Test-only helper to reset in-flight deduplication state. */
export function __resetSharedRoomMembershipSaveInFlightForTests(): void {
  saveInFlight.clear();
}
