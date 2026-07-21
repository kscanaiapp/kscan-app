# 08 — DR-4 Defect Repair Log

Each repair uses the required fields: severity, failure evidence, root cause, exact files changed, repair, why correct, focused tests, broad tests, compatibility impact, migration impact, rollback/forward-remediation.

---

## R-DR4-1 — Idempotency ledger unique omitted `room_id` (P1)

| Field | Detail |
| ----- | ------ |
| **Severity** | P1 |
| **Failure evidence** | Unique `(actor_id, operation, request_id)` rejected legitimate cross-room reuse of the same UUIDv4 when payload hash differed by `room_id` ("Idempotency key reused with different payload"). |
| **Root cause** | DR-3 ledger uniqueness scoped to actor+operation+request only; semantic scope required room. |
| **Exact files changed** | `supabase/migrations/20260721183308_dr4_collab_idempotency_room_scope.sql`; `__tests__/dr4Hardening.test.js`; `__tests__/dr3Collaboration.test.js` |
| **Repair** | `room_id` NOT NULL; unique `(room_id, actor_id, operation, request_id)`; reaction/message RPC lookups filter `where room_id = p_room_id`. |
| **Why the repair is correct** | Matches required composite scope; payload hash already includes room; cross-room same requestId no longer collides; same-room replay + payload-mismatch rejection preserved. |
| **Focused tests** | `DR-4 idempotency unique key includes room_id`; DR-3 ledger supersession assert. |
| **Broad tests** | Deno 71 + Node 101 bridge; focused DR-3/DR-4 24/24. |
| **Compatibility impact** | Forward migration; old unique constraint dropped. Clients already send per-room requestIds. Flags OFF → legacy paths unused for ledger. |
| **Migration impact** | New forward-only SQL; **not** applied to production this pass. |
| **Rollback / forward-remediation** | Do not apply until staging validated. If applied, forward-fix preferred over recreating actor-only unique. |

---

## R-DR4-2 — Bounded refresh never walked newer cursor (P2)

| Field | Detail |
| ----- | ------ |
| **Severity** | P2 |
| **Failure evidence** | Sync ticks revalidated access but did not keyset-walk messages newer than the loaded newest cursor; live inserts could be missed until full reload. |
| **Root cause** | No `direction: 'newer'` catch-up loop bound to a retained newest cursor. |
| **Exact files changed** | `services/dressingRoomCollaboration.ts` (`catchUpCollaborationMessages`); `services/roomMessages.ts` (`catchUpRoomMessages`); `components/rooms/RoomMessagesPanel.tsx` (`newestCursorRef`) |
| **Repair** | Catch-up pages newer keyset up to `DR3_COLLAB_CATCHUP_MAX_PAGES`; panel stores/updates `newestCursorRef` on load, send, and tick. |
| **Why the repair is correct** | Uses existing no-OFFSET keyset RPC; merges by stable id; bounds pages to avoid unbounded refetch. |
| **Focused tests** | `DR-4 catch-up uses newer keyset and bounds pages`; merge equal-timestamp test. |
| **Broad tests** | Deno 71 + Node 101; DR-3 keyset asserts remain green. |
| **Compatibility impact** | Shared RN only; behind sync/messages flags. |
| **Migration impact** | None (client-only). |
| **Rollback / forward-remediation** | Leave `DRESSING_ROOM_REALTIME_SYNC_V1` OFF; or revert catch-up helpers. |

---

## R-DR4-3 — `onTick` access errors only backed off (P2)

| Field | Detail |
| ----- | ------ |
| **Severity** | P2 |
| **Failure evidence** | Access/unauthorized errors thrown from `onTick` (e.g. catch-up after revoke) took the generic catch path and backed off instead of tearing down interactive sync. |
| **Root cause** | Catch block did not classify collaboration access errors. |
| **Exact files changed** | `services/dressingRoomCollaboration.ts` (`isCollaborationAccessError`, `startCollaborationBoundedRefresh`) |
| **Repair** | Access-class errors call `onAccessLost()` then `stop()`; non-access errors keep exponential backoff. |
| **Why the repair is correct** | Aligns tick failures with resolve-fail path; prevents zombie sync after revoke-class errors. |
| **Focused tests** | `DR-4 access errors from onTick tear down sync`; `DR-4 access error classifier recognizes revoke classes`. |
| **Broad tests** | Deno 71 + Node 101; focused 24/24. |
| **Compatibility impact** | Shared module; improves revoke UX when sync flag ON. |
| **Migration impact** | None. |
| **Rollback / forward-remediation** | Revert classifier branch; sync flag OFF avoids path. |

---

## R-DR4-4 — Pending send after revoke / account switch (P2)

| Field | Detail |
| ----- | ------ |
| **Severity** | P2 |
| **Failure evidence** | In-flight `sendRoomMessage` could resolve after access revoke or actor change and still mutate panel state. |
| **Root cause** | Send completion lacked generation/revoke guards; stale session conflated with access errors. |
| **Exact files changed** | `components/rooms/RoomMessagesPanel.tsx`; `services/roomMessages.ts` (`ROOM_MESSAGES_STALE_ERROR`) |
| **Repair** | Capture `sendGeneration`; discard apply if generation mismatch or `accessRevoked`; service throws `ROOM_MESSAGES_STALE_ERROR` on stale gen (distinct from `ROOM_MESSAGES_ACCESS_ERROR`). |
| **Why the repair is correct** | Prevents cross-account UI contamination and post-revoke optimistic settle without treating stale as permanent access revoke incorrectly. |
| **Focused tests** | `DR-4 send applies generation and revoke guards`; actor generation behavioral tests. |
| **Broad tests** | Deno 71 + Node 101; focused 24/24. |
| **Compatibility impact** | Shared RN; messages flag ON path. |
| **Migration impact** | None. |
| **Rollback / forward-remediation** | Revert panel/service guards; flags OFF uses legacy send without collab generation path. |

---

## Verified NOT A DEFECT (no repair)

| Topic | Why |
| ----- | --- |
| Revocation-aware `can_access_room_messages` + access version bump | Present in DR-3 migration; history preserved |
| Keyset pagination without OFFSET | Present; tuple compare |
| Flat thread trigger | Present; depth-1 |
| Realtime OFF / bounded refresh | Intentional safe sync |
| No AsyncStorage for room collab state | Confirmed in collab/messages/panel sources |
| Commerce via `dressingRoomCommerce` + flags | Preserved |
| Elise: no product arrays; `purchaseUrlPresent` only | Preserved |
| Reactions do not rewrite item snapshots | Reaction RPC has no item snapshot update |

## Related test maintainability (non-collab defect)

| Note | Detail |
| ---- | ------ |
| Bridge stub | `dressingRoomSavePolicy.test.js` VM stubs updated for `./dressingRoomCollaboration` import after DR-3 client wiring (required for Node bridge green). |
