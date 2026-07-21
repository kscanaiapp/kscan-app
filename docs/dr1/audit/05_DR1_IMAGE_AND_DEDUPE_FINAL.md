# 05 — DR-1 Image Identity and Dedupe (Final)

## Image identity

Module: `services/dressingRoomItemContract.ts::resolveDressingRoomImageSource`.

Priority, verified by reading the function body directly:

1. `storageBucket` + `storagePath` both present → `{ kind: 'storage' }`
   (checked first; no re-upload when a durable reference already exists).
2. Else `imageUrl` matching `^https?:\/\//i` → `{ kind: 'remote' }`, **unless**
   it matches `/\/storage\/v1\/object\/sign\//i`, in which case it is treated
   as `{ kind: 'none' }` — a signed Supabase URL can never become the
   persisted identity, closing the "signed URL persisted as identity" attack
   case directly in code (not just by convention).
3. Else `localUri` matching `^(file|content|asset|ph):\/\//i` →
   `{ kind: 'local' }`.
4. Else `{ kind: 'none' }` — surfaced to the caller as a explicit,
   user-facing "can't be added yet" error (`UnsupportedStyleObjectItemError` /
   `describeMissingImageReason`) rather than a silently broken row.

`addScanImageToDressingRoom` writes storage bucket/path **XOR** a remote
`image_url` — confirmed by `__tests__/styleObjectsContract.test.js`'s test
"writes image_url XOR storage_bucket+storage_path, never both, so the
shared-room read-side priority cannot conflict," which passed in this audit's
rerun. This is the same invariant the shared-room read side
(`shared-room-image-url`, deployed production version 6, unchanged by DR-1)
depends on.

`buildProductMatchSnapshot` (the product/catalog/Scan-Result-Object path)
requires `isRemoteImageUrl(imageUrl)` and throws
`UnsupportedStyleObjectItemError` otherwise — a local/raw/captured URI can
never reach this path's `image_url` column, and `scanResultDressingRoom.ts`'s
own doc comment plus a dedicated existing test
("save bridge never uses raw/local/captured image as the saved image")
confirm a Scan Result Object save with only local/raw image fields yields no
saveable source at all.

## Dedupe

Module: `services/dressingRoomDedupe.ts::computeDressingRoomDedupeKey`.
Verified precedence, in order, each requiring the room id:

1. `scan_id + selected_item_id` (highest)
2. `saved_scan_id`
3. `inspiration_item_id`
4. `provider_product_id` (canonical product identity)
5. `storage_bucket + storage_path` (storage object identity)
6. `image_digest`
7. `request_idempotency_key`
8. else no key (item is written without dedupe short-circuiting)

All identity inputs are lowercased/trimmed before hashing, so casing
differences never produce false negatives. Retailer and variant are
deliberately **not** part of the item-level dedupe key: the dedupe key
identifies "is this the same *item* already in this room," while distinct
retailer offers for that same item are carried as multiple entries inside
`commerce.purchaseOptions` on the one item — this is correct by the
architecture (an item is not re-created per retailer), and is exactly why the
commerce module's own exact-duplicate-offer fingerprint (see
`04_DR1_COMMERCE_CONTINUITY_FINAL.md`) — not the item dedupe key — is
responsible for not collapsing genuinely different offers.

`findExistingRoomItemByDedupe` (`services/styleObjects.ts`) scans the most
recent 40 items in the target room, compares each item's stored
`canonical.dedupeKey`, and falls back to a `source_type` + `source_id` match
when no canonical key is present on older rows — old items without a dedupe
key are simply not merge-candidates (never a false merge), and a second
identical request lands on the same key deterministically.

**Retry safety:** the dedupe check runs before the insert count/lookup and
before the `.insert()` call in both write functions; a second identical
request (same scan/selected item, same saved scan, same product, same
storage object) computes the same key and returns the existing row instead of
inserting again, when `DRESSING_ROOM_DEDUPE_V1` is on. With the flag off, no
dedupe check runs and retries can create duplicates — this is documented,
unchanged, pre-DR-1 behavior gated by the flag, not a regression.

## Verdict for this section

Image identity priority and dedupe precedence: **confirmed as implemented**,
including the specific attack cases (signed-URL-as-identity, storage/remote
conflict via XOR write, cross-retailer/cross-variant false-merge) checked
above.
