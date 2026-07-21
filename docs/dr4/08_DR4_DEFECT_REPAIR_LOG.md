# 08 — DR-4 Defect Repair Log

## R1 — P1 Idempotency unique key omitted `room_id`

1. **Severity:** P1  
2. **Evidence:** DR-3 unique `(actor_id, operation, request_id)`; cross-room same requestId rejected via payload-hash mismatch.  
3. **Root cause:** Ledger uniqueness weaker than semantic room+actor+requestId scope.  
4. **Files:** `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql`  
5. **Repair:** `room_id NOT NULL`; unique `(room_id, actor_id, operation, request_id)`; RPC lookups include `room_id`.  
6. **Why correct:** Matches DR-4 required scope; message table already room-scoped.  
7. **Focused tests:** `dr4Hardening` idempotency assertions; updated `dr3Collaboration`.  
8. **Broad:** Deno 71 + Node 101 bridge.  
9. **Compatibility:** Additive; old clients without requestId unchanged.  
10. **Migration:** Forward-only, not applied to production. Rollback: restore prior unique (not recommended once data uses room scope).

## R2 — P2 Bounded refresh mid-window gaps

1. **Severity:** P2  
2. **Evidence:** Panel tick always loaded latest page only.  
3. **Root cause:** Unused `newer` direction.  
4. **Files:** `dressingRoomCollaboration.ts` (`catchUpCollaborationMessages`), `roomMessages.ts`, `RoomMessagesPanel.tsx`  
5. **Repair:** Catch-up from `newestCursor` with page cap.  
6. **Why correct:** Keyset-safe; bounded.  
7–8. Focused + bridge.  
9. Shared RN.  
10. Flag OFF disables sync.

## R3 — P2 Access errors during onTick did not tear down

1. **Severity:** P2  
2. **Evidence:** Catch only backoffs.  
3. **Root cause:** List/access race after resolve.  
4. **Files:** `dressingRoomCollaboration.ts`  
5. **Repair:** `isCollaborationAccessError` → `onAccessLost` + stop.  
6–10. As above.

## R4 — P2 Stale send after revoke/account switch

1. **Severity:** P2  
2. **Evidence:** Send success applied without generation/revoke gate.  
3. **Root cause:** Missing apply-time epoch.  
4. **Files:** `RoomMessagesPanel.tsx`, `roomMessages.ts` (`ROOM_MESSAGES_STALE_ERROR`)  
5. **Repair:** Capture `sendGeneration`; discard stale; distinguish stale vs access.  
6–10. As above.

## Bridge regression repair

- **P2 maintainability:** `dressingRoomSavePolicy.test.js` VM stubs updated for `./dressingRoomCollaboration` import (required after DR-3 client wiring).
