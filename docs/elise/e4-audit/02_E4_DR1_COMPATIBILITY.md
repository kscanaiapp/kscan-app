# E-4 ↔ DR-1 Contract Compatibility

## The branch relationship

DR-1 (`feature/dressingrooms-canonical-item-contract-v1`, accepted HEAD
`955c58b`) branched from `integration/ios-v16-qa` @ `f73d4147`. E-4
(`feature/elise-e4-closet-aware-styling`) branched through a different
lineage that also starts at `f73d4147` but diverges immediately:
`f73d4147 → repair/elise-backend-foundation-preupgrade → E-1 → E-2 → E-3 →
integration/elise-e1-e2-e3-complete → E-4`. The two lineages share a common
ancestor but neither was ever merged into the other. This is a real,
independently-confirmed fact (`git merge-base --is-ancestor 955c58b... HEAD`
fails because `955c58b` is not even a known object in this repository), not
an assumption.

## Does this mean E-4 is unsafe today?

No, for a narrow but important reason: **every DR-1 canonical-contract flag
defaults OFF in production**, and DR-1 only ever writes its canonical
extension into `snapshot_payload.canonical` — an additive, optional
sub-object inside the same `dressing_room_items` row shape E-4 already
queries. No row in production today has `snapshot_payload.canonical`
populated. So there is no live data DR-1 vs. E-4 could currently disagree
about.

## Does this mean E-4 was fine to leave as-is?

No — this audit found and repaired one real, concrete instance of exactly
the failure mode Phase 2 warned about: E-4's own base-column read of
`dressing_room_items.source_type` was present in the query but silently
discarded, causing every room item — including ones DR-1 would classify as
`catalog_product` (discovered/saved, not owned) — to be labeled `'owned'`.
This is "independent E-4 reinterpretation of DR-1 source kinds" in the
specific, harmful direction Phase 2 called out: **`catalog_product`
mislabeled as owned.** See finding F-1 in
`01_E4_HOSTILE_AUDIT_OVERVIEW_AND_FINDINGS.md`.

## What the repair actually does

`eliseWardrobeRetrieval.ts::roomItemRelationship()` now checks, in order:

1. `snapshot_payload.canonical.source.kind` (DR-1's canonical field) — this
   is inert today (no row has it) but means E-4 will interpret it correctly
   the moment `DRESSING_ROOM_CANONICAL_ITEM_V1` is enabled, with no further
   E-4 change required.
2. `source_type` (the legacy/base column every row already has) — this is
   what makes the fix effective today, not just forward-looking.

`'product_match'` / `'catalog_product'` → `sourceType: 'saved_product'`,
`actorRelationship: 'saved'`. Everything else keeps the original `'owned'`
classification, so the fix is strictly narrowing (it can only make E-4 *more*
conservative about ownership claims, never less) and cannot regress a
genuinely owned item into looking merely "saved."

## Required-rule compliance re-check (Phase 2's explicit list)

| Check | Result |
| ----- | ------ |
| Duplicate item/purchase-option/provenance types | E-4 defines its own `EliseWardrobeCandidate`/`EliseWardrobeSourceType`/`EliseActorRelationship` types, which is expected and correct — these are advice-scoring-internal types, not a competing persistence contract. They do not redefine `CanonicalDressingRoomItem` or `CanonicalPurchaseOption`; E-4 never writes to `dressing_room_items`. |
| `catalog_product` mislabeled as owned | **Was true (F-1); repaired.** |
| `scanner_single` mislabeled as discovered | Not found — `roomItemRelationship()`'s default path keeps scan-originated items `'owned'`, and Saved Scans/Closet retrieval independently and unconditionally sets `actorRelationship: 'owned'`/`'scanned'` for their respective sources. |
| Saved scans mislabeled as purchased | Not found — Saved Scan retrieval sets `actorRelationship: 'owned'` (this codebase's existing model: a saved scan represents the user's own scanned garment, matching DR-1's `saved_scan` provenance, which is also not a commerce/purchase claim). |
| Shared items mislabeled as owned | Not found — `listSharedRoomItems` always assigns `actorRelationship: 'shared'`, never `'owned'`; language for `'shared'` is "In the shared room..." (verified in `eliseFashionFeatures.ts::ownershipLanguageLabel` and locked in by an existing passing test). |
| Commerce options read directly from raw snapshot payload | Not found — E-4 never reads `purchaseOptions`/commerce fields from `snapshot_payload` at all; its own purchase-advice logic (`eliseWardrobeGap.ts`) operates on the normalized `EliseWardrobeCandidate`, and telemetry explicitly excludes `itemName`/`imageUrl` (verified by an existing passing test). |
| Raw storage path entering model text | Not found — `normalizeWardrobeCandidate` never reads `storage_bucket`/`storage_path` into any candidate field that reaches the prompt builder. |
| E-4 bypassing DR-1 adapters or evidence sanitizers | E-4 does not write `dressing_room_items` at all (read-only for advice), so there is no write-path bypass to find. Its read path is a separate, appropriately-scoped query set (bounded columns, actor-scoped), not a reimplementation of DR-1's write-side normalization. |

## Recommendation for whoever integrates E-4 forward

When DR-1's flags are enabled, re-run the Deno test added by this audit
(`E-4 room items saved from a catalog match are "saved", not "owned"`) with
a fixture row carrying a real `snapshot_payload.canonical.source.kind` to
confirm the canonical path (already covered) continues to hold once live
data exists. No further code change is anticipated to be required for that
transition based on this audit's review, but it was not observed against a
real DRESSING_ROOM_CANONICAL_ITEM_V1-enabled row in this sandbox (no such
row exists in production), so this remains a NEXT-BUILD/FLAG-ACTIVATION GATE
rather than PRODUCTION VERIFIED.
