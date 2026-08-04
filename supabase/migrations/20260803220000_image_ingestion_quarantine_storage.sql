-- Secure Image Ingestion Gate — Phase 4/8: quarantine storage.
--
-- Uploaded bytes land here first, under the uploading user's own path
-- prefix, and are NOT usable by the app until the scan worker (service_role)
-- promotes them to the clean bucket (see 20260803220100) and writes a CLEAN
-- verdict row (see 20260803220200). No client policy allows SELECT, UPDATE,
-- or DELETE on this bucket -- only INSERT under the caller's own auth.uid()
-- prefix. This closes the "direct-to-storage upload with no interposed scan
-- step" gap documented in docs/security/secure-image-ingestion-inventory.md.
--
-- This bucket is NEW and additive. It does not replace or alter
-- style-library-images; wiring existing client upload call sites
-- (services/styleObjects.ts) to use this bucket instead is a client-visible
-- contract change and is deliberately NOT done by this migration or by any
-- other change in this branch -- see docs/security/secure-image-ingestion-architecture.md
-- "What this branch does NOT do".

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'image-ingestion-quarantine',
  'image-ingestion-quarantine',
  false,
  10485760, -- must match security/uploads/image-ingestion-policy.json requestLimits.preBufferStreamingCapBytes
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Clients may upload (insert) under their own auth.uid() path prefix only.
drop policy if exists "Users can upload own quarantine images" on storage.objects;
create policy "Users can upload own quarantine images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'image-ingestion-quarantine'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- No select/update/delete policy for `authenticated` or `anon` is created,
-- anywhere in this migration, deliberately. Quarantine objects are readable
-- and deletable ONLY by service_role (which bypasses RLS entirely) --
-- specifically the scan worker in security/scan-worker/. This is the
-- technical enforcement behind "object cannot be read by normal clients."

-- Guardrail comment for security/scripts/rls-storage-guard.js and
-- __tests__/security/rlsStorageGuard.test.js: this bucket must NEVER be
-- added to PUBLIC_BUCKET_ALLOWLIST.
