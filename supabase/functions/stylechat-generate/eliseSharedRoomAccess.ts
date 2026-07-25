/**
 * DR-2 unified shared-room access resolver.
 *
 * One authoritative decision for shared evidence and shared media authorization.
 * Membership alone is never enough — active share, expiry, revocation, and
 * share-owner ↔ room-owner staleness must all hold.
 *
 * Fail-closed: any missing or contradictory signal → unauthorized.
 * Does not accept public share tokens for authenticated evidence resolution.
 */

export type SharedRoomAccessDecision =
  | { ok: true; roomId: string; shareId: string; ownerId: string }
  | { ok: false; reason: 'unauthorized' | 'not_found' | 'unavailable' };

export type SharedRoomAccessRow = {
  membershipId: string;
  shareId: string;
  roomId: string;
  shareOwnerId: string;
  isActive: boolean;
  revokedAt: string | null;
  expiresAt: string | null;
  removedAt: string | null;
  /** Current dressing_rooms.user_id for the share's room, when known. */
  currentRoomOwnerId: string | null;
};

export type SharedRoomAccessDataSource = {
  /**
   * Load membership+share rows for the authenticated recipient.
   * Must already be scoped to recipient_user_id = actorId.
   */
  listRecipientMemberships(actorId: string): Promise<SharedRoomAccessRow[]>;
};

function isActiveShare(row: SharedRoomAccessRow, nowMs: number): boolean {
  if (row.removedAt) return false;
  if (row.isActive === false) return false;
  if (row.revokedAt) return false;
  if (row.expiresAt) {
    const expires = Date.parse(row.expiresAt);
    if (Number.isFinite(expires) && expires <= nowMs) return false;
  }
  return true;
}

/**
 * Pure decision over a preloaded membership+share+room-owner snapshot.
 * Prefer this in tests; the async helper wraps data loading.
 */
export function decideSharedRoomAccess(input: {
  actorId: string;
  roomId: string;
  rows: SharedRoomAccessRow[];
  nowMs?: number;
}): SharedRoomAccessDecision {
  const nowMs = input.nowMs ?? Date.now();
  const roomId = input.roomId.trim().toLowerCase();
  if (!roomId || !input.actorId) return { ok: false, reason: 'unauthorized' };

  let sawRoom = false;
  for (const row of input.rows) {
    if (row.roomId.trim().toLowerCase() !== roomId) continue;
    sawRoom = true;
    if (!isActiveShare(row, nowMs)) continue;
    // Share owner must still match the room's current owner.
    if (!row.currentRoomOwnerId || row.currentRoomOwnerId !== row.shareOwnerId) {
      continue;
    }
    // Owner-as-recipient does not grant "shared" evidence — that path is owned.
    if (row.shareOwnerId === input.actorId) continue;
    return {
      ok: true,
      roomId,
      shareId: row.shareId,
      ownerId: row.shareOwnerId,
    };
  }
  return { ok: false, reason: sawRoom ? 'unauthorized' : 'unauthorized' };
}

/**
 * Resolve whether `actorId` may use evidence/media from `roomId` as shared.
 * Public tokens are intentionally ignored — callers must not pass them here.
 */
export async function resolveSharedRoomAccess(input: {
  actorId: string;
  roomId: string;
  data: SharedRoomAccessDataSource;
  nowMs?: number;
}): Promise<SharedRoomAccessDecision> {
  let rows: SharedRoomAccessRow[];
  try {
    rows = await input.data.listRecipientMemberships(input.actorId);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  return decideSharedRoomAccess({
    actorId: input.actorId,
    roomId: input.roomId,
    rows,
    nowMs: input.nowMs,
  });
}

/**
 * Map a PostgREST membership join row into SharedRoomAccessRow.
 * Tolerates array or object embeds for room_shares / dressing_rooms.
 */
export function mapMembershipJoinRow(
  row: Record<string, unknown>,
  roomOwnerById?: Map<string, string>,
): SharedRoomAccessRow | null {
  const share = row.room_shares as Record<string, unknown> | Record<string, unknown>[] | null;
  const shareRow = Array.isArray(share) ? share[0] : share;
  if (!shareRow) return null;
  const roomId = typeof shareRow.room_id === 'string' ? shareRow.room_id : null;
  const shareId =
    (typeof row.share_id === 'string' && row.share_id) ||
    (typeof shareRow.id === 'string' && shareRow.id) ||
    null;
  const shareOwnerId = typeof shareRow.owner_id === 'string' ? shareRow.owner_id : null;
  const membershipId = typeof row.id === 'string' ? row.id : '';
  if (!roomId || !shareId || !shareOwnerId) return null;

  let currentRoomOwnerId: string | null =
    roomOwnerById?.get(roomId) ??
    (typeof row.current_room_owner_id === 'string' ? row.current_room_owner_id : null);

  const nestedRoom =
    shareRow.dressing_rooms as Record<string, unknown> | Record<string, unknown>[] | null | undefined;
  if (!currentRoomOwnerId && nestedRoom) {
    const room = Array.isArray(nestedRoom) ? nestedRoom[0] : nestedRoom;
    if (room && typeof room.user_id === 'string') currentRoomOwnerId = room.user_id;
  }

  return {
    membershipId,
    shareId,
    roomId,
    shareOwnerId,
    isActive: shareRow.is_active !== false,
    revokedAt: typeof shareRow.revoked_at === 'string' ? shareRow.revoked_at : null,
    expiresAt: typeof shareRow.expires_at === 'string' ? shareRow.expires_at : null,
    removedAt: typeof row.removed_at === 'string' ? row.removed_at : null,
    currentRoomOwnerId,
  };
}
