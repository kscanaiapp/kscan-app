# DR-3 Defect Repair Log

Each entry: what / why / root cause / files / fix correctness / tests / validation / parity / rollback.

---

## R-1 — Deno `GenerationRpcClient` / Gemini `attemptLabel` type baseline

| Field | Detail |
| ----- | ------ |
| **What** | Pre-existing `deno check` failures in `generationSafety.ts` / `index.ts` blocked a clean DR-3 type baseline. |
| **Why** | Bridge left 10 errors as out-of-scope; DR-3 required a zero-error Edge entrypoint before feature work. |
| **Root cause** | `GenerationRpcClient.rpc` typed as full `Promise`, but Supabase `.rpc()` returns a thenable `PostgrestFilterBuilder` (`PromiseLike`). Separate `attemptLabel` typing friction on Gemini retry path. |
| **Files** | `supabase/functions/stylechat-generate/generationSafety.ts`, `index.ts`, `generationSafetyTyping.test.ts` |
| **Fix correctness** | `rpc(...): PromiseLike<GenerationRpcResult>`; attempt labels remain `string`. Behavior unchanged. |
| **Tests** | New Deno typing tests; `deno check` → **0 errors**; **71** Deno + **101** Node bridge tests green at commit `bb13c2d`. |
| **Validation** | Compile/type gate only; no production deploy. |
| **Parity** | Edge Function shared; no mobile OS fork. |
| **Rollback** | Revert `bb13c2d` (restores prior type errors). |

---

## R-2 — `can_access_room_messages` ignored share revocation (P0/P1 zombie access)

| Field | Detail |
| ----- | ------ |
| **What** | Participants retained message RLS access after share revoke/expiry because access checked participant row only. |
| **Why** | Zombie read/write on collaborative messages after owner revoked. |
| **Root cause** | Original function (`202606240001_...`) used `exists(participant)` without joining active non-revoked non-expired share + owner match. |
| **Files** | Migration `20260721170559_dr3_collaborative_interactions.sql` (`can_access_room_messages`, `resolve_dressing_room_collaboration_access`, `revoke_room_share` + `collaboration_access_version`). |
| **Fix correctness** | Participant path requires active share, null `revoked_at`, non-expired, `rs.owner_id = dr.user_id`, actor ≠ owner. Revoke bumps access version; does **not** delete history. |
| **Tests** | Migration contract assertions in `dr3Collaboration.test.js`. |
| **Validation** | Source/migration contract only — **not** applied to production. |
| **Parity** | Server-side; affects all clients equally after migration. |
| **Rollback** | Do not apply migration; or reverse function definitions carefully if applied. |

---

## R-3 — Missing `requestId` idempotency for reactions/messages

| Field | Detail |
| ----- | ------ |
| **What** | Retries could double-apply reactions or duplicate messages. |
| **Why** | Mobile networks retry; UX needs desired-state + safe resend. |
| **Root cause** | Direct table upsert/insert without actor-scoped request ledger. |
| **Files** | Migration ledger + `set_dressing_room_item_reaction` / `create_dressing_room_message`; `dressingRoomCollaboration.ts`; `styleObjects.ts`; `roomMessages.ts`; deletion script row. |
| **Fix correctness** | Unique `(actor_id, operation, request_id)` with payload hash; conflict on hash mismatch; UUIDv4 required. |
| **Tests** | UUIDv4 + wiring presence tests; SQL contract checks. |
| **Validation** | Needs staging RPC replay after migration. |
| **Parity** | Shared client ID helper. |
| **Rollback** | Flags OFF → legacy paths; ledger unused if RPCs unused. |

---

## R-4 — OFFSET-less keyset pagination missing

| Field | Detail |
| ----- | ------ |
| **What** | Pre-DR-3 client loaded full ordered lists; no stable cursor API. |
| **Why** | OFFSET pagination breaks under concurrent inserts; unbounded lists don’t scale. |
| **Root cause** | No `(room_id, created_at, id)` keyset RPC/index contract. |
| **Files** | Migration index + `list_dressing_room_messages`; client `listCollaborationMessages` / `listRoomMessagesPage`; panel older-page UI. |
| **Fix correctness** | Tuple compare `(created_at, id)`; directions `older`/`newer`; limit clamp 1–50; **no OFFSET** in migration. |
| **Tests** | Migration asserts no `\boffset\b`; merge/cursor helpers tested. |
| **Validation** | Staging multi-page after migration. |
| **Parity** | Shared RN. |
| **Rollback** | Flags OFF restores full-list legacy path. |

---

## R-5 — Flat thread depth not enforced

| Field | Detail |
| ----- | ------ |
| **What** | `parent_message_id` could nest arbitrarily without server invariant. |
| **Why** | Product requires depth-1 replies only. |
| **Root cause** | Column alone without trigger. |
| **Files** | `enforce_dressing_room_message_flat_thread` trigger; panel only offers reply on roots when threads flag ON. |
| **Fix correctness** | Parent must be same-room non-deleted root (`parent_message_id is null`). |
| **Tests** | Migration string `Replies to replies are not allowed`. |
| **Validation** | Staging insert of reply-to-reply must fail. |
| **Parity** | Shared. |
| **Rollback** | Drop trigger only if column unused (not recommended once live). |

---

## R-6 — Realtime stub unsafe if naive — chose bounded refresh

| Field | Detail |
| ----- | ------ |
| **What** | `subscribeToRoomMessages` still throws; enabling naive Realtime risked post-revoke zombie channels. |
| **Why** | Revocation must tear down interactive state without private channel proof. |
| **Root cause** | No proven authenticated Realtime revocation path. |
| **Files** | `startCollaborationBoundedRefresh`; panel sync + AppState; `DRESSING_ROOM_REALTIME_SYNC_V1` (name historical; behavior = poll). |
| **Fix correctness** | Periodic access resolve + list; stop on unauthorized/generation mismatch; history preserved server-side. |
| **Tests** | Panel/source wiring asserts bounded refresh + AppState. |
| **Validation** | Next-build with sync flag; physical revoke mid-session. |
| **Parity** | Shared; no OS-specific channel. |
| **Rollback** | Leave sync flag OFF. |

---

## R-7 — Account switch stale state

| Field | Detail |
| ----- | ------ |
| **What** | In-flight collab responses could apply under a new auth actor. |
| **Why** | Cross-account contamination of message/reaction UI. |
| **Root cause** | No generation token around async collab calls. |
| **Files** | `bumpCollabActorGeneration` / `isCurrentCollabGeneration`; roomMessages, styleObjects, RoomMessagesPanel auth listener. |
| **Fix correctness** | Generation bumps on actor id change; stale generations abort apply/sync. |
| **Tests** | Behavioral actor-generation test. |
| **Validation** | Manual switch accounts during load/send. |
| **Parity** | Shared module state (per JS runtime). |
| **Rollback** | N/A beyond reverting client; safe with flags OFF. |
