# 03 — DR-1 Canonical Contract (Final, Post-Repair)

## Type

`types/canonicalDressingRoomItem.ts` — `CanonicalDressingRoomItem`,
`schemaVersion = 1`. Sections: `source`, `fashion`, `image`,
`commerce.purchaseOptions`, `ownership`, `dedupe`.

`ownership.ownerUserId` is explicitly documented in the type as "never
trusted from client for authorization; may be recorded for audit" — verified
true in every write path: `dressing_room_items` inserts never read an
owner/user id from client-supplied `source`/`scan` payloads, and every
server-side read that matters for authorization (Elise evidence,
`getDressingRoomDetail`) scopes by the authenticated session or an explicit
`dressing_rooms.user_id = auth.uid()` join.

## Persistence

Written into the existing `dressing_room_items.snapshot_payload` jsonb column
as `snapshot_payload.canonical` (schemaVersion 1) plus, when commerce is
enabled, `snapshot_payload.purchaseOptions`. No new column, no new table for
item data. Legacy rows and legacy clients are unaffected — unknown keys are
ignored by old readers, and the write only occurs when a flag is on.

## Write convergence (verified, not merely asserted)

Exactly two functions insert into `dressing_room_items`, and both route
through the canonical extension builder:

- `addProductToDressingRoom` (`services/styleObjects.ts`) → calls
  `buildProductMatchSnapshot`, which calls `buildCanonicalSnapshotExtension`
  when any of the three flags is on. Called from `components/ProductShelf.tsx`
  (genuine catalog) and `services/scanResultDressingRoom.ts` (Scan Result
  Object primary match).
- `addScanImageToDressingRoom` (`services/styleObjects.ts`) → calls
  `buildCanonicalSnapshotExtension` directly. Called from the live/upload scan
  and Style Library saved-scan save paths.

A repo-wide search confirmed there is no third `.insert()` into
`dressing_room_items` and no parallel repository/table. All other references
to `dressing_room_items` are `SELECT`s (RLS/session-scoped): reactions,
StyleChat passive-signal reads, the Elise room-item evidence fetch (explicit
`dressing_rooms.user_id = auth.uid()` join before selecting items — see
`06_DR1_ELISE_HANDOFF_CONTRACT.md`), and the public preview SQL function.

## Source kind resolution (post-repair)

`buildCanonicalSource` / `mapLegacySourceKind`
(`services/dressingRoomItemContract.ts`) map every legacy `sourceType` to one
`CanonicalItemSourceKind`. The one confirmed gap — a Scan Result Object save
always resolving to `'catalog_product'` regardless of its true Scanner origin
— was repaired in this audit pass (see `02_DR1_FINDINGS_AND_SEVERITY.md`,
F-1). Post-repair:

| Entry point | `source.kind` | `source.scanId` |
| ----------- | -------------- | ---------------- |
| `ProductShelf` → `addProductToDressingRoom` | `catalog_product` | `null` |
| Scan Result Object → `saveScanResultToDressingRoom` → `addProductToDressingRoom` | `scanner_single` | the scan's own id (`ScanResultObject.id`) |
| Live/upload scan → `addScanImageToDressingRoom` (no scanId supplied by caller) | `scanner_single` (via `mapLegacySourceKind('live_scan'/'scan_image')`) | caller-supplied only |
| Style Library saved scan → `addScanImageToDressingRoom` | `saved_scan` | n/a |

A source object cannot claim `kind: 'scanner_single'` without also supplying
a non-empty `scanId` — enforced in `buildProductMatchSnapshot` and locked in
by a regression test — closing a theoretical spoofing path where a caller
sets `kind` without real scan evidence.

## Flags (default OFF, verified in `constants/featureFlags.ts`)

- `EXPO_PUBLIC_DRESSING_ROOM_CANONICAL_ITEM_V1`
- `EXPO_PUBLIC_DRESSING_ROOM_COMMERCE_PRESERVATION_V1`
- `EXPO_PUBLIC_DRESSING_ROOM_DEDUPE_V1`
- `EXPO_PUBLIC_SAVED_SCAN_CLOUD_IMAGES_V1`

Every flag resolves via `process.env.X === 'true'`, so a missing, empty, or
malformed environment value always evaluates to `false` — fail-safe by
construction, no separate "malformed value" branch to get wrong.

## Verdict for this section

Canonical contract: one write boundary, no bypass, provenance now truthful
for the one adapter that was found to misreport it. **Confirmed.**
