-- Build 34 / Track B / Phase B1C -- Cloud Closet media contract.
--
-- Additive cloud-media backing for public.user_closet_items (B1A facts
-- contract, 20260829203657). Deliberately mirrors the proven saved-scan media
-- model (20260712000001_saved_scan_media_backing.sql) rather than inventing a
-- second media architecture: same column names, same status vocabulary, same
-- bucket, same "ready requires a full storage reference" invariant.
--
-- Storage reuses the existing PRIVATE style-library-images bucket, whose
-- object policies already enforce
--   (storage.foldername(name))[1] = auth.uid()::text
-- for select/insert/update/delete (202605200002_style_library_images_storage.sql,
-- re-confirmed live on staging during B1C). The Closet path convention below
-- puts the owner uuid in the first folder segment, so NO storage-policy change
-- is required.
--
-- PATH SHAPE -- FLAT, ONE LEVEL UNDER {userId}/closet, DELIBERATELY:
--   {userId}/closet/{closetItemId}-primary.jpg
--   {userId}/closet/{closetItemId}-thumb.jpg
-- Supabase Storage list() (storage.search) is NOT recursive. Proven on staging
-- during B1C: listing a prefix containing a sub-folder returns one pseudo-entry
-- per sub-folder with metadata IS NULL -- not the objects inside it. The
-- account-deletion enumerator (lib/account-deletion/processorCore.mjs
-- listStoragePrefix / process-account-deletions listPrefixPaths) does not filter
-- on metadata, so a NESTED layout ({userId}/closet/{id}/primary.jpg) would make
-- it build a folder path, delete nothing, and PERMANENTLY ORPHAN Closet media on
-- account deletion. A flat layout keeps every object directly enumerable by the
-- existing, already-proven deletion code with zero changes to it.
--
-- K+ AUTHORIZATION: intentionally NOT re-implemented here. These columns live on
-- user_closet_items, whose B1A UPDATE/INSERT policies already require
--   user_id = (select auth.uid()) AND (select public.has_active_k_plus())
-- so a non-K+ or expired-K+ caller cannot reserve, commit, or mutate media
-- state at all. The Storage policy stays a pure owner/path boundary (no K+
-- predicate), matching the existing separation of concerns in this project.

alter table public.user_closet_items
  add column if not exists storage_bucket text
    check (storage_bucket is null or storage_bucket = 'style-library-images'),
  add column if not exists storage_path text
    check (storage_path is null or length(btrim(storage_path)) between 1 and 300),
  add column if not exists thumbnail_storage_path text
    check (thumbnail_storage_path is null or length(btrim(thumbnail_storage_path)) between 1 and 300),
  add column if not exists media_status text
    check (media_status is null or media_status in ('pending', 'ready', 'failed')),
  add column if not exists media_uploaded_at timestamptz;

comment on column public.user_closet_items.media_status is
  'Cloud media backing state: NULL = no cloud media expected (facts-only row, the B1A default), pending = row reserved / upload in progress or retryable, ready = private object verified at storage_bucket/storage_path, failed = attempt rejected and retryable. Same vocabulary as saved_scans.media_status.';
comment on column public.user_closet_items.storage_path is
  'Deterministic primary object path, structurally pinned by user_closet_items_media_primary_path_derived to {user_id}/closet/{id}-primary.jpg. Never client-chosen.';
comment on column public.user_closet_items.thumbnail_storage_path is
  'Deterministic thumbnail object path, structurally pinned to {user_id}/closet/{id}-thumb.jpg. Nullable even when ready: a thumbnail is a convenience derivative and its failure must not invalidate a committed primary image (same rule the local Closet store applies).';
comment on column public.user_closet_items.media_uploaded_at is
  'Set when media_status reaches ready. Named to match saved_scans.media_uploaded_at rather than the media_updated_at spelling, so both media-backed tables in this project use one convention.';

-- PATH FORGERY IS STRUCTURALLY IMPOSSIBLE, not merely discouraged.
--
-- Both paths are pinned to an expression over this row's OWN server-controlled
-- identity columns: user_id (re-stamped from auth.uid() by
-- set_user_closet_items_insert_authority / _update_authority) and id (the
-- gen_random_uuid() primary key). A client that submits another user's path, a
-- foreign item id, a traversal segment (`..`), a double slash, an absolute-like
-- path, or any other arbitrary string cannot satisfy these constraints, so the
-- write is rejected by Postgres before RLS or any application code is trusted.
-- This is strictly stronger than the saved-scan precedent, which only bounds
-- path length; it is the Section 13 "derive, never sanitize" requirement
-- enforced at the storage layer of last resort.
alter table public.user_closet_items
  drop constraint if exists user_closet_items_media_primary_path_derived;
alter table public.user_closet_items
  add constraint user_closet_items_media_primary_path_derived check (
    storage_path is null
    or storage_path = user_id::text || '/closet/' || id::text || '-primary.jpg'
  );

alter table public.user_closet_items
  drop constraint if exists user_closet_items_media_thumb_path_derived;
alter table public.user_closet_items
  add constraint user_closet_items_media_thumb_path_derived check (
    thumbnail_storage_path is null
    or thumbnail_storage_path = user_id::text || '/closet/' || id::text || '-thumb.jpg'
  );

-- Media fields move together: a ready row must carry a full storage reference.
-- Mirrors saved_scans_media_ready_requires_path exactly.
alter table public.user_closet_items
  drop constraint if exists user_closet_items_media_ready_requires_path;
alter table public.user_closet_items
  add constraint user_closet_items_media_ready_requires_path check (
    media_status is distinct from 'ready'
    or (storage_bucket is not null and storage_path is not null)
  );

-- A thumbnail without a primary is not a coherent media state. Deliberately
-- one-directional: a primary WITHOUT a thumbnail stays legal, because thumbnail
-- generation is allowed to fail without failing the item.
alter table public.user_closet_items
  drop constraint if exists user_closet_items_media_thumb_requires_primary;
alter table public.user_closet_items
  add constraint user_closet_items_media_thumb_requires_primary check (
    thumbnail_storage_path is null or storage_path is not null
  );

-- Mirrors saved_scans_user_media_status_idx: the reconciliation/retry access
-- path is "this user's rows that are in a non-terminal media state".
create index if not exists user_closet_items_user_media_status_idx
  on public.user_closet_items (user_id, media_status)
  where media_status is not null;

-- No RLS change: the B1A owner + active-K+ policies already govern every column
-- on this table, including these. No new grants: the existing
-- select/insert/update grants to authenticated already cover new columns.
