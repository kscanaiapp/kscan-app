# Build 34 / Track B / Phase B2C — Operational Guide

Companion to `docs/build34-trackb-b2c-closet-cross-device-restore-ledger.md`. This page answers the operational questions directly; see the ledger for the full architecture and staging evidence.

## What triggers restore?

The Closet screen gaining focus (`hooks/useCloset.js`'s existing `useFocusEffect`). That is the only trigger. There is no AppState/foreground listener, no periodic timer, and no background OS task — restore only ever runs while a human has the Closet screen open or has just returned to it.

A 30-second in-memory cooldown (keyed by the signed-in actor id) collapses rapid re-focus into at most one real network pass; it resets immediately on an account switch and implicitly on app restart (it is never persisted).

## What disables restore?

Any one of, checked fresh on every attempt:

- `EXPO_PUBLIC_CLOSET_CROSS_DEVICE_RESTORE_V1` is not the exact string `"true"` (default OFF in every profile).
- K+ is not `active` for the signed-in actor (`services/kplus/kplusEntitlementStore.ts`).
- No authenticated session.

None of these are special-cased for reactivation: the next natural trigger (opening the Closet) re-evaluates all three from scratch.

## Where is durable sync state?

The same B2B sidecar, `kscan_closet/kscan_closet_sync.json` (account-partitioned, one file). B2C added exactly two fields to each entry: `conflictKind` and `cachedMediaUploadedAt`. There is no second sidecar and no second durable queue.

## How are conflicts represented?

`lastFailureClass: 'conflict'` (B2B's existing vocabulary) plus `conflictExpectedRowVersion` (also existing) plus the new `conflictKind`, one of:

- `remote_newer_local_dirty` — this device has an unsynced local edit, and the server has also moved on.
- `remote_tombstone_local_dirty` — this device has an unsynced local edit, and the server row was deleted elsewhere.

A conflicted item stays exactly where it is locally — visible, editable, usable. Nothing in B2C resolves it, merges it, or builds any UI for it. It will not be swept up by another restore pass (B2B's `needsSyncWork` already treats `lastFailureClass: 'conflict'` as "wait"), and it will not be re-pushed by B2B until something (a future phase, or a user re-edit that produces a fresh `updatedAt`) changes its state.

## Where is restored media cached?

`kscan_closet/remote-cache/{ownerId}/{serverItemId}-primary.jpg` and the matching `-thumb.jpg`, under `FileSystem.documentDirectory`. This is a namespace separate from the user's own captures (`kscan_closet/images/`, `kscan_closet/thumbnails/`), so it is never mistaken for a user-originated original and is invisible to the existing committed-media orphan sweep by construction (that sweep only enumerates the two original roots).

Cleanup happens only for an authoritative reason: an ordinary local delete already retires the cache file for free (it's just another referenced media path to `closetLibrary.js`'s existing unlink logic); a tombstone-reconciliation delete does the same; a media replacement retires the old file only after the new one is verified on disk. There is no TTL, no LRU, and no eviction triggered by "this item was absent from one page."

An account-scoped full-purge primitive (`purgeClosetRestoreMediaCacheForOwner`) exists for a future account-deletion completion worker but is deliberately left unwired, matching the same precedent B2B already set for its own two purge primitives (`purgeLocalClosetForOwner`, `purgeClosetSyncStateForOwner`).

## How does retry occur?

There is no separate B2C retry loop. A failed or partial pass simply leaves durable evidence (or none, for a merely-skipped item) and is naturally retried the next time the Closet gains focus — the same "no background scheduler, retry via ordinary trigger" philosophy B2B uses. A media download failure never blocks or retries in a tight loop; it is picked up again on the next pass because the sidecar's `cachedMediaUploadedAt` won't yet match the server's `media_uploaded_at`.

## How are staging fixtures removed?

Every staging validation for this phase used disposable fixture rows under three deterministic UUIDs (`00000000-0000-0000-0000-00000000b2c1/b2c2/b2c3`) and was torn down in the same session: `user_closet_items` rows, `user_entitlements` rows, and the fixture `auth.users` rows were all deleted, with a final count query proving zero rows remained in all three tables. Production (`wyyuqfdxucjksghsmhry`) was never contacted at any point.
