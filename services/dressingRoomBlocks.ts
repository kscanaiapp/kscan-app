import { supabase } from './supabaseClient';

// Dressing Room account-level user blocking.
//
// Backed by public.block_dressing_room_user / unblock_dressing_room_user /
// list_dressing_room_blocked_users (SECURITY DEFINER RPCs; see
// supabase/migrations/20260806153233_dressing_room_user_blocking.sql). A
// block is account-level, not room-scoped, and applies in either direction.
//
// Privacy rules for this module:
//   * Never surface which account initiated a block, or raw Postgres/RLS
//     errors — every thrown error carries the neutral copy below.
//   * Never attempt to read the block table directly for "did they block me"
//     checks — that predicate is intentionally not client-computable; the
//     backend enforces it on every room/message/redemption path already.

export const DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR =
  'This Dressing Room interaction is unavailable.';
const BLOCK_ACTION_ERROR = "We couldn't complete that action. Please try again.";

function devLog(event: string, code?: string | number | null) {
  if (__DEV__) {
    console.warn(`[dressingRoomBlocks] ${event}`, code ? { code } : undefined);
  }
}

function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function requireSessionUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? null;
  if (!userId) {
    throw new Error(DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR);
  }
  return userId;
}

/**
 * Block the given account from all Dressing Room interaction with the
 * caller. Idempotent. Returns a neutral success result; never reveals block
 * direction, and never notifies the other account.
 */
export async function blockDressingRoomUser(targetUserId: string): Promise<{ ok: true }> {
  const currentUserId = await requireSessionUserId();
  if (!isValidUuid(targetUserId)) {
    throw new Error(DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR);
  }
  if (targetUserId === currentUserId) {
    throw new Error(DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR);
  }

  const { data, error } = await supabase.rpc('block_dressing_room_user', {
    p_target_user_id: targetUserId,
  });

  if (error || !data || (data as { ok?: boolean }).ok !== true) {
    devLog('block failed', error?.code);
    throw new Error(
      error?.code === '42501' ? DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR : BLOCK_ACTION_ERROR,
    );
  }

  return { ok: true };
}

/**
 * Remove a block the caller created. Idempotent — succeeds even if no block
 * existed. Does not restore any prior room access, grants, or invitations.
 */
export async function unblockDressingRoomUser(
  targetUserId: string,
): Promise<{ ok: true; removed: boolean }> {
  await requireSessionUserId();
  if (!isValidUuid(targetUserId)) {
    throw new Error(DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR);
  }

  const { data, error } = await supabase.rpc('unblock_dressing_room_user', {
    p_target_user_id: targetUserId,
  });

  if (error || !data || (data as { ok?: boolean }).ok !== true) {
    devLog('unblock failed', error?.code);
    throw new Error(BLOCK_ACTION_ERROR);
  }

  return { ok: true, removed: Boolean((data as { removed?: boolean }).removed) };
}

export type DressingRoomBlockedUser = {
  blockedUserId: string;
  createdAt: string;
};

/**
 * List accounts the caller has blocked. This schema has no display-name or
 * username column beyond email (which must never be shown here) — callers
 * should render a generic label such as "Blocked User" for every entry.
 */
export async function listDressingRoomBlockedUsers(): Promise<DressingRoomBlockedUser[]> {
  await requireSessionUserId();

  const { data, error } = await supabase.rpc('list_dressing_room_blocked_users');

  if (error) {
    devLog('list blocked users failed', error.code);
    throw new Error(BLOCK_ACTION_ERROR);
  }

  const rows = Array.isArray(data) ? data : [];
  return rows
    .filter(
      (row): row is { blocked_user_id: string; created_at: string } =>
        row && typeof row.blocked_user_id === 'string' && typeof row.created_at === 'string',
    )
    .map((row) => ({ blockedUserId: row.blocked_user_id, createdAt: row.created_at }));
}
