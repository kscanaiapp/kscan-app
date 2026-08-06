// Pure Dressing Room share-link state helpers (Build 25 Phase 1 — BUG-12).
//
// "Disable Shared Link" must only ever be offered when an active shared
// link actually exists. Gating it on room-ownership permissions alone (can
// this user share this room?) rather than on real link state let a room
// that has never been shared display a destructive control for a link that
// was never created.

export type RoomShareRow = {
  is_active?: boolean | null;
  revoked_at?: string | null;
  expires_at?: string | null;
  share_token?: string | null;
} | null | undefined;

export type RoomShareStatus = {
  /** True only when an active, non-revoked, non-expired share link exists. */
  active: boolean;
  shareToken: string | null;
};

/**
 * Mirrors the authoritative predicate used by the room_shares RLS/RPC
 * surface: `is_active = true AND revoked_at IS NULL AND (expires_at IS NULL
 * OR expires_at > now())`. A `null`/`undefined` row (no share row at all —
 * the room has never had a shared link) evaluates to inactive.
 */
export function evaluateRoomShareRow(row: RoomShareRow, now: number = Date.now()): RoomShareStatus {
  if (!row) return { active: false, shareToken: null };
  const isActive = row.is_active === true;
  const notRevoked = row.revoked_at == null;
  const notExpired = row.expires_at == null || new Date(row.expires_at).getTime() > now;
  const active = isActive && notRevoked && notExpired;
  return { active, shareToken: active ? (row.share_token ?? null) : null };
}

/**
 * Whether the destructive "Disable Shared Link" control should render.
 *
 * `hasActiveShare` is `null` while the real status is unknown (still
 * loading, or the status fetch failed) — the destructive action must never
 * flash on for an unknown state, only for a *confirmed* active link.
 */
export function shouldOfferDisableSharedLink(hasActiveShare: boolean | null): boolean {
  return hasActiveShare === true;
}
