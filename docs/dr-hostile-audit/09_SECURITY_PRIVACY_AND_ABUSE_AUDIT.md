# Security, privacy, and abuse audit

## Authorization boundaries

| Attempted attack | Outcome | Evidence |
| --- | --- | --- |
| Cross-room item substitution (react to item in different room) | Rejected: RPC verifies `dri.dressing_room_id = p_room_id` | SOURCE VERIFIED (`20260721170559_dr3_collaborative_interactions.sql:410-417`) |
| Cross-user actor spoofing | Rejected: `auth.uid()` used directly; no `p_actor_id` parameter accepted | SOURCE VERIFIED (RPC signatures) |
| Room-owner spoofing | Rejected: owner derived server-side | SOURCE VERIFIED |
| Share-token replay after revoke | Rejected: `is_active`, `revoked_at` checked in access resolution | SOURCE VERIFIED |
| Expired-token access | Rejected: `expires_at > clock_timestamp()` | SOURCE VERIFIED |
| Malformed share token | Rejected: `join_room_via_share_token` normalizes token, no error leak | SOURCE VERIFIED |
| Malformed cursor | Rejected: RPC accepts null/typed params; SQL cast enforces validity | SOURCE VERIFIED |
| Cross-room cursor | Cursor is applied within `WHERE room_id = p_room_id`; access already verified | SOURCE VERIFIED |
| Malformed requestId | Rejected: `dr3_is_uuid_v4(p_request_id)` | SOURCE VERIFIED |
| requestId collision across rooms | Permitted post-DR-4 (independent lookup) | SOURCE VERIFIED |
| requestId collision within room with different payload | Rejected with `22023 "Idempotency key reused with different payload"` | SOURCE VERIFIED |
| Reply-to-reply | Trigger raises `22023` | SOURCE VERIFIED |
| Cross-room reply parent | Trigger raises `22023` | SOURCE VERIFIED |
| Deleted parent reply | Trigger raises `22023` | SOURCE VERIFIED |
| Empty message | Server sanitizes + rejects with `22023` | SOURCE VERIFIED |
| Oversized message (>1000 chars) | Server rejects with `22023` | SOURCE VERIFIED |
| Control characters (`\x00`-`\x1F`) | Server strips via regex before length check | SOURCE VERIFIED |
| Anonymous RPC invocation | Rejected: `revoke all ... from anon`, `grant execute to authenticated` | SOURCE VERIFIED |
| Anonymous idempotency ledger read/write | Rejected: `revoke all ... from public, anon, authenticated`; only service_role has table grants, actors have RPC path only | SOURCE VERIFIED |
| Client-authoritative access claim | Rejected: `resolve_dressing_room_collaboration_access` recomputes access from `auth.uid()` on every call | SOURCE VERIFIED |
| Prompt injection via room messages into Elise | Not possible: messages never passed to Elise attachment surface; Elise attaches by IDs only | SOURCE VERIFIED |
| Purchase / affiliate URL leakage into model prompt | Not possible: `toServerSafeActiveContext` in `edgeStyleChatProvider.ts` strips imageUri/textScanId/createdAt and never includes commerce URLs | SOURCE VERIFIED |

## Log leakage inspection

- `services/roomMessages.ts::devLog` accepts only event name + optional error code — never bodies/IDs/tokens (SOURCE VERIFIED, `roomMessages.ts:92-97`).
- `services/dressingRoomCollaboration.ts` never logs bodies, tokens, or JWTs.
- Edge provider `logHandledOperationalFailure` logs category strings only (`http_5xx`, `client_timeout`, `network_failure`, `attachments_unsupported`); no personal data (SOURCE VERIFIED at `edgeStyleChatProvider.ts:237-239`).
- No `console.log`/`console.warn` in the DR-3/DR-4 hot path emits message body, sender id, share token, JWT, refresh token, authorization header, signed image URL, email, or full personal identifier.

## Realtime posture

- `subscribeToRoomMessages` deliberately throws `ROOM_MESSAGES_REALTIME_UNAVAILABLE`; no Realtime subscription is opened by the DR-3/DR-4 client.
- No `supabase.realtime.channel(...)` call sites in `services/dressingRoomCollaboration.ts` or `services/roomMessages.ts`.
- Realtime remains **deferred**.

## Client feature flag posture

All 12 DR flags default OFF; source-verified in [`constants/featureFlags.ts`](../../constants/featureFlags.ts). Production installed clients receive no behavior change from a backend-only DR-3/DR-4 deployment.

## Verdict

No P0, no P1 security findings in DR-3 or DR-4 source. All hostile scenarios attempted resolve to server-side denials or safe rejects. Two P2 defects (recorded in [`11_DEFECT_AND_REPAIR_LEDGER.md`](11_DEFECT_AND_REPAIR_LEDGER.md)) were repaired in this audit and did not affect production authorization or data privacy.
