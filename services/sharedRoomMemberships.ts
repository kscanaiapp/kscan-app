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

function isAuthRequiredError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === '28000' || code === 'PGRST301') return true;
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('authentication required');
}

type CurrentActor =
  | { status: 'authenticated'; userId: string }
  | { status: 'unauthenticated' }
  | { status: 'temporary_failure' };

async function getCurrentActor(): Promise<CurrentActor> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      devLog('session lookup failed', error.code);
      return { status: 'temporary_failure' };
    }

    const userId = data.session?.user?.id;
    return userId
      ? { status: 'authenticated', userId }
      : { status: 'unauthenticated' };
  } catch {
    devLog('session lookup threw');
    return { status: 'temporary_failure' };
  }
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

function readTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = value.trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function normalizeListRow(raw: unknown): SharedRoomMembershipSummary | null {
  if (!raw || typeof raw !== 'object') return null;

  const row = raw as Record<string, unknown>;
  if (typeof row.share_token !== 'string' || typeof row.status !== 'string') return null;
  const shareToken = normalizeRoomShareToken(row.share_token);
  if (!shareToken) return null;

  const availabilityRaw = row.status.trim();
  if (!LIST_AVAILABILITY.has(availabilityRaw as SharedRoomMembershipAvailability)) {
    return null;
  }

  const firstOpenedAt = readTimestamp(row.first_opened_at);
  const lastAccessedAt = readTimestamp(row.last_accessed_at);
  if (!firstOpenedAt || !lastAccessedAt) return null;

  const itemCountRaw = row.item_count;
  const itemCountCandidate =
    typeof itemCountRaw === 'number'
      ? itemCountRaw
      : typeof itemCountRaw === 'string' && itemCountRaw.trim() !== ''
        ? Number(itemCountRaw)
        : Number.NaN;
  if (!Number.isSafeInteger(itemCountCandidate) || itemCountCandidate < 0) return null;
  const itemCount = itemCountCandidate;

  const titleRaw = row.title;
  if (titleRaw != null && typeof titleRaw !== 'string') return null;
  const title: string | null =
    typeof titleRaw === 'string' && titleRaw !== '' ? titleRaw : null;

  const updatedAtRaw = row.room_updated_at;
  const updatedAt = updatedAtRaw == null ? null : readTimestamp(updatedAtRaw);
  if (updatedAtRaw != null && !updatedAt) return null;

  const availability = availabilityRaw as SharedRoomMembershipAvailability;
  if (availability === 'empty' && itemCount !== 0) return null;
  if (availability === 'available' && itemCount === 0) return null;

  return {
    shareToken,
    title: availability === 'unavailable' ? null : title,
    itemCount: availability === 'unavailable' ? 0 : itemCount,
    firstOpenedAt,
    lastAccessedAt,
    availability,
    updatedAt: availability === 'unavailable' ? null : updatedAt,
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
  try {
    const { data, error } = await supabase.rpc('save_shared_room_for_me', {
      p_share_token: normalizedToken,
    });

    if (error) {
      devLog('save rpc failed', error.code);
      return { status: 'temporary_failure' };
    }

    const status = readRpcStatus(data, SAVE_STATUSES, 'temporary_failure');
    return { status };
  } catch {
    devLog('save rpc threw');
    return { status: 'temporary_failure' };
  }
}

export async function saveSharedRoomForCurrentUser(shareToken: string): Promise<SaveSharedRoomResult> {
  const normalizedToken = normalizeTokenInput(shareToken);
  if (!normalizedToken) {
    return { status: 'malformed' };
  }

  const actor = await getCurrentActor();
  if (actor.status !== 'authenticated') {
    return { status: actor.status };
  }

  // The actor is part of the transient key so an auth change cannot cause one
  // account's in-flight request to suppress another account's save.
  const inFlightKey = `${actor.userId}:${normalizedToken}`;
  const existing = saveInFlight.get(inFlightKey);
  if (existing) {
    return existing;
  }

  const request = invokeSaveRpc(normalizedToken).finally(() => {
    if (saveInFlight.get(inFlightKey) === request) {
      saveInFlight.delete(inFlightKey);
    }
  });

  saveInFlight.set(inFlightKey, request);
  return request;
}

export async function listSharedRoomsForCurrentUser(): Promise<ListSharedRoomsResult> {
  const actor = await getCurrentActor();
  if (actor.status !== 'authenticated') {
    return { ok: false, reason: actor.status };
  }

  try {
    const { data, error } = await supabase.rpc('list_shared_rooms_for_me');

    if (error) {
      devLog('list rpc failed', error.code);
      if (isAuthRequiredError(error)) {
        return { ok: false, reason: 'unauthenticated' };
      }
      return { ok: false, reason: 'temporary_failure' };
    }

    if (!Array.isArray(data)) {
      return { ok: false, reason: 'temporary_failure' };
    }

    return { ok: true, rooms: normalizeSharedRoomMembershipListRows(data) };
  } catch {
    devLog('list rpc threw');
    return { ok: false, reason: 'temporary_failure' };
  }
}

async function invokeStatusRpc<T extends string>(
  rpcName: 'touch_shared_room_for_me' | 'remove_shared_room_for_me',
  normalizedToken: string,
  allowed: Set<T>,
): Promise<{ status: T | 'temporary_failure' }> {
  try {
    const { data, error } = await supabase.rpc(rpcName, {
      p_share_token: normalizedToken,
    });

    if (error) {
      devLog(`${rpcName} rpc failed`, error.code);
      return { status: 'temporary_failure' };
    }

    const status = readRpcStatus(data, allowed, 'temporary_failure' as T);
    return { status: status as T | 'temporary_failure' };
  } catch {
    devLog(`${rpcName} rpc threw`);
    return { status: 'temporary_failure' };
  }
}

export async function touchSharedRoomForCurrentUser(shareToken: string): Promise<TouchSharedRoomResult> {
  const normalizedToken = normalizeTokenInput(shareToken);
  if (!normalizedToken) {
    return { status: 'malformed' };
  }

  const actor = await getCurrentActor();
  if (actor.status !== 'authenticated') {
    return { status: actor.status };
  }

  return invokeStatusRpc('touch_shared_room_for_me', normalizedToken, TOUCH_STATUSES);
}

export async function removeSharedRoomForCurrentUser(shareToken: string): Promise<RemoveSharedRoomResult> {
  const normalizedToken = normalizeTokenInput(shareToken);
  if (!normalizedToken) {
    return { status: 'malformed' };
  }

  const actor = await getCurrentActor();
  if (actor.status !== 'authenticated') {
    return { status: actor.status };
  }

  return invokeStatusRpc('remove_shared_room_for_me', normalizedToken, REMOVE_STATUSES);
}

/** Test-only helper to reset in-flight deduplication state. */
export function __resetSharedRoomMembershipSaveInFlightForTests(): void {
  saveInFlight.clear();
}
