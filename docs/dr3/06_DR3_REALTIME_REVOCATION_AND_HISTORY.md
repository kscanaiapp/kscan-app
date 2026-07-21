# 06 — DR-3 Realtime, Revocation, and Historical Integrity

## Sync strategy

Supabase Realtime for collaboration remains **OFF**. Safe path:

`startCollaborationBoundedRefresh` — access revalidation + bounded message refresh (12s base, backoff to 60s).

Flag: `DRESSING_ROOM_REALTIME_SYNC_V1` (default OFF).

## Revocation signal

1. Owner calls `revoke_room_share`
2. Share rows: `is_active=false`, `revoked_at=now()`
3. Room `collaboration_access_version` increments
4. Hardened `can_access_room_messages` fails for participants whose share is inactive
5. Client bounded refresh / access RPC observes loss → unsubscribe/stop, clear optimistic state, ignore stale generation

## Historical integrity

Share revocation **does not** delete:

- `dressing_room_messages`
- `dressing_room_item_reactions`
- `dressing_room_participants` rows (access fails closed without cascade erase)

Owner retains conversation/reaction history. Account deletion separately cascades actor-owned rows including `dressing_room_collab_idempotency`.

## Account switch

`bumpCollabActorGeneration(actorId)` — stale responses discarded via `isCurrentCollabGeneration`. Auth state change clears interactive panel state and stops sync.
