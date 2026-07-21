# 02 — DR-1 Findings and Severity

## Changed-file inventory, `f73d4147..5dc0b86` (original DR-1 implementation)

```
A  __tests__/dressingRoomCanonicalItemContract.test.js
M  __tests__/dressingRoomItemContract.test.js
M  __tests__/dressingRoomSavePolicy.test.js
A  __tests__/eliseRoomItemEvidence.test.js
M  constants/featureFlags.ts
A  docs/dr1/01_DR1_BASELINE_AND_SOURCE_MATRIX.md ... 99_DR1_HANDOFF.md (8 doc files)
A  services/dressingRoomCommerce.ts
A  services/dressingRoomDedupe.ts
M  services/dressingRoomItemContract.ts
M  services/scanResultDressingRoom.ts
M  services/styleObjects.ts
M  supabase/functions/stylechat-generate/attachmentContext.ts
M  supabase/functions/stylechat-generate/attachments.ts
A  supabase/functions/stylechat-generate/eliseRoomItemEvidence.ts
M  supabase/functions/stylechat-generate/index.ts
A  supabase/migrations/20260720115423_scan_commerce_events.sql
A  types/canonicalDressingRoomItem.ts
M  types/styleObjects.ts
```

25 files changed, +1404/-38. No source file outside this list was touched by
the original DR-1 pass, and the audit repair below stayed inside it.

## Findings

### F-1 (P1, repaired) — Scan Result Object saves mislabeled as catalog products, losing Scanner provenance

**Claim affected:** "Scanner single-item mapping" / "Scan Result Object"
source adapter (Phase 3), provenance truthfulness (Phase 2), Elise
resolvability requirement #1 ("current Scanner item types can enter Dressing
Rooms consistently" / distinguishable by Elise), dedupe provenance input.

**Evidence:** `services/scanResultDressingRoom.ts::buildDressingRoomSaveSource`
built the object passed to `addProductToDressingRoom` from a
`ScanResultObject` (`scanResultObject.id` is the scan's own id — see
`types/scanResultObject.ts:102`) but never forwarded that id. Downstream,
`services/styleObjects.ts::buildProductMatchSnapshot` — the single function
that both the genuine Catalog/ProductShelf path (`components/ProductShelf.tsx`)
and the Scan Result Object path funnel through — hardcoded
`kind: 'catalog_product'` in its call to `buildCanonicalSnapshotExtension`
regardless of caller, and never accepted a `scanId`. As a result, when a user
saved the primary product match from an actual Scanner scan, the canonical
`source.kind` was written as `'catalog_product'` with `source.scanId = null`,
identical to a purely browsed catalog item added from `ProductShelf`. Once
`DRESSING_ROOM_CANONICAL_ITEM_V1` activates, Elise and any future
provenance-aware surface would be unable to tell "the user's own scanned
garment, matched to this product" apart from "a product the user browsed and
added," and the item's dedupe computation had no scan identity to draw on.

**Why P1, not P0:** no cross-account exposure, no authorization bypass, no
data loss — this is a provenance/labeling defect confined to metadata that is
currently inert behind flags that default OFF (`docs/dr1/02_DR1_CANONICAL_ITEM_CONTRACT.md`).
It matches the addendum's explicit P1 example "inconsistent source adapters
producing incompatible room items."

**Repair:** `types/styleObjects.ts` gained optional
`scanId?`/`selectedItemId?`/`kind?` passthrough fields on
`ProductMatchSnapshotSource`. `scanResultDressingRoom.ts` now sets
`scanId: scanResultObject.id` and `kind: 'scanner_single'` on the built
source. `styleObjects.ts::buildProductMatchSnapshot` now only accepts
`kind: 'scanner_single'` when a real `scanId` is also present (a bare `kind`
claim without a `scanId` cannot spoof scanner provenance — locked in by a
dedicated regression test); otherwise it falls back to the original
`'catalog_product'` behavior, so the genuine Catalog/ProductShelf path is
provably unaffected (regression test asserts `kind === 'catalog_product'` and
`scanId === null` for a plain catalog source with no `scanId`/`kind` fields).

**Regression coverage:** 5 new tests across
`__tests__/dressingRoomSavePolicy.test.js` (3) and
`__tests__/scanResultActivation.test.js` (1, plus the file's 12 pre-existing
tests re-verified), plus the 155-test run across every file that imports a
touched module.

**Disposition:** REPAIRED AND VERIFIED.

### F-2 (informational, no repair) — Test-execution blocker was environmental, not a source defect

`node --test` on the DR-1 focused suite initially failed with
`Cannot find module 'typescript'` because this sandbox's mounted
`node_modules` is unpopulated (`npm install` also failed in-place with an
`EPERM: operation not permitted, unlink node_modules` error from the FUSE
mount). This blocked Phase 13 test execution until resolved. Resolution:
installed `typescript@~5.9.2` (the only external module any DR-1 test file
`require()`s — confirmed by grep across all four DR-1 test files) into a
scratch directory outside the mounted worktree and pointed `NODE_PATH` at it
for test runs. No repository file was changed to achieve this; it is a
sandbox/environment condition, not a DR-1 source or test defect.

**Disposition:** EXTERNAL GATE — NOT SOURCE-REPAIRABLE (worked around for this
audit's own test execution; the user's normal development machine has a
working `node_modules` and does not need this workaround).

### F-3 (informational, no repair) — Public shared-room preview does not expose commerce fields

`get_public_room_preview` (unchanged by DR-1;
`supabase/migrations/20260718151651_...sql`) returns a tightly bounded field
list (`id`, `sourceType`, `imageUrl`, `imageWidth/Height`, `category`,
`color`, `silhouette`, `title`) with `imageStorageBucket`/`imageStoragePath`
hardcoded to `null` and no `purchaseOptions`/`snapshot_payload`/owner id in
the output. This is a safe, bounded read (no leak), but it also means
purchase options never reach the public preview at all — pre-existing
behavior, not something DR-1 introduced or broke, and outside DR-1's declared
file-change footprint (Dressing Rooms/Elise redesign is explicitly out of
this audit's authority). Documented, not repaired.

### F-4 (informational, no repair) — Account-deletion cascade already covers everything DR-1 touches

`scripts/process-deletion-request.js` (unchanged by DR-1) already enumerates
every Dressing-Room-adjacent table (`dressing_rooms`, `dressing_room_items`
via parent-room cascade, `dressing_room_inspiration_items`,
`dressing_room_item_reactions`, `dressing_room_messages`,
`dressing_room_participants`, `shared_room_memberships`, `room_shares`) plus
`saved_scans`, `inspiration_items`, and the `style-library-images` storage
prefixes, with a thoughtful shared-room-ownership-transfer policy so deleting
one participant doesn't destroy other users' data. DR-1's only new table,
`scan_commerce_events`, carries no `user_id` (anonymous telemetry) and needs
no cascade entry. No gap found; no change made.

**Disposition:** PASS — verified from source, no repair required.

### F-5 (informational, no repair) — `shared_room_item` Elise evidence kind is prepared but correctly unreachable

`eliseRoomItemEvidence.ts::evidenceKindForOwnedAttachmentSource` maps a
`'shared_room_item'` string to a `shared_room_item` evidence kind, but the
client-facing attachment parser (`attachments.ts::isOwnedSourceType`) only
accepts `'saved_scan' | 'inspiration_item' | 'dressing_room_item'` — a
client-supplied `sourceType: 'shared_room_item'` is rejected at parse time
with `ATTACHMENT_INVALID` before it ever reaches evidence resolution. This
confirms the original DR-1 doc's claim that shared-room evidence is "not
fully wired into StyleChat attachments in this pass" is accurate and fails
closed rather than silently trusting an unverified claim.

**Disposition:** PASS — verified, matches documented client-activation gate.

## Severity summary

| Severity | Count | Disposition |
| -------- | ----- | ----------- |
| P0 | 0 | none found |
| P1 | 1 (F-1) | REPAIRED AND VERIFIED |
| P2 (source-repairable, DR-1-scoped) | 0 confirmed | none found within the boundary this audit could exercise (see limitations in `01_DR1_HOSTILE_AUDIT_OVERVIEW.md`) |
| Informational / external gate | 4 (F-2..F-5) | documented, no repair required or possible from this sandbox |
