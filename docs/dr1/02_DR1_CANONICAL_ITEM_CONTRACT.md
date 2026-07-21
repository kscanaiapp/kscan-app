# 02 — DR-1 Canonical Item Contract

## Type

`types/canonicalDressingRoomItem.ts`

Sections: `source`, `fashion`, `image`, `commerce.purchaseOptions`, `ownership`, `dedupe`.

`schemaVersion = 1`.

## Persistence

Prefer existing `dressing_room_items.snapshot_payload`.

When flags enable:

```json
{
  "...legacy fields...": true,
  "canonical": { "schemaVersion": 1, "source": {}, "dedupeKey": "...", "purchaseOptions": [] },
  "purchaseOptions": []
}
```

Legacy clients ignore unknown keys. No destructive rewrite of historical rows.

## Flags (default OFF)

- `EXPO_PUBLIC_DRESSING_ROOM_CANONICAL_ITEM_V1`
- `EXPO_PUBLIC_DRESSING_ROOM_COMMERCE_PRESERVATION_V1`
- `EXPO_PUBLIC_DRESSING_ROOM_DEDUPE_V1`
- `EXPO_PUBLIC_SAVED_SCAN_CLOUD_IMAGES_V1`

## Adapters

Source adapters → `dressingRoomItemContract` / `dressingRoomCommerce` → `styleObjects`  
(`addProductToDressingRoom` / `addScanImageToDressingRoom`). No parallel repository.
