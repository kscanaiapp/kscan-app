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

---

## Part 2 — Activation (IMPLEMENTED on `feature/scan-result-style-memory-activation-v1`)

Status of each activation goal:

| Goal | Status |
| --- | --- |
| Mapper integration | **Completed** |
| Result card UI | **Completed** (additive, gated) |
| Dressing Room save bridge | **Completed** (wraps existing path) |
| Metadata persistence | **Deferred** — `METADATA_PERSISTENCE_DEFERRED_SCHEMA_STRICT` |
| Share action | **Completed** (text-only, RN built-in) |
| Compare | **Deferred** — `COMPARE_UI_DEFERRED_NEEDS_SAVED_SCAN_METADATA` |

### Mapper integration (completed)

`services/scanIdentificationMapper.ts` now attaches an optional
`scanResultObject` to the `completed` `MappedFashionAnalysis`, generated via
`createScanResultObject` from the same `identification` / `attributes` /
`recommendedProducts` it already produced. It is wrapped in `try/catch` so a
failure degrades safely (field omitted) and never alters the existing
`result` / `metadata` / `products` / `displayResult` contract, ranking, or
confidence scoring. The VM-sandboxed mapper test
(`__tests__/scanIdentification.test.js`) supplies `services/scanResultObject.ts`
through the loader `requireMap` — resolving the Part 1 `INTEGRATION_DEFERRED_TYPE_SAFETY`
deferral.

`hooks/useKScan.js` sets `analysis = mapScanIdentifyToAnalysis(...)`, so the
field flows straight to the result UI as `analysis.scanResultObject`.

### Result screen + card activation (completed)

**Exact result screen:** `app.js` (the Expo Router root scan route). It renders
`AnalysisCard` by default (the `ScanResultV2` path is behind the off-by-default
`EXPO_PUBLIC_SCAN_RESULTS_V2_UI` flag and is out of scope here). `AnalysisCard`
renders `ProductShelf` internally inside its `ScrollView`.

`components/scan/ScanResultCard.tsx` renders `createResultCardViewModel(...)`
(title, subtitle, safe catalog hero image, badges, confidence label, match
count, privacy caption, Save / Share / Compare). It is rendered **inside
`AnalysisCard`, directly above the product shelf**, and only when
`analysis.scanResultObject` is present — otherwise the UI is byte-for-byte
unchanged. `app.js` passes `scanResultObject={analysis?.scanResultObject ?? null}`.

### Dressing Room save bridge (completed)

`services/scanResultDressingRoom.ts` wraps the existing
`addProductToDressingRoom` (services/styleObjects.ts), reusing the pure
`normalizeForSnapshot` mapper:

- `selectPrimaryMatch` / `buildDressingRoomSaveSource` map the top product match
  to the exact `ProductMatchSnapshotSource` the existing path accepts.
- `saveScanResultToDressingRoom` persists only the standard product match and
  returns a `StyleMemoryItem` with `savedToDressingRoomId` set to the created
  item id.
- No safe match → `NO_SAFE_PRODUCT_MATCH_TO_SAVE`.
- The raw scan-image path (`addScanImageToDressingRoom`, which uploads a local
  image) is intentionally never imported or called.

**Save UI** reuses the existing `AddToRoomModal` (now exported from
`ProductShelf`) for the primary match — no duplicate modal, no new room-selection
logic. Save is disabled with copy "Save unlocks after a product match is found."
when there is no safe catalog match.

### Metadata persistence — deferred (`METADATA_PERSISTENCE_DEFERRED_SCHEMA_STRICT`)

`buildProductMatchSnapshot` / `ProductMatchSnapshotSource` have a fixed field set
and hardcode `snapshotPayload.metadata = {}`. Extra StyleMemory metadata cannot
be attached without a schema/type change, which is out of Part 2 scope. The
`StyleMemoryItem` therefore stays in-memory for the current result, linked by
`savedToDressingRoomId`. No migration was added.

### Share action (completed)

`buildScanShareMessage` (in `services/scanResultObject.ts`) builds a text-only
message (title, subtitle, color, material, style tags, safe `https?://` product
URL) from the safe share payload. `ScanResultCard` shares it via React Native's
built-in `Share.share({ message })` — already used elsewhere
(`app/dressing-rooms/[id].tsx`), so **no new dependency**. No deep links, no
backend share endpoint, no Open Graph, no raw/local image, no userId, no notes.

### Compare — deferred (`COMPARE_UI_DEFERRED_NEEDS_SAVED_SCAN_METADATA`)

`compareScanResults` remains pure (Part 1). Compare needs *two*
`ScanResultObject`s and there is no safe in-app source of a second one yet (that
requires reading saved-scan metadata, which is the deferred persistence work).
The card renders Compare as a **disabled affordance** with copy "Compare unlocks
after another saved scan." A `compareSource` prop is in place for when a second
source exists. No new history/last-two-scans context or table was created.

### Privacy guarantees (Part 2)

- Hero image and any shared product URL come only from catalog/product match
  data; `normalizeForSnapshot` and the share resolver accept only `https?://`,
  so a raw/local/captured scan URI can never be saved or shared.
- No raw image, local camera URI, captured URI, face, person, plate,
  geolocation, biometric, private note, or auth/session data is persisted or
  shared.
- No cloud persistence beyond the existing Dressing Room product-save path; no
  new table.

### What remains for future work

1. Real-device validation of the result card + Dressing Room product save.
2. If StyleMemory metadata must persist, a draft Supabase schema (e.g. a
   snapshot-payload `metadata.styleMemory` namespace or a new column) — owner-
   approved, never auto-deployed.
3. A safe source of a second `ScanResultObject` (saved-scan metadata) to enable
   Compare UI.
4. Deep-link / backend share-resolution infrastructure for richer sharing.

**Exact result screen file:** `app.js` → `components/AnalysisCard.tsx` →
`components/scan/ScanResultCard.tsx`.
**Exact Dressing Room save path reused:** `addProductToDressingRoom` in
`services/styleObjects.ts` (via `services/scanResultDressingRoom.ts` and the
reused `AddToRoomModal`).
