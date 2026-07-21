# Cross-feature regression audit

## Scanner

- `__tests__/scanCommerceRouter.test.js` — PASS
- `__tests__/textScanCanonicalPath.test.js` — PASS
- Scanner provenance survives every DR-1 canonical adapter; scan results converted to room items retain `scanId` and cannot be spoofed by stray `kind` value (test verified).
- No DR-3/DR-4 change modifies Scanner input or output surfaces.
- Verdict: **regression-free**.

## Recent Scans

- Save/reload paths unchanged by DR-3/DR-4.
- DR-1 canonical adapter preserves stable source identity across reopen (tests verified).
- Verdict: **regression-free**.

## Closet / Library

- `__tests__/ownedClosetItemContract.test.js` — PASS.
- No new DR change touches Library storage paths; Closet items convert to room items via the DR-1 adapter with stable source kind.
- Verdict: **regression-free**.

## Shared With Me

- `__tests__/sharedWithMeListLogic.test.js`, `__tests__/sharedWithMeListUi.test.js`, `__tests__/sharedRoomMemberships*.test.js` — PASS.
- Shared list retrieval unchanged by DR-3/DR-4.
- Post-DR-3 deployment, revoked/expired participants will lose read access to shared rooms even via legacy table paths — this is the intended security tightening.
- Verdict: **regression-free** (with security improvement noted).

## Elise / StyleChat

- `__tests__/elise*.test.js` (14+ files) — all PASS after the P2 test-loader repair recorded in [`11_DEFECT_AND_REPAIR_LEDGER.md`](11_DEFECT_AND_REPAIR_LEDGER.md).
- Attachment surface, visual context redaction, and provider fallback contract intact.
- Advice metadata passthrough gated by `ELISE_ADVICE_METADATA_CLIENT_V1` (default OFF).
- Verdict: **regression-free** after repair.

## Commerce

- Purchase options, retailer, price, currency, direct URL, and affiliate URL survive DR-1 adapter; no DR-3/DR-4 change writes to snapshot payload.
- Direct/affiliate URLs remain in commerce layer only; Elise attachment surface sends IDs, not URLs — no leakage into model prompt text (SOURCE VERIFIED at `services/style-chat/providers/edgeStyleChatProvider.ts`).
- Verdict: **regression-free**.

## Authentication + lifecycle

- Actor-generation checks (`bumpCollabActorGeneration`, `isCurrentCollabGeneration`) fire on every session read.
- Logout / account switch during in-flight RPC surfaces `ROOM_MESSAGES_STALE_ERROR` (not silently applies to another actor).
- No DR change alters the auth session refresh path.
- Verdict: **regression-free**.

## Public preview + share links

- `get_public_room_preview` is not modified by DR-3 or DR-4.
- Share tokens gate participant creation via SECURITY DEFINER RPC (pre-DR).
- Revocation via `revoke_room_share` bumps access version and marks all shares inactive; historical messages/reactions preserved.
- Public preview never selects, joins, or returns message bodies (SOURCE VERIFIED: no DR-3/DR-4 SQL edits touch `get_public_room_preview`).
- Verdict: **regression-free**.

## Old installed clients

- Old clients writing directly to `dressing_room_messages` will continue to succeed if they are authorized (owner or active-share participant). The DR-3 `can_access_room_messages` tightening is stricter than the pre-DR helper it replaces, meaning some old clients who could previously insert as revoked/expired participants will now fail — this is the intended security fix.
- No new NOT NULL column added to `dressing_room_messages` (client_message_id and parent_message_id are nullable). Legacy clients omitting these fields continue to insert successfully.
- New RPCs are additive; older clients simply don't call them.
- Verdict: **backward compatible** (with security tightening documented above).

## Account deletion + export

- `dressing_room_collab_idempotency` registered in `scripts/process-deletion-request.js` `USER_DATA_RESOURCES` with `optional: true` (SOURCE VERIFIED at line 22).
- `elise_generation_operations` was NOT registered pre-audit; repaired in this audit (see [`11_DEFECT_AND_REPAIR_LEDGER.md`](11_DEFECT_AND_REPAIR_LEDGER.md)).
- Test `USER_DATA_RESOURCES covers all user-linked tables in migrations` now PASS.
- Actual auth cascade unaffected (FK is `on delete cascade`), so the pre-audit gap was reporting-only, not data-loss.
- Verdict: **regression-free after repair**.

## Website vs backend authorization

- Website repository at `C:\Users\jsmit\kscan-website` is out of the audit worktree; not modified.
- `join_room_via_share_token` is pre-DR SQL, unchanged. Website read-side preview does not depend on collaboration RPCs.
- DR-3/DR-4 deployment does not broaden the anonymous-write surface: all new RPCs `revoke ... from anon`.
- No new conflict identified with existing website access model.
- Verdict: **no observed conflict**.
