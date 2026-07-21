# 05 — DR-1 Elise Evidence Compatibility

## Owned room items

StyleChat attachments now accept `sourceType: 'dressing_room_item'`.

Server resolution (`attachmentContext` + `index.ts`):

- Loads `dressing_room_items` only for rooms owned by `auth.uid()`
- Maps to bounded evidence via `dressingRoomItemToEvidence`
- No raw snapshot, storage path, or purchase URLs in model text
- Media refs private for multimodal selection only

Helpers: `eliseRoomItemEvidence.ts` (`owned_room_item` / `shared_room_item` kinds).

## Shared room items

Server-authoritative shared resolution (share token / membership) is **not** fully wired into StyleChat attachments in this pass.

**Client activation gate:** next mobile build must send dressing-room item refs; shared evidence requires approved share/membership checks before attach.

## Current-client behavior

Installed clients that only send `saved_scan` / `inspiration_item` attachments are unchanged.
