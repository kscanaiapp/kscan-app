# Build 34 / Track B / Phase B1C — Cloud Closet Media + Storage Contract: Ledger

Status: **CONTRACT FROZEN — APPLIED AND HOSTILE-VALIDATED ON STAGING**
Phase: B1C (media schema + storage contract + deletion integration)
Production: **NOT TOUCHED**

Predecessors: [B1A facts contract](./build34-trackb-closet-facts-ledger.md) · [B1B deletion authority repair](./build34-trackb-b1b-deletion-repair-ledger.md)

## Source authority

| | |
|---|---|
| Base branch | `repair/backend-build34-closet-deletion-v1` (B1B) |
| Base SHA | `26af57b46872a3deccee69b8b8840decea36f52d` |
| Feature branch | `feature/backend-build34-closet-media-v1` |
| Staging project | `yzqjvdfgefveprobvvyw` |

No newer cumulative backend authority contained B1A or B1B at B1C start (checked by `merge-base --is-ancestor` against every `*backend*` / `*track-b*` remote branch; the two branches that moved during the session carry only an unrelated ZAP security fix). B1B PR #212 remained OPEN and unmerged throughout, so the default parent was used exactly.

## Media reuse map

| Concern | Existing implementation | B1C |
|---|---|---|
| Saved-media saga shape | `services/savedScanMedia.ts#ensureSavedScanMediaBacking` | **REUSE** (as the B2 blueprint; not re-implemented in B1C) |
| Path builder | `savedScanMedia.ts#buildSavedScanMediaPath` | **EXTEND** → `services/closetMedia.ts#buildClosetMediaPaths` (same shape, adds a thumbnail) |
| DB media columns | `20260712000001_saved_scan_media_backing.sql` on `saved_scans` | **EXTEND** — identical column names/status vocabulary on `user_closet_items` |
| Storage bucket + owner policy | `202605200002_style_library_images_storage.sql` | **REUSE UNCHANGED** (no new bucket, no new policy) |
| Image normalization | `ImageManipulator` re-encode (1440w primary) | **REUSE** |
| Thumbnail sizing | `closetLibrary.js` `THUMB_WIDTH = 160` | **REUSE** |
| Metadata/EXIF stripping | `privacyImageUpload.ts` re-encode | **REUSE** |
| Face/plate PII masking | `privacyImageSanitizer.js` | **NOT IMPLEMENTED UPSTREAM** — see Privacy contract |
| Signed URL | `createSignedUrl(path, 60)` | **REUSE** (60s) |
| Deletion enumeration | B1B `deleteOwnedStorageObjects` / `deleteOwnedStorage` | **REUSE UNCHANGED** (flat path chosen so no change was needed) |

## Data model decision — ADDITIVE COLUMNS

Additive columns on `public.user_closet_items`, not a `user_closet_item_media` child table.

Reason: the V1 requirement is exactly one primary image and one thumbnail per item, and the proven saved-scan media model in this repo already expresses that as columns on the parent row. A child table would add a join, a second RLS surface, a second K+ enforcement point and a second deletion path for no additional expressiveness at V1.

```
storage_bucket          text        CHECK (null or = 'style-library-images')
storage_path            text        CHECK (null or length(btrim(...)) between 1 and 300)
thumbnail_storage_path  text        CHECK (null or length(btrim(...)) between 1 and 300)
media_status            text        CHECK (null or in ('pending','ready','failed'))
media_uploaded_at       timestamptz
```

`media_uploaded_at` (not `media_updated_at`) is deliberate: it is the name already used by `saved_scans`, and both media-backed tables now share one convention.

Constraints (all verified live):

| Constraint | Definition |
|---|---|
| `user_closet_items_media_primary_path_derived` | `storage_path IS NULL OR storage_path = user_id::text \|\| '/closet/' \|\| id::text \|\| '-primary.jpg'` |
| `user_closet_items_media_thumb_path_derived` | `thumbnail_storage_path IS NULL OR thumbnail_storage_path = user_id::text \|\| '/closet/' \|\| id::text \|\| '-thumb.jpg'` |
| `user_closet_items_media_ready_requires_path` | `media_status IS DISTINCT FROM 'ready' OR (storage_bucket IS NOT NULL AND storage_path IS NOT NULL)` |
| `user_closet_items_media_thumb_requires_primary` | `thumbnail_storage_path IS NULL OR storage_path IS NOT NULL` |
| `user_closet_items_media_status_check` | `media_status IS NULL OR media_status IN ('pending','ready','failed')` |

Index: `user_closet_items_user_media_status_idx (user_id, media_status) WHERE media_status IS NOT NULL` — mirrors `saved_scans_user_media_status_idx`.

### The path constraints are the security control, not documentation

Both paths are pinned to an expression over the row's **own server-controlled identity columns** — `user_id` (re-stamped from `auth.uid()` by the B1A insert/update triggers) and `id` (the `gen_random_uuid()` PK). A client therefore cannot point a Closet row at another account, a foreign item id, or a traversal path: the write is rejected by Postgres before RLS or any application code is trusted. This is strictly stronger than the saved-scan precedent, which only bounds path length.

## Storage contract

```
bucket:                 style-library-images   (PRIVATE, verified live)
file_size_limit:        5242880 bytes (5 MB)   (bucket config, verified live)
allowed_mime_types:     image/jpeg, image/png, image/webp  (bucket config, verified live)
contract content type:  image/jpeg  (narrower than the bucket, matching savedScanMedia)
owner namespace:        {userId}                (first path segment)
item namespace:         {closetItemId}          (encoded in the FILENAME, not a folder)
primary path:           {userId}/closet/{closetItemId}-primary.jpg
thumbnail path:         {userId}/closet/{closetItemId}-thumb.jpg
canonical DB identity:  storage_bucket + storage_path   (never a signed URL)
primary dimensions:     1440w   (closetLibrary IMAGE_WIDTH; also the saved-scan cloud primary)
thumbnail dimensions:   160w    (closetLibrary THUMB_WIDTH)
signed URL TTL:         60s     (savedScanMedia createSignedUrl(path, 60))
```

### Storage policy migration required: **NO**

The four existing `style-library-images` policies (select/insert/update/delete) each gate on
`bucket_id = 'style-library-images' AND (storage.foldername(name))[1] = auth.uid()::text`
— confirmed live on staging. Because the owner uuid is the first path segment, `{userId}/closet/...` is already covered. Adding a Closet-specific policy would have been redundant surface area.

### Why the path is FLAT — proven, not assumed

Supabase Storage `list()` (backed by `storage.search`) is **not recursive**. Probed directly on staging with synthetic metadata rows:

| Prefix probed | Returned | `metadata IS NOT NULL` (a real, deletable object) |
|---|---|---|
| `b1cprobe/closet/` (flat) | `item1-primary.jpg`, `item1-thumb.jpg` | **true, true** |
| `b1cprobe/nested/` (nested) | `item1` (one folder pseudo-entry) | **false** |

The account-deletion enumerators (`processorCore.mjs#listStoragePrefix`, `process-account-deletions#listPrefixPaths`) push `` `${prefix}/${item.name}` `` for every entry **without filtering on `metadata`**. With a nested layout they would therefore build a *folder* path, delete nothing, and **permanently orphan every Closet image on account deletion**. The flat layout keeps both objects directly enumerable by the already-proven B1B deletion code with zero changes to it. `__tests__/closetCloudMediaContract.test.js` carries a regression guard so nobody "tidies" this into a nested layout later.

## Upload contract (row-first)

```
1. UPSERT FACTS   client → user_closet_items (user_id, client_id, ...)   [B1A; K+ required]
2. SERVER ID      ← user_closet_items.id  (gen_random_uuid, server-issued)
3. RESERVE        UPDATE media_status='pending', storage_bucket, storage_path
                  (+ thumbnail_storage_path) using buildClosetMediaPaths()
4. LOCAL SANITIZE prepareImageForPrivacyUpload() → EXIF/metadata-stripped JPEG
5. PRIMARY UPLOAD supabase.storage.from('style-library-images')
                    .upload(primaryPath, body, {contentType:'image/jpeg', upsert:false})
6. THUMB UPLOAD   same, thumbnailPath   (failure here is NON-fatal)
7. READY COMMIT   UPDATE media_status='ready', media_uploaded_at=now()
```

Failure handling mirrors the saved-scan saga exactly:
* upload ok + commit fails → retry the **commit only**; never re-upload (the path is deterministic, so the object is already correct).
* reserve ok + upload fails → row stays `pending`/`failed` and retryable; **Closet facts survive**.
* retry can never create a second object, because the path is a pure function of `(user_id, id)`.

## Media states

| State | Meaning |
|---|---|
| `NULL` | No cloud media expected. The B1A default; every pre-B1C row is valid and unchanged. |
| `pending` | Path reserved, upload in flight or retryable. |
| `ready` | Object committed; row carries a full storage reference (constraint-enforced). |
| `failed` | Attempt rejected; retryable. |

**`ready` but object missing** — verified live: the facts row survives fully intact, and the owner may demote `ready → pending` to make it retryable. The deterministic path is retained across the demotion, so the retry re-uploads to the *same* object rather than creating an orphan. Media is treated as unavailable; Closet facts are never discarded.

## Authorization

```
K+ enforcement point:      B1A RLS on user_closet_items (INSERT/UPDATE both require
                           user_id = (select auth.uid()) AND (select has_active_k_plus()))
Storage ownership:         existing style-library-images policies, first-path-segment = auth.uid()
K+ in a Storage policy:    deliberately NOT added (no precedent; product/API layer owns K+)
```

This is the Section 19 separation of concerns: the **row** is the sole authority for what counts as Closet media, and the row is K+-gated; the **Storage policy** stays a pure owner/path boundary.

A non-K+ user cannot create a `user_closet_items` row at all, so they never obtain a server item id and therefore have no derivable Closet media path. Residual, honestly stated: a non-K+ authenticated user could still `PUT` bytes under their *own* `{userId}/closet/...` prefix, exactly as they already can under the pre-existing `scans`/`inspirations`/`saved-scans` prefixes — that is pre-existing bucket behaviour, not introduced by B1C. Such objects reference no row, are unreachable by the product, and are removed by the `{userId}/closet` account-deletion prefix.

## Privacy contract — stated honestly

```
raw original stored:              NO  (exactly two derived objects; no original/HEIC/EXIF archive)
EXIF/metadata retained:           NO  (ImageManipulator re-encode produces a fresh JPEG)
thumbnail derived post-sanitize:  YES (contract requires both derivatives from the sanitized source)
backend validation:               bucket-level MIME allowlist + 5 MB size limit (Storage service)
client face/plate PII masking:    NOT IMPLEMENTED UPSTREAM  ← see below
```

**This must not be overstated.** `services/privacyImageSanitizer.js` is currently a **passthrough**: it declares `mode: 'passthrough'`, `faceDetectionAvailable: false`, `faceBlurApplied: false`, `plateDetectionAvailable: false`, `plateMaskApplied: false`, and returns its input unchanged. `services/privacyImageUpload.ts` is equally explicit ("This does not claim face or license-plate masking") and honestly reports `metadataStripped: true` only.

So the verified privacy properties today are **metadata/EXIF stripping and bounded re-encoding**, not face or plate masking. B1C:
* requires a sanitized derivative in its documented upload contract,
* introduces **no** raw-original cloud path, and
* does **not** claim on-device masking runtime validation, because no such implementation exists to validate and B1C built no mobile code.

Closing that gap is pre-existing product work (tracked below as an out-of-scope finding), not something B1C invented or regressed.

## Soft delete vs account delete

| Lifecycle | Behaviour |
|---|---|
| **Item soft-delete** | Tombstone the row **and** release the media claim in one statement (`deleted_at = now()`, media columns cleared), then remove the two deterministic objects. Verified live. |
| **Account delete** | All Closet media purged via the `{userId}/closet` prefix, then `auth.users` delete cascades the facts rows. **No K+ requirement.** |

Rationale for prompt media release on soft-delete: B1A's tombstone exists so other devices learn the item was deleted; a syncing device renders nothing for a tombstone, so retaining media serves no convergence purpose. Retaining it would only extend privacy retention and storage cost. There is no restore-from-tombstone product feature defined that would need the bytes back.

Residual (documented for B2): item-level object removal is client-driven, so a client that dies mid-delete can leak the two objects until account deletion sweeps them. Bounded, never cross-account, and B2 must check `deleted_at` before any upload retry.

## Deletion authority integration

Both B1B registries updated with `{userId}/closet`:
* `lib/account-deletion/user-data-resources.json` (Node source of truth)
* `supabase/functions/_shared/deletion/userDataResources.ts` (Deno mirror)

B1B's `{userId}/saved-scans` repair and the pre-existing `scans`/`inspirations` prefixes are preserved (pinned by test).

## Hostile controls — all executed against live staging

| Control | Result |
|---|---|
| Legitimate owner media commit (`ready`) | **PASS** (row_version advanced 1→2) |
| Foreign-owner path | **BLOCKED** `23514 user_closet_items_media_primary_path_derived` |
| Traversal `../../` path | **BLOCKED** same constraint |
| Foreign Closet item id | **BLOCKED** same constraint |
| Double slash | **BLOCKED** same constraint |
| Absolute-like leading slash | **BLOCKED** same constraint |
| Thumbnail → another user | **BLOCKED** `user_closet_items_media_thumb_path_derived` |
| Wrong bucket | **BLOCKED** `user_closet_items_storage_bucket_check` |
| `ready` with no storage reference | **BLOCKED** `user_closet_items_media_ready_requires_path` |
| Thumbnail with no primary | **BLOCKED** `user_closet_items_media_thumb_requires_primary` |
| Cross-user media mutation (K+ A → B's row) | **BLOCKED** (0 rows) |
| Non-K+ Closet row/media creation | **BLOCKED** `42501` RLS |
| Expired-K+ media write | **BLOCKED** (0 rows) while the facts row survives |
| Account delete removes Closet media + rows | **PASS** (A: 0 media, 0 rows) |
| Cross-account isolation during delete | **PASS** (B untouched) |
| Expired-K+ account delete | **PASS** |
| No-K+ account delete | **PASS** |
| Delete retry (already purged) | **PASS** (no error, idempotent) |
| `ready` but object missing → recovery | **PASS** (facts intact, demote to `pending`, same path reused) |
| Soft-delete releases media atomically | **PASS** |

Negative controls (in-memory / rolled back only — no live policy, constraint or object was ever left weakened):
* **NC-deletion**: rebuilding enumeration without `{userId}/closet` leaves the Closet object unremoved → the coverage test fails as designed.
* **NC-nested-layout**: a nested layout run through the *real* `deleteOwnedStorageObjects` proves the objects are unreachable — this is the regression guard.
* **NC-path**: every forgery class is asserted to differ from the derived path (and each was additionally rejected by the live database, above).
* **NC-ownership / NC-K+**: exercised live via cross-user and non/expired-K+ actors rather than by weakening staging.

## Storage size evidence

**No real image bytes were produced or uploaded in B1C.** There is no client in this phase, the image pipeline runs on-device, and the staging fixtures were Storage *metadata* rows only. The figures below are therefore declared, not measured, and are labelled accordingly — B1C has no basis for a measured number.

```
PRIMARY    (fixture-declared metadata size):  40,960 bytes
THUMBNAIL  (fixture-declared metadata size):   3,072 bytes
TOTAL/ITEM (fixture-declared):                44,032 bytes
```

**ESTIMATE (projection, not a measurement)** — derived from the contract's own bounds rather than from vendor pricing: the primary is a 1440w JPEG capped at 5 MB, and the thumbnail is 160w. A typical 1440w garment JPEG occupies roughly 150–400 KB and a 160w thumbnail roughly 3–8 KB, giving a realistic per-item cloud footprint of **~155–410 KB**, with a hard per-item ceiling of ~5 MB set by the bucket's `file_size_limit`.

The first true measurement is a **B2 deliverable**: once the device pipeline encodes real sanitized derivatives, record actual primary/thumbnail byte sizes there and supersede this section.

## Migration governance

```
migration file:        supabase/migrations/20260829220316_user_closet_items_media.sql
staging ledger version: 20260829220316   (platform-assigned; local filename aligned to it, per B1A precedent)
storage policy migration: NONE REQUIRED (existing owner policy already covers the prefix)
historical migrations edited: NONE
migration manifest (config/migration-authority-manifest.json): UNCHANGED
production:            NOT APPLIED
```

The frozen 22-entry historical reconciliation manifest was left untouched, consistent with B1A and B1B (it is a historical cross-repo provenance record, not a registry of new native migrations). `__tests__/migrationAuthorityGovernance.test.js` passes unchanged.

## Staging runtime evidence

| Surface | Evidence |
|---|---|
| **Database** | Migration `20260829220316` present in `supabase_migrations.schema_migrations`; all 5 media columns and all 5 media constraints verified live via `information_schema` / `pg_constraint`. |
| **Storage policies** | Unchanged — verified live that the 4 pre-existing owner policies already cover `{userId}/closet`. |
| **Edge function** | `process-account-deletions` v52 ACTIVE. Deployed via the governed `scripts/deploy-edge-functions.js` (all 7 gates passed). Live-fetched deployed `userDataResources.ts` sha256 `aa3e99530a104104474f3f21c16d6f7756514ffe7a735526a4c402ee769079b9` **exactly matches** the committed manifest entry. |
| **Other functions** | None deployed. `process-account-deletions` is the *only* governed function bundling the changed shared module (verified from the manifest's own bundle file lists). |
| **Fixtures** | 4 synthetic users, 4 Closet rows, 4 storage objects created and **all removed** (verified: 0 users, 0 Closet rows, 0 Closet/probe objects remaining). |

Advisors after the change: no new **security** advisory for the B1C surface. One **performance** notice — `user_closet_items_user_media_status_idx` unused — which is expected and correct for a new index on an empty table that is deliberately unreachable from the product until B2.

## B2 handoff contract

```
FACTS UPSERT      upsert public.user_closet_items on (user_id, client_id)
                  -- client_id is the local closetLibrary record id (B1A)
                  -- user_id is IGNORED if sent: the server re-stamps auth.uid()
SERVER ID         read back user_closet_items.id  (the ONLY media path authority)
MEDIA START       UPDATE media_status='pending' + storage_bucket + storage_path
                  (+ thumbnail_storage_path) from buildClosetMediaPaths(userId, id)
SANITIZE          prepareImageForPrivacyUpload(localUri)  -- REQUIRED before any upload
                  (note: EXIF stripping only today; face/plate masking is unbuilt)
PRIMARY OBJECT    {userId}/closet/{id}-primary.jpg   1440w JPEG, <= 5 MB
THUMBNAIL OBJECT  {userId}/closet/{id}-thumb.jpg     160w  JPEG   (failure is non-fatal)
UPLOAD AUTHORITY  supabase.storage.from('style-library-images').upload(path, body,
                    { contentType: 'image/jpeg', upsert: false })
                  -- authorized by the existing owner Storage policy; K+ is enforced
                     by the row policies, NOT by Storage
READY COMMIT      UPDATE media_status='ready', media_uploaded_at=now()
RETRY             verify object first; if present, retry the COMMIT ONLY, never re-upload.
                  Never mint a new path -- it is a pure function of (user_id, id).
SOFT DELETE       set deleted_at AND clear all media columns in ONE update, then remove
                  both deterministic objects. Check deleted_at before any upload retry.
DISPLAY           createSignedUrl(storage_path, 60); never persist a signed URL
```

## Out-of-scope findings (documented, not fixed)

1. **Face/plate PII masking is unimplemented** (`privacyImageSanitizer.js` is a passthrough). Pre-existing and honestly self-declared; it affects every existing cloud image path (scans, inspirations, saved-scans), not just Closet. Needs a product decision + on-device implementation phase.
2. **The account-deletion storage enumerator is non-recursive and does not filter folder pseudo-entries.** Harmless for all current prefixes (all flat), but it is a latent landmine for any *future* nested prefix. B1C works within it rather than changing proven deletion code; a defensive `metadata != null` filter would be a small, separate hardening.
3. The 18 pre-existing full-suite failures inherited from the B1B baseline (unrelated: batch-review UI, wearable/provider deletion-coverage backlog, `config.toml` JWT posture, RPC grant list, deferred contributions migration).
4. `docs/account-deletion-operations.md` remains stale (2026-07-07) — it predates the automated worker, the saved-scans prefix and now the Closet prefix.

## Verdict

**TRACK B B1C CLOUD CLOSET MEDIA CONTRACT COMPLETE — READY FOR CLIENT SYNC**
