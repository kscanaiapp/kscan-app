# 06 — DR-1 → Elise E-4 Handoff Contract

This is the exact, noninterpretive contract E-4 should build against.

## Canonical type paths

- Item: `types/canonicalDressingRoomItem.ts` → `CanonicalDressingRoomItem`
  (`schemaVersion = 1`).
- Purchase option: same file → `CanonicalPurchaseOption`.
- Adapters: `services/dressingRoomItemContract.ts` (image resolution,
  provenance/source building), `services/dressingRoomCommerce.ts` (commerce
  normalization), `services/dressingRoomDedupe.ts` (dedupe key).
- Write paths: `services/styleObjects.ts::addProductToDressingRoom` and
  `::addScanImageToDressingRoom` — the only two functions that insert into
  `dressing_room_items`.

## Supported source kinds (`CanonicalItemSourceKind`)

`scanner_single`, `scanner_selected_item`, `scanner_multi_item`, `textscan`,
`saved_scan`, `closet_item`, `catalog_product`, `inspiration_item`,
`dressing_room_item`, `shared_room_item`, `product_match`, `scan_image`,
`live_scan`, `style_library_scan`, `upload_inspiration`. Legacy `sourceType`
strings map onto this set via `mapLegacySourceKind`
(`services/dressingRoomItemContract.ts`). Post-audit-repair, a Scan Result
Object primary-match save resolves to `scanner_single` with a real `scanId`
(previously mislabeled `catalog_product` — see finding F-1).

## Provenance / actor-relationship values

`source.kind` is the provenance signal; there is no separate
"actor-relationship" enum in the current schema. E-4 should treat
`catalog_product` / `product_match` as **discovered, not owned**;
`scanner_single` / `scanner_selected_item` / `scanner_multi_item` / `textscan`
/ `live_scan` / `scan_image` as **the user's own scanned garment**;
`saved_scan` / `style_library_scan` / `closet_item` as **owned Closet/Saved
Scan items**; `inspiration_item` / `upload_inspiration` as **owner-uploaded
reference imagery, never commerce**; `dressing_room_item` /
`shared_room_item` as **an already-persisted room item being referenced**,
where `shared_room_item` additionally requires a verified share/membership
check server-side (not yet wired — see gates below).

## Image priority

1. Owner-scoped Supabase Storage `storageBucket` + `storagePath` (durable,
   private; source of truth once uploaded).
2. Approved remote HTTPS URL (never a signed `/storage/v1/object/sign/` URL —
   explicitly rejected in code).
3. Device-local `file|content|asset|ph://` URI (never durable; only valid
   on-device, uploaded on next save if still needed).
4. Explicit `none` — no image; callers must handle this rather than assume a
   renderable URL always exists.

## Commerce fields (`CanonicalPurchaseOption`)

`title`, `retailer`, `price`, `currency`, `productUrl`, `affiliateUrl`,
`imageUrl`, `availability`, `size`, `variant`, `matchScore`, `confidence`,
`provider`, `productId`. All strings are length-bounded and control-character
stripped; `productUrl`/`affiliateUrl`/`imageUrl` are HTTPS-only. Array bounded
to 24 entries, first-seen retailer order preserved, exact-duplicate offers
deduplicated. **Not currently exposed through the public/shared-room preview**
(pre-existing limitation, see `04_DR1_COMMERCE_CONTINUITY_FINAL.md`) — E-4
must not assume commerce is visible to a non-owner viewing a shared preview.

## Dedupe precedence (item-level, not offer-level)

`scan_id+selected_item_id` → `saved_scan_id` → `inspiration_item_id` →
`provider_product_id` → `storage_object` → `image_digest` →
`request_idempotency_key` → none. See
`05_DR1_IMAGE_AND_DEDUPE_FINAL.md` for full detail.

## Stable IDs available to E-4 today

- `dressing_room_items.id` (uuid, stable) — the only id `stylechat-generate`'s
  attachment resolver accepts for a room item (`sourceType:
  'dressing_room_item'`).
- `saved_scans.id`, `inspiration_items.id` — already-wired owned-item source
  types.
- `snapshot_payload.canonical.source.scanId` / `.selectedItemId` /
  `.savedScanId` / `.inspirationItemId` / `.providerProductId` — provenance
  identifiers recorded inside the item's own snapshot, readable once the item
  is already resolved; **not** independently queryable/indexed identifiers
  (no DB column, no index) — do not build a lookup path keyed on these
  without adding one.

## Evidence resolver interfaces

- `supabase/functions/stylechat-generate/attachments.ts::parseStyleChatAttachments`
  — parses client-supplied attachment refs; only
  `sourceType ∈ {saved_scan, inspiration_item, dressing_room_item}` are
  accepted at all (UUID-validated); anything else, including
  `shared_room_item`, is rejected with `ATTACHMENT_INVALID` before resolution.
- `supabase/functions/stylechat-generate/attachmentContext.ts::resolveStyleChatAttachments`
  — resolves parsed refs against the database via an injected
  `AttachmentDataSource`. For `dressing_room_item`, the real implementation
  (`index.ts`, `fetchDressingRoomItems`) first loads
  `dressing_rooms` filtered to `user_id = auth.uid()`, then loads
  `dressing_room_items` filtered to `dressing_room_id IN (owned room ids)` —
  ownership is resolved server-side from the authenticated session, never
  from client-supplied metadata. A miss (foreign, deleted, or nonexistent)
  returns one generic `ATTACHMENT_NOT_OWNED` error so existence never leaks.
- `supabase/functions/stylechat-generate/eliseRoomItemEvidence.ts` — pure
  helpers: `evidenceKindForOwnedAttachmentSource` (maps sourceType →
  `owned_room_item` / `shared_room_item`; the latter is currently
  unreachable from the request pipeline, see gates below) and
  `sanitizeRoomItemEvidenceFields` (bounds title/brand/category/color/
  silhouette/purchaseOptionCount for model text).

## Allowed model-grounding fields

Per `dressingRoomItemToEvidence` / `describeItem`
(`attachmentContext.ts`): `title`, `category`, `role` (inferred), `color`,
`pattern`, `material`, `silhouette`, `fit`, `brand`, `styleTags` (≤6, ≤24
chars each), and an opaque `ref: { sourceType, sourceId }` action anchor. A
private `media: { bucket, path }` reference is attached for multimodal
image selection only — **never** rendered into the text context block.

## Forbidden fields — must never enter Gemini / model text

User ids, storage bucket/path as a literal string in text (media refs are a
structured private field only), signed URLs, raw `snapshot_payload` /
`analysis_result` blobs, purchase URLs / affiliate URLs / full purchase
option arrays (only `purchaseOptionCount`, a bounded integer, is allowed via
`sanitizeRoomItemEvidenceFields`), share tokens, Style Memory history. This
was verified directly in `attachmentContext.ts`'s module doc-comment and
confirmed by the passing test "attachmentContext wires owned dressing room
item fetch without commerce leakage."

## Public preview fields

`get_public_room_preview` (unchanged by DR-1) returns only: `id`, `sourceId`,
`sourceType`, `imageUrl` (already-public HTTPS only), `imageWidth/Height`,
`category`, `color`, `silhouette`, `title`; storage bucket/path fields are
hardcoded `null` in the response. No commerce, no owner id, no snapshot
payload.

## Client activation gates (explicitly separated from backend readiness)

1. **Full `purchaseOptions` arrays on scan→room saves from the UI** — the
   backend/service layer accepts and normalizes them today; the mobile client
   does not yet send them on every save path.
2. **`SAVED_SCAN_CLOUD_IMAGES_V1`** — next-build-only; do not enable for
   current testers.
3. **Shared-room evidence attach path** — `shared_room_item` sourceType is
   defined in the evidence-kind helper but rejected at the attachment parser
   today (fails closed, does not silently trust a client claim); wiring a
   verified share/membership check into `resolveStyleChatAttachments` is
   required before this can activate, and is DR-2/E-4 work, not DR-1.
4. **Emitting dressing-room item attachment refs to Elise from the UI** — the
   backend resolver is ready; the current mobile client does not yet send
   `sourceType: 'dressing_room_item'` attachments.

## Direct answers to the ten required questions

1. **Owned Closet item:** attach `{ attachmentType: 'owned_item', sourceType:
   'inspiration_item' | 'saved_scan', sourceId: <uuid> }` (Closet today is
   backed by Saved Scans / inspiration items in this schema; there is no
   separate `closet_item` table wired into the resolver yet). Server resolves
   via `fetchSavedScans`/`fetchInspirationItems`, both filtered to
   `user_id = auth.uid()` and `deleted_at is null`.
2. **Saved Scan:** `{ attachmentType: 'owned_item', sourceType: 'saved_scan',
   sourceId: <uuid> }`; resolved via `fetchSavedScans` (owner + not-deleted
   scoped).
3. **Owned room item:** `{ attachmentType: 'owned_item', sourceType:
   'dressing_room_item', sourceId: <uuid> }`; resolved via
   `fetchDressingRoomItems`, which joins through `dressing_rooms.user_id =
   auth.uid()` before selecting the item — available today, backend-ready.
4. **Shared room item:** not available today. `shared_room_item` is rejected
   at the parser boundary; requires a new, server-verified share/membership
   check wired into the resolver before any client can send it (client
   activation gate #3 above, and a DR-2/E-4-scope backend change).
5. **Distinguishing owned / saved / scanned / shared / commerce:** by
   `source.kind` in the canonical snapshot (see provenance table above) for
   already-persisted room items, or by the attachment `sourceType` for
   in-flight StyleChat references. `catalog_product`/`product_match` = 
   discovered/commerce, never owned; `scanner_*` = the user's own scan;
   `saved_scan`/`closet_item` = owned Closet; `shared_room_item` = shared
   (not yet resolvable, see #4).
6. **Purchase options exposed safely:** never as raw URLs/arrays in model
   text — only a bounded `purchaseOptionCount` integer via
   `sanitizeRoomItemEvidenceFields`. Any richer commerce surfacing to the
   model requires new, explicit sanitization — do not read
   `snapshot_payload.purchaseOptions` directly into a prompt.
7. **Identifiers current clients already send:** `saved_scan` and
   `inspiration_item` attachment refs (StyleChat v2 contract, pre-DR-1).
   `dressing_room_item` refs are accepted by the backend today but not yet
   sent by the installed client (client activation gate #4).
8. **Identifiers requiring the next mobile build:** `dressing_room_item`
   StyleChat attachment refs (backend ready, client not yet sending them);
   full `purchaseOptions` arrays on scan→room saves; any
   `SAVED_SCAN_CLOUD_IMAGES_V1`-dependent image reference.
9. **Image fields E-4 may use:** the private `media: { bucket, path }`
   reference returned per resolved item, for multimodal image selection only
   — never as literal text in the prompt, never a signed URL persisted as
   identity.
10. **Fields that must never enter Gemini:** see "Forbidden fields" above —
    user ids, storage paths as text, signed URLs, raw snapshot/analysis
    blobs, purchase/affiliate URLs, full purchase option arrays, share
    tokens, Style Memory history.

## Known remaining gaps for E-4 to plan around

- Shared-room evidence (item #4 above) needs new backend wiring, not just a
  client change.
- Public/shared preview carries no commerce data by design today; if E-4
  needs commerce-aware sharing, that is new scope, not a DR-1 gap to reopen.
- `snapshot_payload.canonical.source.*` identifiers are not independently
  indexed columns — do not build a cross-item lookup keyed on them without
  adding a migration.
