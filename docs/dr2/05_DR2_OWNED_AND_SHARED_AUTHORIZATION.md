# DR-2 Owned and Shared Authorization

## Owned room attachment
`{ attachmentType: "owned_item", sourceType: "dressing_room_item", sourceId: <uuid> }`
- Auth → parse → UUID → room.user_id = auth.uid → item in room → bounded evidence.
- Miss → generic `ATTACHMENT_NOT_OWNED` (no existence leak).
- Gated by `ELISE_DRESSING_ROOM_ATTACHMENTS_V1` (default OFF).

## Shared room attachment
`{ attachmentType: "shared_item", sourceType: "shared_room_item", sourceId: <uuid> }`
- Unified resolver: `eliseSharedRoomAccess.ts` + `fetchSharedDressingRoomItems`.
- Requires: recipient membership, active share, not revoked/expired, share.owner_id == room.user_id, item in that room.
- Membership alone insufficient; public tokens ignored; owner-as-recipient rejected as shared.
- Gated by `ELISE_SHARED_ROOM_EVIDENCE_V1` (default OFF).

Hostile cases covered in `dr2SharedAuthorization.test.ts`.
