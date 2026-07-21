# DR-2 Canonical Contract Integration

Authoritative DR-1 paths preserved:
- `types/canonicalDressingRoomItem.ts`
- `services/dressingRoomItemContract.ts`
- `services/dressingRoomCommerce.ts`
- `services/dressingRoomDedupe.ts`
- `services/styleObjects.ts`

Separation enforced in `roomItemRelationship()`:
- catalog/product_match → `saved` (never owned)
- scan kinds → `scanned`
- inspiration/saved → `saved`
- explicit owned kinds → `owned`
- unknown → `unverified`
- shared retrieval path → `shared`

Shared items use `attachmentType: shared_item` / `sourceType: shared_room_item` — never `owned_item`.
