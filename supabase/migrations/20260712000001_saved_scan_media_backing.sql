-- Phase 2 (StyleChat Closet Intelligence): additive remote media backing for
-- saved scans, plus additive styling metadata for inspiration items.
--
-- MIGRATION SOURCE ONLY — not applied to any remote environment in this build.
--
-- Context: saved_scans currently stores device-local image_uri/thumbnail_uri
-- only ("Raw scan images are NOT uploaded to cloud storage in this sprint" —
-- 20260617215307_create_saved_scans.sql). Cross-device styling (StyleChat
-- attachments, remotely rendered Looks, Dressing Room sharing, multimodal
-- inspection) needs a private, user-scoped remote copy. This migration is
-- purely additive; no existing column changes, no backfill, no bulk upload.
--
-- Storage reuses the existing PRIVATE style-library-images bucket
-- (202605200002_style_library_images_storage.sql), whose object policies
-- already enforce (storage.foldername(name))[1] = auth.uid()::text. The
-- saved-scan media path convention is:
--   {userId}/saved-scans/{savedScanId}.jpg
-- which satisfies the existing first-folder ownership policy without any
-- storage-policy change. No public bucket is created; display always resolves
-- short-lived signed URLs.

-- ── saved_scans: media backing columns ────────────────────────────────────────

alter table public.saved_scans
  add column if not exists storage_bucket text
    check (storage_bucket is null or storage_bucket = 'style-library-images'),
  add column if not exists storage_path text
    check (storage_path is null or length(btrim(storage_path)) between 1 and 300),
  add column if not exists media_status text
    check (media_status is null or media_status in ('pending', 'ready', 'failed')),
  add column if not exists media_uploaded_at timestamptz;

comment on column public.saved_scans.media_status is
  'Remote media backing state: NULL = never requested (local-only legacy), pending = row reserved / upload in progress or retryable, ready = private object verified at storage_bucket/storage_path, failed = permanently rejected. Lazy: set only when a cross-device styling action requires remote media.';

-- Media fields move together: a ready row must carry a full storage reference.
alter table public.saved_scans
  drop constraint if exists saved_scans_media_ready_requires_path;
alter table public.saved_scans
  add constraint saved_scans_media_ready_requires_path check (
    media_status is distinct from 'ready'
    or (storage_bucket is not null and storage_path is not null)
  );

create index if not exists saved_scans_user_media_status_idx
  on public.saved_scans (user_id, media_status)
  where media_status is not null;

-- No RLS changes: existing owner-scoped select/insert/update policies already
-- govern these columns, and clients may only update their own rows.

-- ── inspiration_items: additive styling metadata (AI eligibility, Part 16) ────
-- Inspiration uploads currently carry no garment metadata, which keeps them
-- out of the AI candidate pool. These nullable bounded fields make explicit
-- enrichment possible (manual or future "Analyze for styling" — P2). Rows
-- remain ineligible until category and at least one attribute are present.

alter table public.inspiration_items
  add column if not exists category text
    check (category is null or length(btrim(category)) between 1 and 60),
  add column if not exists color text
    check (color is null or length(btrim(color)) between 1 and 40),
  add column if not exists pattern text
    check (pattern is null or length(btrim(pattern)) between 1 and 40),
  add column if not exists material text
    check (material is null or length(btrim(material)) between 1 and 40),
  add column if not exists silhouette text
    check (silhouette is null or length(btrim(silhouette)) between 1 and 40),
  add column if not exists garment_role text
    check (
      garment_role is null
      or garment_role in ('top', 'bottom', 'dress', 'jumpsuit', 'outerwear', 'shoes', 'accessory', 'bag', 'other')
    );

comment on column public.inspiration_items.garment_role is
  'Optional explicit role override used when category-based inference returns other. Never model-invented; set only by explicit user/enrichment flows.';
