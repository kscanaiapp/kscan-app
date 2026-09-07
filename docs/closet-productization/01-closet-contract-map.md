# Phase A — Closet Contract Map (sections 18, 39)

Everything below was read out of source at `219f27aa`. No field name in this document was
assumed from the program brief.

## 1. Two different things are called "closet". Do not conflate them.

| | **The Closet** (this lane) | `OwnedClosetItem` (not this lane) |
| --- | --- | --- |
| Authority | `services/closetLibrary.js` | `types/ownedClosetItem.ts` |
| Storage | device-local `kscan_closet/kscan_closet.json` | read-projection over `saved_scans` + `inspiration_items` |
| Meaning | **owned inventory** | "styleable item" for the Look builder / AI Stylist |
| Cloud | `public.user_closet_items` (K+) | `saved_scans` (free) |

`services/closetItemProjection.ts` says this explicitly. `OwnedClosetItem` normalizes *saved
scans*, so it is **not** an ownership claim and this lane does not treat it as one.

## 2. Local Closet record (write model) — `buildClosetRecord`, schema v2

Persisted by an **explicit allowlist**; an unknown draft key is dropped rather than carried.

| Field | Type | Bound | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | number | — | 2; max supported 2 |
| `id` | string | — | `closet_<t36>_<n36>_<r36>`, or caller-supplied |
| `ownerId` | string \| null | — | actor partition; iOS allows null (device-local), Android rejects it |
| `sourceCandidateId` | string \| null | 120 | internal provenance; idempotency key |
| `imageUri` / `thumbnailUri` | string \| null | — | Closet-owned media paths |
| `title` | string | 200 | display label; defaults to the literal "Closet item" |
| `category` | string \| null | 80 | **taxonomy** |
| `clothingType` | string \| null | 80 | **taxonomy** |
| `subtype` | string \| null | 80 | **taxonomy** |
| `brand` | string \| null | 120 | **taxonomy** |
| `primaryColor` | string \| null | 60 | **taxonomy** |
| `secondaryColors` | string[] | 60 x 8 | **taxonomy** |
| `material` | string[] | 60 x 8 | **taxonomy** |
| `size` | string \| null | 40 | **taxonomy** |
| `notes` | string \| null | 500 | |
| `origin` | direct_intake \| recent_scan | — | |
| `sourceLocalScanId` / `sourceSavedScanId` / `sourceLineageId` / `clientRequestId` | string \| null | — | internal only |
| `createdAt` / `updatedAt` | ISO string | — | **Closet creation time, NOT purchase date** |

`CLOSET_ITEM_TAXONOMY_FIELDS` names the 8 taxonomy fields once; the builder, the repair path,
promotion read-back and the projection all consume that one list.

## 3. Read model (what a screen may render) — `ClosetItemProjection`

`services/closetItemProjection.ts`. The 8 taxonomy fields + `id`, `title`, `notes`, `origin`,
`imageUri`, `thumbnailUri`, `createdAt`, `updatedAt`, plus two derived fields:
`displaySummary` (category, type, subtype, colour — de-duplicated) and `taxonomyUnknown`.

Provenance (`sourceCandidateId`, lineage ids, `clientRequestId`) is **omitted by construction**.
`hooks/useCloset.js` is the UI boundary and always projects. **This lane renders projections only.**

## 4. Ownership creation — already a single seam (section 41)

`createClosetItem` (`services/closetLibrary.js:892`) is the **only** function that commits an owned
Closet item. Exactly three call sites reach it:

| # | Entry point | User action | Creation function | Media | Sync side effect | Idempotency key |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `hooks/useCloset.js:184` `addFromUri` via `ClosetIntakeModal` | **Add Item** (camera / library) | `createClosetItem` | fresh random asset id | `noteClosetItemSaved` | none (fresh media each time) |
| 2 | `services/closetPromotion.js:143` via `useCloset.addFromScan` | **Add to Closet** on a Recent Scan | `createClosetItem` | fresh random asset id | `noteClosetItemSaved` | `sourceLineageId` |
| 3 | `services/closetCandidatePromotion.js:443` | **Batch review, then promote** | `createClosetItem` | stable, identity-derived | via commit bridge | `sourceCandidateId` |

Non-ownership writers of the manifest: `updateClosetItem`, `repairClosetItemTaxonomy`,
`deleteClosetItem`, `materializeRestoredClosetItem`, `applyRestoredClosetItemFacts`,
`applyRestoredClosetItemMedia`, `purgeLocalClosetForOwner`. None of them create ownership.

**Nothing else writes `kscan_closet.json`.** The candidate store (`kscan_closet_candidates/`) and
the sync sidecar (`kscan_closet_sync.json`) are separate files.

### Consequence for PR A2

Section 41's `addOwnedItem(...)` **already exists** — it is `createClosetItem`. The three paths are
not merely "materially equivalent"; they are literally the same function. Building a second
wrapper would add a layer without centralizing anything that is not already central.
See Decision Memo DM-01.

## 5. Idempotency, as it already stands (section 43)

`createClosetItem` checks provenance **and** lineage twice: once before any media work (so a double
tap cannot even spend an image write) and again inside the serialized mutation queue (so two
in-flight attempts cannot both commit). All mutations run through `enqueueClosetMutation`, a single
promise chain. `useCloset` adds a `busy` single-flight guard on top.

Two genuinely identical garments added by two separate user actions **do** produce two items —
correct per section 43.

## 6. Edit surface — the real gap

- Store: `updateClosetItem` accepts **`title`, `category`, `notes` only.**
- UI: `ClosetItemEditModal` exposes **Name + Category only.**
- `repairClosetItemTaxonomy` can fill the other 6 taxonomy fields but **only when absent** — it is
  a backfill, explicitly documented as "DELIBERATELY NOT A GENERAL UPDATE".

So today a user **cannot correct** a wrong `brand`, `primaryColor`, `size`, `clothingType`,
`subtype`, `secondaryColors` or `material`. That is PR A2's correction-authority work.

## 7. Cloud contract — `public.user_closet_items`

Migrations `20260829203657` (facts), `20260829204635` (RLS initplan), `20260829220316` (media).
Columns mirror the local taxonomy field-for-field in snake_case, plus `client_id` (the local id,
reused as the sync idempotency key), `schema_version`, `row_version`, `created_at`, `updated_at`,
`deleted_at`, and the B1C media columns.

- **K+ gated at the RLS layer**: every policy requires `public.has_active_k_plus()`.
- No DELETE policy — deletion is soft-delete only.
- `user_id`, `client_id`, `created_at`, `row_version` are re-stamped by triggers, so a client
  cannot forge them.
- Media paths are structurally pinned to `{user_id}/closet/{id}-primary.jpg` (flat, deliberately —
  a nested layout would orphan media on account deletion because Storage list() is non-recursive).

## 8. Sync / restore state vocabulary (internal — never render these)

- `ClosetSyncState`: `local_only` (derived, never stored), `pending`, `synced`, `blocked`, `error`, `pending_delete`
- `ClosetSyncMediaState`: `none`, `pending`, `ready`, `blocked`
- `ClosetSyncFailureClass`: `retryable`, `permanent`, `conflict`, `unexpected_authorization`
- `conflictKind`: `remote_newer_local_dirty`, `remote_tombstone_local_dirty`

## 9. K+ entitlement — three-state mapping (sections 12, 66)

`KPlusResolvedState` = `loading` | `eligible` | `active` | `expired` | `unavailable` | `error`.

| Program state | `KPlusResolvedState` |
| --- | --- |
| RESOLVING | `loading` |
| ACTIVE | `active` |
| INACTIVE | `eligible`, `expired`, `unavailable`, `error` |

`components/kplus/KPlusGate.tsx` is the one shared gate; `KPlusEarlyAccessSheet` is the one shared
availability surface. `closet_intelligence` is **already** a member of `KPLUS_SOURCES`
(`types/kplusSource.ts`) — this lane consumes that value and adds no new source.

## 10. Current Closet UI — what actually ships

`app/library.tsx`, `section === 'closet'` (all four EAS profiles set every Closet flag to "true").

Present: section tabs, Add Item, mirror-selfie entry, candidate status panel, a load-error card
that refuses to claim emptiness, an empty state, a 2-up grid, per-card edit/delete/outfit actions.

**Absent: inventory summary, search, filter, sort, sync visibility, restore visibility.**

`closetPairs` is a hand-rolled 2-column reduce that maps **every** item into a plain View inside
the screen's ScrollView — no windowing, no cap.

## 11. Dark code found

`components/free-tier/ClosetFilterBar.tsx`, `components/free-tier/EmptyClosetUtilityState.tsx`,
`hooks/useClosetFilters.ts` and `services/free-tier/closetFilters.ts` exist but are **imported by
nothing** (verified by exhaustive grep over `app/`, `components/`, `hooks/`, `services/`,
`__tests__/`). They operate on `NormalizedItem` from the free-tier wardrobe-utility types, not on
`ClosetItemProjection`, so they are not a usable base for this lane. Recorded as a finding; not
deleted (out of scope, and deletion is not this lane's call).
