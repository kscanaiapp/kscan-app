# Scan Result Object + Style Memory

Status: **Part 1 — Foundation (data models + pure helpers only).**
Branch: `feature/scan-result-style-memory-v1`.

This system turns every scan into structured fashion metadata plus a
result-card-ready object that can later be **saved, shared, and compared**. It is
the connective tissue of K-SCAN's scan-first wedge:

> physical inspiration → structured fashion intelligence → product matches →
> save / share / compare → conversion

It deliberately borrows the strongest digital-closet behaviors (saveable cards,
compare, light tagging) **without** becoming a generic closet app or a social
feed.

---

## What's in Part 1

Pure, side-effect-free TypeScript only. No persistence, no Supabase table, no UI
redesign, no real sharing.

- `types/scanResultObject.ts` — the type contracts.
- `services/scanResultObject.ts` — the pure helpers.
- `__tests__/scanResultObject.test.js` — focused coverage.

### `ScanResultObject`

The canonical normalized result. Built by `createScanResultObject(input, options?)`
from the **existing** `ScanIdentifyResponse` / mapped-analysis shape — it does
not assume a new scan response contract. Shape:

- `id`, `createdAt`, `userId` (`string | null`), `source`
  (`camera | upload | room | unknown`)
- `privacy` — `{ piiMasked, rawImageStored: false, cloudPhotoStorage: false, notes }`
  (the two image flags are typed as the literal `false` so they can't be flipped on)
- `item` — `category, subcategory, silhouette, color, material, pattern, fit,
  occasionTags, styleTags, confidence`
- `visual` — `cardTitle, cardSubtitle, heroImageUrl, palette, badges`
- `matches` — reuses the existing `RankedScanProduct[]` (no parallel product type)
- `memory` — `{ saved, comparedWithIds, sharePayloadReady, notes?, userTags }`
- `explainability` — `{ whyThisMatched, missingSignals, confidenceLabel }`

### `ResultCardViewModel`

A render-ready projection (`createResultCardViewModel`): `title, subtitle,
heroImageUrl, badges, confidenceLabel, primaryMatch, matchCount, saveEnabled,
shareEnabled, compareEnabled, privacyCaption`. Default privacy caption:
**"Saved as style metadata, not a raw photo."** Part 1 renders this nowhere.

### `StyleMemoryItem`

A **metadata-only** memory record (`createStyleMemoryItem`): the thing a future
Save action would persist. Carries `item`, `visual`, `matches`, `userTags`,
`notes`, `source: 'scan'`, `privacy`, and an optional `savedToDressingRoomId`
back-reference. **Not persisted in Part 1.**

> Naming note: a separate "Style Memory" already exists under
> `services/style-chat/styleMemoryTypes.ts` — that models StyleChat *preference
> signals* (color/brand/budget). `StyleMemoryItem` here is a distinct
> scan-result card model. The two are intentionally separate concepts and do not
> share a table.

### `compareScanResults(a, b)`

Pure metadata comparison of two `ScanResultObject`s — no DB, no history loading.
Returns `similarityScore` (0..1 weighted overlap), `sharedCategories`,
`sharedColors`, `sharedMaterials`, `sharedStyleTags`, `sharedOccasionTags`,
`differences`, and a human `summary` (e.g. _"Both scans lean minimalist
outerwear, but differ in color and material."_).

### `createShareReadyPayload(scanResultObject)`

Returns only safe fields: `id, createdAt, item, visual, matches`. Excludes
`userId`, `privacy`, `memory` notes, auth/session data, and anything PII or
raw-image related. **Actual sharing requires deep-link and backend
share-resolution infrastructure and is deferred to Part 2 or later** — this
returns data only.

---

## Privacy: why raw images are excluded

Style Memory stores **structured fashion metadata and safe catalog/product
references only.** It must never store:

- the raw scan image or unmasked user photo
- a local camera URI / captured-image URI
- faces, background people, license plates
- geolocation, biometric identifiers, or private screenshot content

Enforcement in `services/scanResultObject.ts`:

- `heroImageUrl` is resolved **only** from an allow-list of catalog/product
  image keys (`imageUrl, image_url, thumbnail, thumbnailUrl, image_src,
  product_image_url`) on a `recommendedProducts` entry, and must be an
  `https?://` URL.
- A hard **blocklist** (`localImageUri, capturedImageUri, rawImageUri, uri,
  localUri, photoUri, cameraUri, …`) is never read for the hero image.
- Catalog/product image URLs are allowed because they come from
  retailer/catalog match data — not from the user's raw capture.

---

## Why compare is pure metadata for now

Compare operates on two in-memory `ScanResultObject`s passed directly. It loads
no history and queries no database, so it stays trivially testable and carries no
persistence or privacy surface. A future "compare against my saved scans" UI can
feed it objects rehydrated from the Dressing Room save path.

---

## Why mapper integration is deferred (Part 1)

The intended optional integration point is
`services/scanIdentificationMapper.ts` (add a non-breaking optional
`scanResultObject` field). It is **deferred** because integrating it requires a
*runtime* import of `services/scanResultObject.ts` into the mapper, which breaks
the existing VM-sandboxed test that loads the mapper with **type-only imports and
no requireMap** (`Unexpected require`). The helpers are therefore exported
standalone and the accuracy-critical mapping / ranking / confidence path is left
completely untouched.

Verdict tag: `INTEGRATION_DEFERRED_TYPE_SAFETY`.

---

## How this avoids Dressing Room duplication

The existing save system lives in `services/styleObjects.ts`
(`addProductToDressingRoom`, `addScanImageToDressingRoom`,
`buildProductMatchSnapshot`) with snapshot versioning and the
`dressing_rooms` / `dressing_room_items` tables. Part 1 adds **no** save logic
and **no** table — it only produces data models.

When save lands in Part 2 it must **extend or wrap** the Dressing Room path, not
create a parallel save/memory system:

- A scan Save action builds a `StyleMemoryItem` (metadata) and then calls the
  existing Dressing Room save path for the underlying product/scan snapshot.
- `StyleMemoryItem.savedToDressingRoomId` links the memory metadata to the
  Dressing Room item the existing path creates.
- No new "saved scans" table is introduced unless the save path proves it needs
  one, and only then as an explicitly named, owner-approved draft migration.

---

## Part 2 — Activation Later (requires explicit owner approval)

Do not implement until the owner approves after the Part 1 report.

1. Validate real-device scans.
2. Validate the existing Dressing Room save path.
3. Wire the Save action to create `StyleMemoryItem` metadata.
4. Attach the saved result to an existing Dressing Room item or room
   (`savedToDressingRoomId`).
5. Add result card UI (render `ResultCardViewModel`).
6. Add compare UI.
7. Add share / deep-link infrastructure (ShareSheet, Android Intent, backend
   share-resolution endpoint, deep-link generation, Open Graph metadata).
8. Consider a Supabase schema extension **only after** the save path is proven —
   as a draft migration, never auto-deployed.

Part 2 must extend/wrap Dressing Rooms. It must not create a parallel
save/memory system, a duplicate Dressing Room, or a general social feed.
