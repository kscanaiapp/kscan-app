# DR-1 through DR-4 Complete Tree Inventory

Auditor: independent hostile pass
Worktree: `C:\src\KScan-dr-tree-hostile-audit-20260721`
Branch: `audit/dressingrooms-dr1-dr4-hostile-final`
Starting HEAD: `03a336b9f06e0d2bf31af0a8dacd49ff6fcfcdff`
Evidence classifications used per Section 5 of the audit brief.

---

## A. Client routes, screens, and components

| Object | Path | Phase | Reachability | Flag gate | Evidence |
| --- | --- | --- | --- | --- | --- |
| Dressing Room detail (messages panel) | `components/rooms/RoomMessagesPanel.tsx` | pre-DR + DR-3 | wired from Dressing Room detail screen | `DRESSING_ROOM_COLLABORATION_V1` (and children) | SOURCE VERIFIED |
| Room list, detail, shared-with-me, public preview, item cards, empty/loading/retry states | `app/(app)/rooms/*`, `app/rooms/*`, `components/rooms/*` | pre-DR + DR-3 | Router-linked | some behind collaboration flags | SOURCE VERIFIED (inventory-scan) |

## B. Client services / hooks / caches

| Object | Path | Phase | Evidence |
| --- | --- | --- | --- |
| `dressingRoomCollaboration.ts` (access, reactions, messages, catch-up, actor-generation) | `services/dressingRoomCollaboration.ts` | DR-3 | SOURCE VERIFIED |
| `roomMessages.ts` (RPC + legacy path shim) | `services/roomMessages.ts` | DR-3 (+ pre-DR legacy) | SOURCE VERIFIED |
| Canonical item contract + Scanner adapter | `services/dressingRoomItemContract.ts` | DR-1 | SOURCE VERIFIED |
| Commerce preservation | `services/dressingRoomCommerce.ts` | DR-1 | SOURCE VERIFIED |
| Idempotent Dedupe | `services/dressingRoomDedupe.ts` | DR-1 | SOURCE VERIFIED |
| Elise attachment builder (owned + shared room evidence, stable IDs) | `services/styleObjects.ts` (+ types under `types/`) | DR-2 | SOURCE VERIFIED |
| Elise provider gating advice metadata | `services/style-chat/providers/edgeStyleChatProvider.ts` | DR-2 (advice passthrough) | SOURCE VERIFIED |

## C. Database and backend objects

| Object | Path / SQL object | Phase | Evidence |
| --- | --- | --- | --- |
| `dressing_rooms.collaboration_access_version` column | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `dressing_room_messages.client_message_id`, `parent_message_id`, FK, indexes | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `dressing_room_collab_idempotency` table + RLS + grants | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `enforce_dressing_room_message_flat_thread` trigger + function | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `resolve_dressing_room_collaboration_access(uuid)` RPC | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `can_access_room_messages(uuid)` (owner + active-share) | DR-3 migration (replaces pre-DR-3 looser helper) | DR-3 | SOURCE VERIFIED |
| `revoke_room_share(uuid)` RPC | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `dr3_is_uuid_v4(uuid)`, `dr3_payload_hash(text)` helpers | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `set_dressing_room_item_reaction(...)` RPC | DR-3 migration (rebound by DR-4) | DR-3/DR-4 | SOURCE VERIFIED |
| `create_dressing_room_message(...)` RPC | DR-3 migration (rebound by DR-4) | DR-3/DR-4 | SOURCE VERIFIED |
| `list_dressing_room_messages(...)` RPC | DR-3 migration | DR-3 | SOURCE VERIFIED |
| `dressing_room_collab_idempotency_room_actor_op_request_key` unique constraint | DR-4 migration | DR-4 | SOURCE VERIFIED |
| `dressing_room_collab_idempotency.room_id NOT NULL` | DR-4 migration | DR-4 | SOURCE VERIFIED |

## D. Integration seams

| Seam | Path | Reachability | Evidence |
| --- | --- | --- | --- |
| Scanner → room (canonical item, provenance) | `services/dressingRoomItemContract.ts` + Scan Result save flow | via Scan Result save | SOURCE VERIFIED |
| Recent Scans → room | Scan Result reopen path | via saved scans list | SOURCE VERIFIED |
| Closet → room | Library add flow | via Library actions | SOURCE VERIFIED |
| Room → Elise attachment (owned) | `services/styleObjects.ts` | via StyleChat handoff | SOURCE VERIFIED |
| Room → Elise attachment (shared room evidence) | `services/styleObjects.ts` | via StyleChat handoff | SOURCE VERIFIED |
| Room → commerce | `services/dressingRoomCommerce.ts` | via item detail | SOURCE VERIFIED |
| Public preview | `get_public_room_preview` (pre-DR); DR-3/DR-4 do not modify | via link share | SOURCE VERIFIED (unchanged) |
| Old-client direct-table paths | `dressing_room_messages`, `dressing_room_item_reactions` | continues via hardened RLS | SOURCE VERIFIED |

## E. Feature flags (exact names, all default OFF)

- `DRESSING_ROOM_CANONICAL_ITEM_V1`
- `DRESSING_ROOM_COMMERCE_PRESERVATION_V1`
- `DRESSING_ROOM_DEDUPE_V1`
- `ELISE_DRESSING_ROOM_ATTACHMENTS_V1`
- `ELISE_SHARED_ROOM_EVIDENCE_V1`
- `ELISE_ADVICE_METADATA_CLIENT_V1`
- `DRESSING_ROOM_COLLABORATION_V1`
- `DRESSING_ROOM_REACTIONS_V1`
- `DRESSING_ROOM_MESSAGES_V1`
- `DRESSING_ROOM_THREADS_V1`
- `DRESSING_ROOM_REALTIME_SYNC_V1`
- `DRESSING_ROOM_READ_STATE_V1`

Source: [`constants/featureFlags.ts`](../../constants/featureFlags.ts). Each resolves `process.env.EXPO_PUBLIC_..._V1 === 'true'`; production defaults are OFF.

## F. Tests

Focused DR tests:

- `__tests__/dr2Integration.test.js`
- `__tests__/dr2PlatformParity.test.js`
- `__tests__/dr3Collaboration.test.js`
- `__tests__/dr4Hardening.test.js`
- `__tests__/dressingRoomCanonicalItemContract.test.js`
- `__tests__/dressingRoomItemContract.test.js`
- `__tests__/dressingRoomSavePolicy.test.js`

Result: 68 / 68 pass. See [`10_TEST_AND_VALIDATION_EVIDENCE.md`](10_TEST_AND_VALIDATION_EVIDENCE.md).

## G. Reachability findings

Every SQL object above is referenced by at least one client path or by another SQL object. `dressing_room_collab_idempotency` is written to only by the DR-3/DR-4 RPCs (no client table grants for insert/update/delete). No dead SQL objects observed inside the DR-3/DR-4 additions. No dead client paths introduced.
